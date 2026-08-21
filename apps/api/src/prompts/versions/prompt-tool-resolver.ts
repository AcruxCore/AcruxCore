import { ToolAliasesRepository } from '../../tools/aliases/aliases.repository';
import { ToolVersionsRepository } from '../../tools/versions/versions.repository';
import { ToolBindingsRepository, BindingRow } from '../tool-bindings/tool-bindings.repository';
import { ResolvedToolDefinition } from '../../tools/resolver';

/**
 * Per-tool resolution metadata returned alongside {@link ResolvedToolDefinition}s
 * by {@link PromptToolResolver.resolveForAlias} — kept separate from the
 * definition itself (never merged into it) because that definition is sometimes
 * forwarded as-is into a provider's `tools` array, which must stay exactly
 * OpenAI-shaped.
 */
export interface ToolResolutionDetail {
  /** The tool's catalog name — matches `function.name` on the paired definition. */
  name: string;
  /** The tool alias actually followed, or absent when the binding is pinned. */
  alias?: string;
  /** The pinned version number, or absent when the binding follows an alias. */
  pinnedVersionNumber?: number;
  /** The tool version number this call actually resolved to, either way. */
  versionNumber: number;
  /**
   * Which binding decided this entry: `'alias'` when the prompt alias has a row
   * of its own, `'default'` when it inherited. Replaces the `overridden` flag of
   * the superseded two-table design, where "overridden" meant a live override had
   * outranked a version's baked-in attachment — a distinction that no longer
   * exists (phase-4-faq Q53).
   */
  source: 'alias' | 'default';
}

/**
 * Resolves the tools a prompt calls, from `prompt_tool_bindings`.
 *
 * A prompt version no longer takes any part in this — it decides the template
 * only. Bindings are keyed by the prompt's own alias, with a NULL-alias default
 * row that every alias inherits unless it has a row of its own (phase-4-faq Q53
 * and `specs/phase-4/2026-08-20-prompt-tool-binding-design.md`).
 *
 * Each surviving binding resolves to a concrete `ToolVersion`: the pin if
 * present, else the named tool alias's current target. The version's
 * `parametersSchema` becomes `parameters`, and `description` prefers the
 * version's own and falls back to the tool-level one, matching the shape
 * produced by the gateway's `ToolResolver.resolveRefs`.
 *
 * A binding whose tool has been soft-deleted is excluded in the repository; one
 * whose alias or pinned version has since gone missing is skipped here
 * (best-effort), so neither ever breaks rendering.
 */
export class PromptToolResolver {
  private readonly bindings = new ToolBindingsRepository();
  private readonly aliases = new ToolAliasesRepository();
  private readonly versions = new ToolVersionsRepository();

  /**
   * Overlays a prompt alias's own bindings on top of the prompt's defaults.
   *
   * @param rows - Default rows and one alias's rows, mixed, as the repository returns them.
   * @returns One effective row per tool, with rows marked "off" dropped entirely.
   */
  private static overlay(rows: BindingRow[]): Array<{ row: BindingRow; source: 'alias' | 'default' }> {
    const effective = new Map<string, { row: BindingRow; source: 'alias' | 'default' }>();

    // Defaults first, so an alias row overwrites the entry rather than racing it.
    for (const row of rows.filter((r) => r.promptAlias === null)) {
      effective.set(row.toolId, { row, source: 'default' });
    }
    for (const row of rows.filter((r) => r.promptAlias !== null)) {
      effective.set(row.toolId, { row, source: 'alias' });
    }

    // "Off" is a row with neither an alias nor a pin. It exists only to contradict
    // a default, so it removes the entry instead of resolving to anything.
    return [...effective.values()]
      .filter(({ row }) => row.toolAlias !== null || row.pinnedVersionId !== null)
      .sort((a, b) => a.row.position - b.row.position);
  }

