import { z } from 'zod';

/**
 * Body for `POST /gateway/keys`. Allow-lists are nullable: `null` (or omitted) =
 * unrestricted; a non-empty array = allow-list. Rate-limit / cache fields are
 * optional positive integers (enforced by G4/G6).
 */
export const CreateVirtualKeySchema = z.object({
  name: z.string().min(1, 'Name is required.').max(100, 'Name must be 100 characters or fewer.'),
  allowedModels: z.array(z.string().min(1)).nullable().optional(),
  allowedProviders: z.array(z.string().min(1)).nullable().optional(),
  maxRpm: z.number().int().positive().optional(),
  maxTpm: z.number().int().positive().optional(),
  cacheTtlSeconds: z.number().int().positive().optional(),
});
export type CreateVirtualKeyDto = z.infer<typeof CreateVirtualKeySchema>;

/**
 * Body for `PATCH /gateway/keys/:id`. Every field optional; rate-limit / cache
 * fields are additionally nullable so a caller can clear a limit back to
 * "team default / unlimited".
 */
export const UpdateVirtualKeySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  allowedModels: z.array(z.string().min(1)).nullable().optional(),
  allowedProviders: z.array(z.string().min(1)).nullable().optional(),
  maxRpm: z.number().int().positive().nullable().optional(),
  maxTpm: z.number().int().positive().nullable().optional(),
  cacheTtlSeconds: z.number().int().positive().nullable().optional(),
});
export type UpdateVirtualKeyDto = z.infer<typeof UpdateVirtualKeySchema>;

/**
 * Response for `POST /gateway/keys` — the ONLY response that includes the
 * plaintext `key`. Allow-lists surface as `null` when unrestricted.
 */
export interface VirtualKeyCreatedDto {
  id: string;
  name: string;
  key: string; // plaintext agh_sk_… — shown once only
  keyLastFour: string;
  allowedModels: string[] | null;
  allowedProviders: string[] | null;
  maxRpm: number | null;
  maxTpm: number | null;
  cacheTtlSeconds: number | null;
  createdAt: Date;
}

/**
 * Masked list item for `GET /gateway/keys` and `PATCH` responses.
 * Never includes the plaintext token or the hash.
 */
export interface VirtualKeyListItemDto {
  id: string;
  name: string;
  keyLastFour: string;
  allowedModels: string[] | null;
  allowedProviders: string[] | null;
  maxRpm: number | null;
  maxTpm: number | null;
  cacheTtlSeconds: number | null;
  createdAt: Date;
  revokedAt: Date | null;
}
