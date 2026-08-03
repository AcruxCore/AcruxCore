import { z } from 'zod';

/** Non-negative USD-per-1M price with up to 4 decimals; null clears pricing. */
const priceSchema = z.number().nonnegative().nullable();

/**
 * Body for POST /gateway/models. `fallbackModelIds` is an ordered list of other
 * registered models tried on failure; each must belong to the same team and
 * differ from the model being created. Prices omitted are prefilled from the
 * static registry when the upstream model is known (see the service).
 */
export const CreateModelSchema = z.object({
  publicName: z.string().min(1, 'Public name is required.').max(200),
  upstreamModel: z.string().min(1, 'Upstream model is required.').max(200),
  credentialId: z.string().uuid('credentialId must be a UUID.'),
  inputPricePerM: priceSchema.optional(),
  outputPricePerM: priceSchema.optional(),
  fallbackModelIds: z.array(z.string().uuid()).default([]),
});

/** Validated create payload. */
export type CreateModelDto = z.infer<typeof CreateModelSchema>;

/**
 * Body for PATCH /gateway/models/:id. Every field optional. `publicName` stays
 * unique per team. Passing `fallbackModelIds` replaces the whole ordered set;
 * omitting it leaves the existing chain untouched.
 */
export const UpdateModelSchema = z.object({
  publicName: z.string().min(1).max(200).optional(),
  upstreamModel: z.string().min(1).max(200).optional(),
  credentialId: z.string().uuid().optional(),
  inputPricePerM: priceSchema.optional(),
  outputPricePerM: priceSchema.optional(),
  fallbackModelIds: z.array(z.string().uuid()).optional(),
});

/** Validated update payload. */
export type UpdateModelDto = z.infer<typeof UpdateModelSchema>;

/**
 * Read shape returned by every endpoint. Prices are plain numbers (or null);
 * `provider` and `credentialLabel` are denormalized from the bound credential
 * for display. `fallbacks` are in call order.
 */
export interface GatewayModelDto {
  id: string;
  publicName: string;
  upstreamModel: string;
  credentialId: string;
  credentialLabel: string;
  provider: string;
  inputPricePerM: number | null;
  outputPricePerM: number | null;
  fallbacks: { id: string; publicName: string }[];
  createdAt: Date;
  updatedAt: Date;
}

/** Result of POST /gateway/models/:id/test — a diagnostic ping, never throws to the client. */
export interface ModelTestResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}
