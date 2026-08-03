import type { SpanKind, SpanStatus } from '../../shared/db/schema';

/**
 * Input for {@link SpansRepository.createTrace}. `id` is optional so a caller can
 * supply its own trace id (T2 ingestion / a gateway call nesting under a
 * caller-supplied trace); omitted → the DB generates one. `tags`/`metadata` are
 * set once at creation — appending to an existing trace goes through
 * {@link SpansRepository.mergeTraceContext} instead (T8, FAQ Q11).
 */
export interface CreateTraceInput {
  id?: string;
  teamId: string;
  sessionId?: string | null;
  name?: string | null;
  status?: SpanStatus;
  startedAt: Date;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Input for {@link SpansRepository.appendSpan}. `spanRef` is the caller-supplied /
 * generated opaque span id (unique within a trace); observability fields are inline.
 * `tags`/`metadata` (T9) are caller-supplied and default to `[]`/`{}`; `attributes`
 * stays the system-set bucket (e.g. `cacheHit`, FAQ Q13).
 */
export interface CreateSpanInput {
  teamId: string;
  traceId: string;
  spanRef: string;
  parentSpanRef?: string | null;
  kind: SpanKind;
  name: string;
  status?: SpanStatus;
  startedAt: Date;
  endedAt?: Date | null;
  latencyMs?: number | null;
  model?: string | null;
  provider?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  costUsd?: number | null;
  promptVersionId?: string | null;
  gatewayRequestId?: string | null;
  errorMessage?: string | null;
  attributes?: Record<string, unknown>;
  tags?: string[];
  metadata?: Record<string, unknown>;
}
