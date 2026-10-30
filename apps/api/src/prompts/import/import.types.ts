import { z } from 'zod';
import { MAX_PROMPT_NAME_LENGTH } from '../prompts.types';
import { CacheControlSchema, StoredPartSchema, refineImageInUserMessage } from '../versions/versions.types';

/** Zod schema for a single message inside the import body. */
const MessageSchema = z.object({
  role:    z.string().min(1),
  content: z.union([z.string(), z.array(StoredPartSchema).min(1)]),
  /** Prompt-cache marker; kept so an export → import round trip does not lose it. */
  cache_control: CacheControlSchema.optional(),
}).superRefine(refineImageInUserMessage);

/**
 * Zod schema for the import request body.
 * `schemaVersion` must equal `1` — other values are rejected with UNSUPPORTED_SCHEMA_VERSION.
 * `prompt.name` is trimmed and must be 1–255 characters, as on create.
 * `version.messages` must be a non-empty array where each item has role and content.
 */
export const ImportBodySchema = z.object({
  schemaVersion: z.literal(1, { errorMap: () => ({ message: 'UNSUPPORTED_SCHEMA_VERSION' }) }),
  exportedAt:    z.string().optional(),
  prompt: z.object({
    // Same rules as POST /prompts: a padded copy of a taken name must not slip past
    // the uniqueness check as a second prompt that looks the same in the dashboard.
    name:        z.string().trim().min(1, 'prompt.name must not be empty').max(MAX_PROMPT_NAME_LENGTH, `prompt.name must be ${MAX_PROMPT_NAME_LENGTH} characters or fewer`),
    description: z.string().nullable().optional(),
  }),
  version: z.object({
    versionNumber: z.number().optional(),
    messages:      z.array(MessageSchema).min(1, 'version.messages must not be empty'),
    variables:     z.array(z.string()).optional(),
    createdAt:     z.string().optional(),
  }),
});

export type ImportBody = z.infer<typeof ImportBodySchema>;

/**
 * Response body returned after a successful import.
 */
export interface ImportResponse {
  prompt:  { id: string; name: string };
  version: { id: string; versionNumber: number };
}
