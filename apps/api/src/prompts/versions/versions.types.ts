import { z } from 'zod';
import { PromptVersion } from '@prisma/client';
import type { ResolvedToolDefinition } from '../../tools/resolver';

// ── DB row type (Prisma inferred) ─────────────────────────────────────────────

/** Full row returned from the prompt_versions table. */
export type PromptVersionRow = PromptVersion;

// ── Request body schemas ──────────────────────────────────────────────────────

/** A single chat message with a nunjucks template string as content. */
export const MessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant'], {
    errorMap: () => ({ message: "role must be 'system', 'user', or 'assistant'" }),
  }),
  content: z.string().min(1, 'content must not be empty'),
});

/** Validated request body for POST /prompts/:id/versions */
export const CreateVersionBodySchema = z.object({
  messages: z
    .array(MessageSchema)
    .min(1, 'messages must be a non-empty array'),
  /** Issue #12: bind a default gateway model by publicName; omitted = unbound. */
  model: z.string().min(1).optional(),
});

/** TypeScript type derived from the Zod schema. */
export type CreateVersionDto = z.infer<typeof CreateVersionBodySchema>;

// ── Pagination query schema ───────────────────────────────────────────────────

/** Validated query params for GET /prompts/:id/versions */
export const ListVersionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListVersionsQueryDto = z.infer<typeof ListVersionsQuerySchema>;

// ── Service input type ────────────────────────────────────────────────────────

/** Input passed from VersionsService into VersionsRepository.create(). */
export interface CreateVersionInput {
  promptId: string;
  versionNumber: number;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  variables: string[];
  createdBy: string;
  /** Resolved GatewayModel id for the default model, or null if unbound (#12). */
  modelId?: string | null;
}

// ── Response types ────────────────────────────────────────────────────────────

/** Shape of a version in list responses (messages omitted for payload size). */
export interface VersionListItem {
  id: string;
  versionNumber: number;
  variables: string[];
  createdBy: string;
  createdAt: string;
  /** Bound default model's current publicName, or null if unbound/deleted (#12). */
  model: string | null;
}

/** Shape of a version in single-fetch and commit responses. */
export interface VersionDetail {
  id: string;
  promptId: string;
  versionNumber: number;
  messages: Array<{ role: string; content: string }>;
  variables: string[];
  /** Bound default model's current publicName, or null if unbound/deleted (#12). */
  model: string | null;
  createdBy: string;
  createdAt: string;
}

/** Response for GET /prompt-versions/:versionId — enough to prefill the Playground. */
export interface VersionByIdResponse {
  promptId: string;
  promptName: string;
  versionNumber: number;
  messages: Array<{ role: string; content: string }>;
  variables: string[];
  /** OpenAI-shaped tool definitions attached to this version (FAQ Q4). */
  tools: ResolvedToolDefinition[];
  /** Bound default model's current publicName, or null if unbound/deleted (#12). */
  model: string | null;
}
