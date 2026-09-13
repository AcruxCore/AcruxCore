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

/**
 * One classified failure, as the execute response reports it. `type` is a
 * `SpanErrorType`; the same pair is written onto the span's attributes.
 */
export interface ExecuteClassification {
  type: string;
  message: string;
}

/**
 * Response shape for a tool execution that produced a response at all.
 *
 * `error` being present does NOT mean the call threw. A tool whose upstream answered
 * 503, or whose own `failureWhen` fired, still returns its body here — the caller decides
 * whether to keep going, while the span is already red. Only a transport failure or a
 * broken transform throws, because those have no result to report.
 */
export interface ExecuteResult {
  result: unknown;
  status: number;
  latencyMs: number;
  toolVersionId: string;
  /** Present when a detector classified this call as failed. */
  error?: ExecuteClassification;
  /** Present when a detector fired but did not consider the call failed. */
  warning?: ExecuteClassification;
}
