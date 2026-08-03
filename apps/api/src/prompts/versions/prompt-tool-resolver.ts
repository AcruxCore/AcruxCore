import { PromptVersionToolRepository } from './attachments.repository';
import { ToolAliasesRepository } from '../../tools/aliases/aliases.repository';
import { ToolVersionsRepository } from '../../tools/versions/versions.repository';
import { ResolvedToolDefinition } from '../../tools/resolver';

/**
 * Resolves a prompt version's attached tools to OpenAI tool definitions.
 * Each attachment resolves to a concrete ToolVersion: the pin if present, else the
 * named alias's current target; the version's parametersSchema becomes `parameters`.
 * The resolved def's `description` prefers the version's own description and falls
 * back to the tool-level description when the version has none, matching the shape
 * produced by the gateway's `ToolResolver.resolveRefs`.
 * An attachment whose tool has been soft-deleted is excluded upstream (see
 * `PromptVersionToolRepository.listByPromptVersion`); an attachment whose alias or
 * pinned version has since gone missing is skipped here (best-effort), so neither
 * ever breaks rendering of an existing prompt version.
 */
export class PromptToolResolver {
  private readonly attachments = new PromptVersionToolRepository();
  private readonly aliases = new ToolAliasesRepository();
  private readonly versions = new ToolVersionsRepository();

  /**
   * @param promptVersionId - The committed prompt version whose tools to resolve.
   * @returns OpenAI tool definitions in attachment order; empty when none attached.
   */
  async resolveForVersion(promptVersionId: string): Promise<ResolvedToolDefinition[]> {
    const rows = await this.attachments.listByPromptVersion(promptVersionId);
    const out: ResolvedToolDefinition[] = [];
    for (const row of rows) {
      const versionId: string | null = row.pinnedVersionId;
      if (!versionId) {
        const alias = await this.aliases.findByAlias(row.toolId, row.aliasName);
        if (!alias) continue; // alias gone — skip
        // findByAlias returns versionNumber; fetch the version row for schema/description
        const version = await this.versions.findByVersionNumber(row.toolId, alias.versionNumber);
        if (!version) continue;
        out.push(this.toDef(row.toolName, row.toolDescription, version));
        continue;
      }
      // pinned: fetch by id via the versions repo
      const pinned = await this.versions.findById(versionId);
      if (!pinned || pinned.toolId !== row.toolId) continue;
      out.push(this.toDef(row.toolName, row.toolDescription, pinned));
    }
    return out;
  }

  /**
   * Builds an OpenAI tool def from a tool name, the tool's own description, and the
   * resolved version row. `description` prefers the version's own description and
   * falls back to the tool-level description when the version has none set — matching
   * `ToolResolver.resolveRefs`'s fallback so both resolvers produce identical shapes.
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
