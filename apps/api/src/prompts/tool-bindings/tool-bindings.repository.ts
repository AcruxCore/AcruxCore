import prisma from '../../shared/db/client';

/** A binding row as stored, joined with the tool's current name. */
export interface BindingRow {
  id: string;
  promptAlias: string | null;
  toolId: string;
  toolName: string;
  toolDescription: string | null;
  toolAlias: string | null;
  pinnedVersionId: string | null;
  position: number;
}

/**
 * Repository for `prompt_tool_bindings` — the single source of truth for which
 * tools a prompt calls. Every query is scoped by `promptId`, which is verified
 * team-owned one layer up in {@link ToolBindingsService}.
 *
 * Soft-deleted tools are excluded everywhere: a deleted tool must stop being sent
 * to the model without anyone having to unbind it first.
 *
 * Note on upserts: `promptAlias` is nullable and Postgres does not treat NULLs as
 * equal, so the compound unique index cannot be used as a Prisma `upsert` target
 * for default rows. Hence the find-then-write in {@link set}.
 */
export class ToolBindingsRepository {
  /** Shared include/select shape so every read returns the same {@link BindingRow}. */
  private static readonly INCLUDE = {
    tool: { select: { name: true, description: true, deletedAt: true } },
  } as const;

  private static toRow(r: {
    id: string;
    promptAlias: string | null;
    toolId: string;
    toolAlias: string | null;
    pinnedVersionId: string | null;
    position: number;
    tool: { name: string; description: string | null };
  }): BindingRow {
    return {
      id: r.id,
      promptAlias: r.promptAlias,
      toolId: r.toolId,
      toolName: r.tool.name,
      toolDescription: r.tool.description,
      toolAlias: r.toolAlias,
      pinnedVersionId: r.pinnedVersionId,
      position: r.position,
    };
  }

  /**
   * Every binding for a prompt, default rows and alias rows alike.
   *
   * @param promptId - UUID of the prompt.
   * @returns Rows ordered so defaults come first, then by alias, then position.
   */
  async listByPrompt(promptId: string): Promise<BindingRow[]> {
    const rows = await prisma.promptToolBinding.findMany({
      where: { promptId, tool: { deletedAt: null } },
      include: ToolBindingsRepository.INCLUDE,
      orderBy: [{ promptAlias: 'asc' }, { position: 'asc' }],
    });
    return rows.map(ToolBindingsRepository.toRow);
  }

  /**
   * The rows needed to resolve one prompt alias: its own plus the defaults, in a
   * single query. The caller overlays them — see
   * `PromptToolResolver.resolveForAlias`.
   *
   * @param promptId - UUID of the prompt.
   * @param promptAlias - Alias being served, or null to fetch defaults only.
   */
  async listForResolution(promptId: string, promptAlias: string | null): Promise<BindingRow[]> {
    const rows = await prisma.promptToolBinding.findMany({
      where: {
        promptId,
        tool: { deletedAt: null },
        ...(promptAlias === null
          ? { promptAlias: null }
          : { OR: [{ promptAlias: null }, { promptAlias }] }),
      },
      include: ToolBindingsRepository.INCLUDE,
      orderBy: [{ position: 'asc' }],
    });
    return rows.map(ToolBindingsRepository.toRow);
  }

  /**
   * Fetches one binding, or undefined when this (alias, tool) pair has none.
   *
   * @param promptId - UUID of the prompt.
   * @param promptAlias - Alias name, or null for the default row.
   * @param toolId - UUID of the tool.
   */
  async findOne(
    promptId: string,
    promptAlias: string | null,
    toolId: string,
  ): Promise<{ id: string; toolAlias: string | null; pinnedVersionId: string | null } | undefined> {
    const row = await prisma.promptToolBinding.findFirst({
      where: { promptId, promptAlias, toolId },
      select: { id: true, toolAlias: true, pinnedVersionId: true },
    });
    return row ?? undefined;
  }

  /**
   * Creates or updates one binding.
   *
   * @param promptId - UUID of the prompt.
   * @param promptAlias - Alias name, or null to write the inherited default.
   * @param toolId - UUID of the tool.
   * @param value - The three-state cell value; both fields null means "off".
   * @param userId - UUID of the acting user, stored only on create.
   * @param position - Ordering hint, used only on create.
   * @returns The written row.
   */
  async set(
    promptId: string,
    promptAlias: string | null,
    toolId: string,
    value: { toolAlias: string | null; pinnedVersionId: string | null },
    userId: string,
    position: number,
  ): Promise<BindingRow> {
    const existing = await this.findOne(promptId, promptAlias, toolId);

    const row = existing
      ? await prisma.promptToolBinding.update({
          where: { id: existing.id },
          data: { toolAlias: value.toolAlias, pinnedVersionId: value.pinnedVersionId },
          include: ToolBindingsRepository.INCLUDE,
        })
      : await prisma.promptToolBinding.create({
          data: {
            promptId,
            promptAlias,
            toolId,
            toolAlias: value.toolAlias,
            pinnedVersionId: value.pinnedVersionId,
            position,
            createdBy: userId,
          },
          include: ToolBindingsRepository.INCLUDE,
        });

    return ToolBindingsRepository.toRow(row);
  }

  /**
   * Highest `position` currently used for one alias's list, so a new binding lands
   * at the end rather than colliding at 0.
   *
   * @param promptId - UUID of the prompt.
   * @param promptAlias - Alias name, or null for the default list.
   * @returns The next free position (0 when the list is empty).
   */
  async nextPosition(promptId: string, promptAlias: string | null): Promise<number> {
    const top = await prisma.promptToolBinding.findFirst({
      where: { promptId, promptAlias },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    return top ? top.position + 1 : 0;
  }

  /**
   * Removes one binding.
   *
   * @param promptId - UUID of the prompt.
   * @param promptAlias - Alias name, or null for the default row.
   * @param toolId - UUID of the tool.
   * @returns `true` when a row was deleted, `false` when there was nothing to remove.
   */
  async remove(promptId: string, promptAlias: string | null, toolId: string): Promise<boolean> {
    const result = await prisma.promptToolBinding.deleteMany({ where: { promptId, promptAlias, toolId } });
    return result.count > 0;
  }

  /**
   * Removes every row an alias owns, returning it to the inherited default. Backs
   * the grid's per-column reset.
   *
   * @param promptId - UUID of the prompt.
   * @param promptAlias - Alias name; never null, since the default cannot be reset.
   * @returns Number of rows removed.
   */
  async removeAllForAlias(promptId: string, promptAlias: string): Promise<number> {
    const result = await prisma.promptToolBinding.deleteMany({ where: { promptId, promptAlias } });
    return result.count;
  }
}
