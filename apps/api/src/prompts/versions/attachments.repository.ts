import prisma from '../../shared/db/client';
import { AttachmentCreateData, AttachmentRow } from './attachments.types';

/**
 * Data-access class for the `prompt_version_tools` join table (prompt version ↔ tool
 * attachments). All queries for this table go through this class — no other file
 * imports prisma for it.
 */
export class PromptVersionToolRepository {
  /**
   * Bulk-inserts attachments for a freshly committed prompt version.
   * A no-op when `rows` is empty (a prompt version may have zero attached tools).
   *
   * @param promptVersionId - UUID of the prompt version the attachments belong to.
   * @param rows - Pre-resolved attachment rows (pin already resolved to an id, if any).
   */
  async createMany(promptVersionId: string, rows: AttachmentCreateData[]): Promise<void> {
    if (rows.length === 0) return;
    await prisma.promptVersionTool.createMany({
      data: rows.map((r) => ({
        promptVersionId,
        toolId: r.toolId,
        aliasName: r.aliasName,
        pinnedVersionId: r.pinnedVersionId,
        position: r.position,
      })),
    });
  }

  /**
   * Lists attachments for a prompt version, joined to the tool's name/description,
   * ordered by their stable `position`. Attachments whose tool has been soft-deleted
   * (`Tool.deletedAt` set) are excluded, matching `ToolResolver.resolveRefs`'s
   * behavior for `tool_refs` — a deleted tool is never forwarded to a provider.
   *
   * @param promptVersionId - UUID of the prompt version to list attachments for.
   * @returns Hydrated attachment rows in position order; empty array if none attached
   *   (or if all attached tools have since been soft-deleted).
   */
  async listByPromptVersion(promptVersionId: string): Promise<AttachmentRow[]> {
    const rows = await prisma.promptVersionTool.findMany({
      where: { promptVersionId, tool: { deletedAt: null } },
      include: { tool: { select: { id: true, name: true, description: true } } },
      orderBy: { position: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      toolId: r.toolId,
      toolName: r.tool.name,
      toolDescription: r.tool.description,
      aliasName: r.aliasName,
      pinnedVersionId: r.pinnedVersionId,
      position: r.position,
    }));
  }
}
