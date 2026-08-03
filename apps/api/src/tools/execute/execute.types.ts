import { z } from 'zod';

/**
 * Validated request body for `POST /tools/:id/execute`. Exactly one of
 * `versionNumber`/`alias` should be supplied to pin a specific version — when
 * neither is given, `resolveVersion` falls back to the `production` alias.
 */
export const ExecuteBodySchema = z.object({
  arguments: z.record(z.unknown()).default({}),
  alias: z.string().optional(),
  versionNumber: z.number().int().min(1).optional(),
  traceContext: z.object({ traceId: z.string().optional(), parentSpanId: z.string().optional() }).optional(),
});
export type ExecuteBodyDto = z.infer<typeof ExecuteBodySchema>;

/** Response shape for a successful tool execution. */
export interface ExecuteResult {
  result: unknown;
  status: number;
  latencyMs: number;
  toolVersionId: string;
}
