import { z } from 'zod';
import { PromptAlias } from '@prisma/client';
import type { ResolvedToolDefinition } from '../versions';

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
});

export type RenderDto = z.infer<typeof RenderBodySchema>;

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
  alias: string;
  versionId: string;
  versionNumber: number;
  messages: Array<{ role: string; content: string }>;
  variables: string[];
  /** The resolved version's bound default model publicName, or null (#12). */
  model: string | null;
}

/** Render response shape. */
export interface RenderResponse {
  messages: Array<{ role: string; content: string }>;
  /** OpenAI-shaped tool definitions attached to the resolved version (FAQ Q4). */
  tools: ResolvedToolDefinition[];
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
  messages: Array<{ role: string; content: string }>;
  versionId: string;
  versionNumber: number;
  /** OpenAI-shaped tool definitions attached to the resolved version (FAQ Q4). */
  tools: ResolvedToolDefinition[];
  /** The resolved version's bound default model publicName, or null (#12). */
  model: string | null;
}