  /**
   * Resolves one effective binding to a tool definition, or null when the alias or
   * pinned version it names no longer exists.
   */
  private async resolveOne(
    row: BindingRow,
  ): Promise<{ def: ResolvedToolDefinition; versionNumber: number; alias?: string; pinnedVersionNumber?: number } | null> {
    if (row.pinnedVersionId) {
      const pinned = await this.versions.findById(row.pinnedVersionId);
      if (!pinned || pinned.toolId !== row.toolId) return null;
      return {
        def: this.toDef(row.toolName, row.toolDescription, pinned),
        versionNumber: pinned.versionNumber,
        pinnedVersionNumber: pinned.versionNumber,
      };
    }

    // toolAlias is non-null here: overlay() dropped rows with neither field set.
    const aliasName = row.toolAlias as string;
    const alias = await this.aliases.findByAlias(row.toolId, aliasName);
    if (!alias) return null;
    const version = await this.versions.findByVersionNumber(row.toolId, alias.versionNumber);
    if (!version) return null;
    return {
      def: this.toDef(row.toolName, row.toolDescription, version),
      versionNumber: version.versionNumber,
      alias: aliasName,
    };
  }

  /**
   * Resolves the tools to send when this prompt is served through `promptAlias`.
   *
   * Used by `PromptAliasesService.resolveAndRender`, the shared core behind both
   * the public render endpoint and the gateway's `prompt` reference (G8) — so this
   * is where binding takes effect for every real call.
   *
   * @param promptId - UUID of the prompt (the binding table's scope).
   * @param promptAlias - The prompt alias this call is being served through.
   * @returns Definitions to send to the model, and parallel per-tool metadata.
   */
  async resolveForAlias(
    promptId: string,
    promptAlias: string,
  ): Promise<{ tools: ResolvedToolDefinition[]; resolutions: ToolResolutionDetail[] }> {
    const rows = await this.bindings.listForResolution(promptId, promptAlias);

    const tools: ResolvedToolDefinition[] = [];
    const resolutions: ToolResolutionDetail[] = [];

    for (const { row, source } of PromptToolResolver.overlay(rows)) {
      const resolved = await this.resolveOne(row);
      if (!resolved) continue;
      tools.push(resolved.def);
      resolutions.push({
        name: row.toolName,
        ...(resolved.alias !== undefined ? { alias: resolved.alias } : {}),
        ...(resolved.pinnedVersionNumber !== undefined
          ? { pinnedVersionNumber: resolved.pinnedVersionNumber }
          : {}),
        versionNumber: resolved.versionNumber,
        source,
      });
    }

    return { tools, resolutions };
  }

  /**
   * Resolves the prompt's default bindings, with no alias in play.
   *
   * Backs `VersionsService.getVersionById`, which prefills the Playground from a
   * version UUID. That path has no alias to resolve through, and since tools no
   * longer belong to a version, the prompt's default is the honest answer to
   * "what tools does this prompt have" there.
   *
   * @param promptId - UUID of the prompt.
   * @returns Definitions in binding order; empty when the prompt binds no tools.
   */
  async resolveDefault(promptId: string): Promise<ResolvedToolDefinition[]> {
    const rows = await this.bindings.listForResolution(promptId, null);
    const out: ResolvedToolDefinition[] = [];
    for (const { row } of PromptToolResolver.overlay(rows)) {
      const resolved = await this.resolveOne(row);
      if (resolved) out.push(resolved.def);
    }
    return out;
  }

  /**
   * Builds an OpenAI tool def from a tool name, the tool's own description, and
   * the resolved version row. `description` prefers the version's own description
   * and falls back to the tool-level description when the version has none set —
   * matching `ToolResolver.resolveRefs`'s fallback so both resolvers produce
   * identical shapes.
   */
  private toDef(
    toolName: string,
    toolDescription: string | null,
    version: { description: string | null; parametersSchema: unknown },
  ): ResolvedToolDefinition {
    const description = version.description ?? toolDescription ?? undefined;
    return {
      type: 'function',
      function: {
        name: toolName,
        ...(description ? { description } : {}),
        parameters: (version.parametersSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
      },
    };
  }
}
