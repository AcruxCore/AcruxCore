import { PayloadTooLargeError, ValidationError } from '../../../shared/errors';
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
   */
  async ingestOtlp(teamId: string, body: unknown, contentType: string): Promise<void> {
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

    for (const trace of traces) {
      for (const chunk of chunkTrace(trace)) {
        // `allowUnknownParents`: OTel batches children out before their parents,
        // so a chunk (or a whole export) legitimately holds orphans for now.
        await this.ingestService.ingest(teamId, [chunk], {
          idempotent: true,
          allowUnknownParents: true,
        });
      }
    }
  }
}
