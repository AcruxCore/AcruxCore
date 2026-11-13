import { AppError, PayloadTooLargeError, ValidationError } from '../../../shared/errors';
import { IngestService } from '../ingest.service';
import type { IngestTrace } from '../ingest.types';
import { decodeOtlpJson, decodeOtlpProtobuf } from './otlp-decoder';
import { translateResourceSpans } from './otlp-translator';

/** Per-request span cap the native JSON path also enforces (`ingest.service.ts`). */
const CHUNK_SIZE = 200;

/**
 * Ceiling on the total spans one OTLP export may carry, across every trace in it.
 * Chunking removed the native path's effective cap (each chunk is ≤`CHUNK_SIZE`,
 * so nothing bounded the whole request but the 10MB byte limit — room for ~10⁵
 * spans and minutes of transaction time holding row locks). 2000 is 10x OTel's
 * own default `maxExportBatchSize` of 512: generous for a legitimately large
 * export, still a bounded worst case.
 */
const MAX_SPANS_PER_REQUEST = 2000;

/** Splits one trace's spans into ≤`CHUNK_SIZE` groups, each ingested as its own call. */
function chunkTrace(trace: IngestTrace): IngestTrace[] {
  const chunks: IngestTrace[] = [];
  for (let i = 0; i < trace.spans.length; i += CHUNK_SIZE) {
    chunks.push({ ...trace, spans: trace.spans.slice(i, i + CHUNK_SIZE) });
  }
  return chunks.length > 0 ? chunks : [trace];
}

/**
 * What an export stored, in the terms of OTLP's `ExportTracePartialSuccess`: how many
 * spans were refused, and why. `rejectedSpans` is 0 when everything was stored.
 */
export interface OtlpIngestResult {
  rejectedSpans: number;
  errorMessage?: string;
}

/**
 * Decodes and ingests one OTLP/HTTP export request — the business-logic
 * counterpart, for the OTLP wire format, to the native JSON path's
 * {@link IngestService}. Kept as its own class rather than folded into
 * `IngestService` so wire-format translation stays a separate, independently
 * testable concern from the ingestion use case it delegates to.
 */
export class OtlpService {
  /**
   * @param ingestService - The shared ingestion use-case service (native path too).
   */
  constructor(private readonly ingestService: IngestService) {}

  /**
   * Decodes `body` per `contentType`, translates it into AcruxCore's trace/span
   * shape, and ingests it in idempotent mode (safe for OTLP's retry-on-failure
   * behavior).
   *
   * @param teamId - Team scope from the authenticated principal.
   * @param body - The raw request body: a `Buffer` for protobuf, a parsed
   *   object for JSON (whichever `contentType` indicates).
   * @param contentType - The request's `Content-Type` header value.
   * @throws {ValidationError} 400 if `body` cannot be decoded or translated as
   *   OTLP for the given content type. Only the decode/translate step is wrapped:
   *   an ingestion failure keeps its own typed error (or stays unclassified and
   *   becomes a 500), because per the OTLP spec a 4xx is non-retryable and an
   *   exporter told 400 for a transient server fault drops the batch for good.
   * @throws {PayloadTooLargeError} 413 if the export carries more than
   *   `MAX_SPANS_PER_REQUEST` spans in total.
   * @throws The first non-client error of any trace (an unclassified error, or an
   *   `AppError` of status 500 or more), after the traces before it are stored. A retry is
   *   safe because the receiver ingests idempotently.
   * @returns How many spans were refused. A trace that ingestion refuses with a typed
   *   client error (an `AppError` below 500) is skipped and counted here instead of
   *   failing the export: one bad trace must not discard the other traces in it, and an
   *   exporter does not retry a 4xx, so failing the request would lose them for good.
   */
  async ingestOtlp(teamId: string, body: unknown, contentType: string): Promise<OtlpIngestResult> {
    let traces: IngestTrace[];
    try {
      const resourceSpans = contentType.includes('application/json')
        ? decodeOtlpJson(body)
        : decodeOtlpProtobuf(body as Buffer);
      traces = translateResourceSpans(resourceSpans);
    } catch (err) {
      throw new ValidationError(`Malformed OTLP request: ${(err as Error).message}`);
    }

    const totalSpans = traces.reduce((n, t) => n + t.spans.length, 0);
    if (totalSpans > MAX_SPANS_PER_REQUEST) {
      console.warn(
        `[trace] OTLP export rejected for team ${teamId}: ${totalSpans} spans exceeds cap of ${MAX_SPANS_PER_REQUEST}`,
      );
      throw new PayloadTooLargeError(
        `Export has ${totalSpans} spans; the per-request limit is ${MAX_SPANS_PER_REQUEST}.`,
      );
    }

    const result: OtlpIngestResult = { rejectedSpans: 0 };
    for (const trace of traces) {
      for (const chunk of chunkTrace(trace)) {
        try {
          // `allowUnknownParents`: OTel batches children out before their parents,
          // so a chunk (or a whole export) legitimately holds orphans for now.
          // `derivedName`: the trace name here comes from the batch's root span, not from
          // a caller, so it must fill a placeholder in and never overwrite a real name —
          // the chunk holding the root can arrive after the one that created the trace.
          await this.ingestService.ingest(teamId, [chunk], {
            idempotent: true,
            allowUnknownParents: true,
            derivedName: true,
          });
        } catch (err) {
          if (!(err instanceof AppError) || err.statusCode >= 500) throw err;
          console.warn(
            `[trace] OTLP export for team ${teamId}: refused ${chunk.spans.length} span(s) of one trace: ${err.message}`,
          );
          result.rejectedSpans += chunk.spans.length;
          result.errorMessage ??= err.message;
        }
      }
    }
    return result;
  }
}
