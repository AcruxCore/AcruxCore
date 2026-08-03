import { z } from 'zod';

/**
 * Zod schema for the diff endpoint query parameters.
 * Both `from` and `to` are required positive integers representing version numbers.
 */
export const DiffQuerySchema = z.object({
  from: z.coerce.number().int().min(1, '`from` must be a positive integer'),
  to:   z.coerce.number().int().min(1, '`to` must be a positive integer'),
});

export type DiffQuery = z.infer<typeof DiffQuerySchema>;

/**
 * Response shape for the diff endpoint.
 */
export interface DiffResponse {
  /** Unified diff string produced by `createPatch` from the `diff` package. */
  diff:        string;
  fromVersion: number;
  toVersion:   number;
}
