import { z } from 'zod';
import { PromptVersion } from '@prisma/client';
import type { ResolvedToolDefinition } from '../../tools/resolver';

// ── DB row type (Prisma inferred) ─────────────────────────────────────────────

/** Full row returned from the prompt_versions table. */
export type PromptVersionRow = PromptVersion;

// ── Request body schemas ──────────────────────────────────────────────────────

/**
 * Anthropic's prompt-cache marker on a message (issue #552). `ephemeral` is the only type
 * Anthropic defines. The gateway sends it on to Anthropic models and drops it for the rest.
 */
export const CacheControlSchema = z.object(
  { type: z.literal('ephemeral', { errorMap: () => ({ message: "cache_control.type must be 'ephemeral'" }) }) },
  { invalid_type_error: "cache_control must be an object like { type: 'ephemeral' }" },
);

/**
 * One part of a stored message that has several parts (issue #573). Both the text and an
 * image's `url` are nunjucks templates, so `{{ receipt_url }}` fills the image from a variable.
 * The URL is checked when the call is made, after rendering, not when the version is committed.
 */
export const StoredPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1, 'text part must not be empty') }),
  z.object({
    type: z.literal('image_url'),
    image_url: z.object({
      url: z.string().min(1, 'image_url.url must not be empty'),
      detail: z.enum(['auto', 'low', 'high']).optional(),
    }),
  }),
]);

/** One part of a stored message's `content` list. */
export type StoredPart = z.infer<typeof StoredPartSchema>;

/**
 * Zod refinement shared by every schema that takes stored messages (commit, import): an image
 * part may only sit in a `user` message, because that is the only role a provider accepts it in.
 * Anthropic and Gemini drop an image from a system message without an error.
 *
 * @param m - A parsed message.
 * @param ctx - The Zod refinement context; an issue is added on `content` when the rule is broken.
 */
export function refineImageInUserMessage(m: { role: string; content: string | StoredPart[] }, ctx: z.RefinementCtx): void {
  if (m.role !== 'user' && Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `An image can only be in a user message, not in a ${m.role} message.`,
      path: ['content'],
    });
  }
}

/**
 * A single chat message. `content` is a nunjucks template string, or a list of text and image
 * parts. Only a `user` message may hold an image part, because that is all a provider accepts.
 */
export const MessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant'], {
      errorMap: () => ({ message: "role must be 'system', 'user', or 'assistant'" }),
    }),
    content: z.union([
      z.string().min(1, 'content must not be empty'),
      z.array(StoredPartSchema).min(1, 'content parts must not be empty'),
    ]),
    /** Cache the prompt up to and including this message, on Anthropic models. */
    cache_control: CacheControlSchema.optional(),
  })
  .superRefine(refineImageInUserMessage);

/** A stored prompt message: a template string, optionally marked for prompt caching. */
export type StoredMessage = z.infer<typeof MessageSchema>;

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
  messages: StoredMessage[];
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
  messages: Array<{ role: string; content: string | StoredPart[]; cache_control?: { type: 'ephemeral' } }>;
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
  messages: Array<{ role: string; content: string | StoredPart[] }>;
  variables: string[];
  /** OpenAI-shaped tool definitions attached to this version (FAQ Q4). */
  tools: ResolvedToolDefinition[];
  /** Bound default model's current publicName, or null if unbound/deleted (#12). */
  model: string | null;
}
