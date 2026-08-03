import { z } from 'zod';

/** Span kind — mirrors T1's `span_kind` Postgres enum exactly. */
export const SPAN_KINDS = ['llm', 'tool', 'retrieval', 'embedding', 'agent', 'chain', 'other'] as const;
/** Span status — mirrors T1's `span_status` Postgres enum exactly. */
export const SPAN_STATUSES = ['ok', 'error', 'unset'] as const;

/** Zod enum for a span kind. */
export const SpanKindSchema = z.enum(SPAN_KINDS);
/** Zod enum for a span/trace status. */
export const SpanStatusSchema = z.enum(SPAN_STATUSES);

/** What a span represents. */
export type SpanKind = z.infer<typeof SpanKindSchema>;
/** Terminal status of a span/trace. */
export type SpanStatus = z.infer<typeof SpanStatusSchema>;

/** ISO-8601 datetime with a timezone offset (or `Z`). */
const isoDatetime = z.string().datetime({ offset: true });

/** Token counts for an llm span. All optional, all non-negative integers. */
export const UsageSchema = z.object({
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
});

/**
 * One OTel-shaped span in an ingestion batch. `spanId` is the caller-supplied
 * opaque id (maps to `span_ref`); `parentSpanId` links to another span's `spanId`.
 * `input`/`output` are stored only when payload capture resolves on.
 */
export const IngestSpanSchema = z
  .object({
    spanId: z.string().min(1),
    parentSpanId: z.string().min(1).optional(),
    name: z.string().min(1),
    kind: SpanKindSchema.optional(),
    status: SpanStatusSchema.optional(),
    startTime: isoDatetime,
    endTime: isoDatetime.optional(),
    model: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    usage: UsageSchema.optional(),
    costUsd: z.number().nonnegative().optional(),
    promptVersionId: z.string().uuid().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    variables: z.unknown().optional(),
    attributes: z.record(z.unknown()).optional(),
    error: z.string().optional(),
  })
  .superRefine((s, ctx) => {
    if (s.endTime && new Date(s.endTime).getTime() < new Date(s.startTime).getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endTime must be greater than or equal to startTime.',
        path: ['endTime'],
      });
    }
  });

/**
 * One trace in an ingestion batch. `traceId` is optional — omit to mint a new
 * trace, supply a UUID to append to (or, if absent for the team, create with)
 * that id. `spans` is non-empty and every `spanId` is unique within the trace.
 * `tags`/`metadata` (T8) are set on creation; appending to an existing trace
 * merges them (union tags, shallow-merge metadata) rather than overwriting
 * (FAQ Q11).
 */
export const IngestTraceSchema = z
  .object({
    traceId: z.string().uuid().optional(),
    sessionId: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    capturePayloads: z.boolean().optional(),
    tags: z.array(z.string().min(1)).optional(),
    metadata: z.record(z.unknown()).optional(),
    spans: z.array(IngestSpanSchema).min(1),
  })
  .superRefine((t, ctx) => {
    const seen = new Set<string>();
    for (const s of t.spans) {
      if (seen.has(s.spanId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate spanId "${s.spanId}" within a trace.`,
          path: ['spans'],
        });
      }
      seen.add(s.spanId);
    }
  });

/** The `POST /api/v1/traces` request body: a batch of traces. */
export const IngestBatchSchema = z.object({
  traces: z.array(IngestTraceSchema).min(1),
});

/** A single span as accepted by the ingestion endpoint. */
export type IngestSpan = z.infer<typeof IngestSpanSchema>;
/** A single trace as accepted by the ingestion endpoint. */
export type IngestTrace = z.infer<typeof IngestTraceSchema>;
/** The full batch body. */
export type IngestBatch = z.infer<typeof IngestBatchSchema>;

/** Response for `POST /api/v1/traces`. `accepted` is the total span count. */
export interface IngestResponse {
  accepted: number;
  traceIds: string[];
}
