import { z } from 'zod';
import { PromptAlias } from '@prisma/client';
import type { ResolvedToolDefinition, ToolResolutionDetail } from '../versions';
import type { TemplateContent } from '../versions/nunjucks.utils';

// ── DB row type ───────────────────────────────────────────────────────────────

/** Full row returned from the prompt_aliases table. */
export type PromptAliasRow = PromptAlias;

// ── Request body schemas ──────────────────────────────────────────────────────

/** Validated request body for POST /prompts/:id/aliases/:alias/promote */
export const PromoteAliasBodySchema = z.object({
  version_number: z
    .number({ required_error: 'version_number is required' })
    .int('version_number must be an integer')
    .min(1, 'version_number must be >= 1'),
});

export type PromoteAliasDto = z.infer<typeof PromoteAliasBodySchema>;

/** Validated request body for POST /prompts/:name/:alias/render */
export const RenderBodySchema = z.object({
  variables: z.record(z.unknown()).default({}),
  /**
   * Render this version's template instead of the alias's (phase-5 FAQ Q58). The
   * alias still decides the tools. For testing a version before an alias moves to it.
   */
  version: z.number().int().positive().optional(),
});

export type RenderDto = z.infer<typeof RenderBodySchema>;

/** Validated query for GET /prompt-versions?name=&alias= (or &version=) */
export const VersionByAliasQuerySchema = z
  .object({
    name: z.string({ required_error: 'name is required' }).min(1, 'name is required'),
    alias: z.string().min(1, 'alias must not be empty').optional(),
    /** A version number to return instead of an alias's version (phase-5 FAQ Q58). */
    version: z.coerce.number().int().positive('version must be a positive integer').optional(),
  })
  .refine((q) => q.alias !== undefined || q.version !== undefined, {
    message: 'alias or version is required',
  });

export type VersionByAliasQuery = z.infer<typeof VersionByAliasQuerySchema>;

// ── Response types ────────────────────────────────────────────────────────────

/** Shape of an alias in list and promote responses, joining versionNumber from prompt_versions. */
export interface AliasDetail {
  id: string;
  alias: string;
  versionId: string;
  versionNumber: number;
  updatedAt: string;
}

/** Internal: alias row joined with version details, used during render. */
export interface AliasWithVersion {
  aliasId: string;
  /** The parent prompt's id — the scope for `prompt_tool_bindings` lookups (phase-4-faq Q53). */
  promptId: string;
  alias: string;
  versionId: string;
  versionNumber: number;
  messages: Array<{ role: string; content: TemplateContent }>;
  variables: string[];
  /** The resolved version's bound default model publicName, or null (#12). */
  model: string | null;
}

/** Render response shape. */
export interface RenderResponse {
  messages: Array<{ role: string; content: TemplateContent }>;
  /** OpenAI-shaped tool definitions attached to the resolved version (FAQ Q4). */
  tools: ResolvedToolDefinition[];
  /**
   * Per-tool resolution metadata, parallel to `tools` (never merged into it — those
   * definitions are sometimes forwarded as-is to a model provider). Reports which
   * tool alias (or pin) each attachment actually resolved through this alias, and
   * whether the prompt alias's own binding or the prompt's default binding decided it
   * (phase-4-faq Q53).
   */
  toolResolutions: ToolResolutionDetail[];
  /** The resolved version's bound default model publicName, or null (#12) — so
   * callers can run the prompt on its bound model without hardcoding one. */
  model: string | null;
  /** The resolved prompt version's id — pass through to chat()/runToolLoop() as
   * promptVersionId so a client-reported trace carries prompt lineage. */
  versionId: string;
  /** The resolved prompt version's number (matches versionId 1:1). */
  versionNumber: number;
}

/**
 * Render result that also carries lineage — the resolved prompt version's id and
 * number. Consumed by the gateway (G8) to stamp `gateway_requests.prompt_version_id`.
 */
export interface RenderedWithVersion {
  messages: Array<{ role: string; content: TemplateContent }>;
  versionId: string;
  versionNumber: number;
  /** OpenAI-shaped tool definitions attached to the resolved version (FAQ Q4). */
  tools: ResolvedToolDefinition[];
  /** Per-tool resolution metadata, parallel to `tools` — see {@link RenderResponse.toolResolutions}. */
  toolResolutions: ToolResolutionDetail[];
  /** The resolved version's bound default model publicName, or null (#12). */
  model: string | null;
}
