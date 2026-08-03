import { z } from 'zod';

/** Zod schema for a single message inside the import body. */
const MessageSchema = z.object({
  role:    z.string().min(1),
  content: z.string(),
});

/**
 * Zod schema for the import request body.
 * `schemaVersion` must equal `1` — other values are rejected with UNSUPPORTED_SCHEMA_VERSION.
 * `prompt.name` must be a non-empty string.
 * `version.messages` must be a non-empty array where each item has role and content.
 */
export const ImportBodySchema = z.object({
  schemaVersion: z.literal(1, { errorMap: () => ({ message: 'UNSUPPORTED_SCHEMA_VERSION' }) }),
  exportedAt:    z.string().optional(),
  prompt: z.object({
    name:        z.string().min(1, 'prompt.name must not be empty'),
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
