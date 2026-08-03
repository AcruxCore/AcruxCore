import type { TraceInput } from './types';

/**
 * Tuning for {@link SpanQueue}. `maxBatchSpans` mirrors what the platform enforces;
 * `maxQueuedSpans` is a client-side memory bound with no server counterpart.
 */
export interface SpanQueueOptions {
  /**
   * Most spans allowed in one outgoing request. Defaults to 200, matching
   * `MAX_SPANS_PER_BATCH` in the traces ingest service — a larger batch is rejected
   * with `413`. Clamped to at least 1.
   */
  maxBatchSpans?: number;
  /**
   * Most spans held in memory before the oldest are dropped. Defaults to 2000.
   * Clamped to at least 1.
   */
  maxQueuedSpans?: number;
}

const DEFAULT_MAX_BATCH_SPANS = 200;
const DEFAULT_MAX_QUEUED_SPANS = 2000;

/**
 * Spans a trace entry carries. Tolerant of a malformed entry (no `spans` array) so a
 * bad payload is dropped by the server rather than throwing inside the drain loop.
 */
function spanCount(input: TraceInput): number {
  return input.spans?.length ?? 0;
}

/**
 * A FIFO buffer of pending trace reports, drained by a serial loop with no timer.
 *
 * `enqueue` is synchronous: it appends and starts the loop in the same tick, so a
 * caller never waits on the network and nothing is held back by a batching window. The
 * loop sends everything currently buffered (up to `maxBatchSpans`) and, when that
 * request completes, immediately takes whatever arrived meanwhile — so an idle queue
 * sends at once and a busy one coalesces only while a request is already in flight.
 *
 * The loop is deliberately **serial**. `IngestService` validates each span's
 * `parentSpanId` against the spans already stored on that trace, so two requests in
 * flight could land a child before its parent and fail the whole batch with
 * `400 INVALID_SPAN_PARENT`.
 *
 * @example
 * ```typescript
 * const queue = new SpanQueue((batch) => postTraces(batch));
 * queue.enqueue({ traceId, name: 'chat', spans: [llmSpan] });  // returns immediately
 * await queue.flush();                                          // before reading back
 * ```
 */
export class SpanQueue {
  private readonly send: (batch: TraceInput[]) => Promise<void>;
  private readonly maxBatchSpans: number;
  private readonly maxQueuedSpans: number;

  private buffer: TraceInput[] = [];
  private queuedSpans = 0;
  private draining: Promise<void> | null = null;
  private closed = false;

  private warnedDropped = false;
  private warnedClosed = false;
  private readonly warnedErrors = new Set<string>();

  /**
   * @param send - Performs one `POST /traces` for a batch. Must reject on a network
   *   failure or a non-2xx response; the queue turns that into one warning and drops
   *   the batch.
   * @param options - See {@link SpanQueueOptions}.
   */
  constructor(send: (batch: TraceInput[]) => Promise<void>, options?: SpanQueueOptions) {
    this.send = send;
    // Clamped to >= 1: a cap of 0 would make every batch empty, so the buffer could
    // never drain and flush() would never resolve.
    this.maxBatchSpans = Math.max(1, options?.maxBatchSpans ?? DEFAULT_MAX_BATCH_SPANS);
    this.maxQueuedSpans = Math.max(1, options?.maxQueuedSpans ?? DEFAULT_MAX_QUEUED_SPANS);
  }

  /** Spans still waiting to be sent. Exposed for tests and diagnostics. */
  get pendingSpanCount(): number {
    return this.queuedSpans;
  }

  /**
   * Buffers one trace report and starts the drain loop. Returns immediately and never
   * throws — a telemetry problem must not surface in application code.
   *
   * @param input - The trace and spans to report, the same shape `trace()` takes.
   */
  enqueue(input: TraceInput): void {
    if (this.closed) {
      if (!this.warnedClosed) {
        this.warnedClosed = true;
        console.warn('[acruxcore] trace enqueued after the client was closed — discarding');
      }
      return;
    }

    this.buffer.push(input);
    this.queuedSpans += spanCount(input);

    // Overflow sheds the OLDEST, which keeps the most recent activity — the part
    // someone debugging is actually looking at.
    let dropped = false;
    while (this.queuedSpans > this.maxQueuedSpans && this.buffer.length > 1) {
      this.dropHead();
      dropped = true;
    }
    if (dropped && !this.warnedDropped) {
      this.warnedDropped = true;
      console.warn(
        `[acruxcore] trace buffer is full (${this.maxQueuedSpans} spans) — dropping the oldest spans`,
      );
    }

    // Starts the send in this same tick. `void` is safe because `drain()` swallows
    // every failure, so `draining` never rejects.
    void this.wake();
  }

  /** Removes the oldest entry, keeping the span accounting straight. */
  private dropHead(): void {
    const oldest = this.buffer.shift();
    if (oldest) this.queuedSpans -= spanCount(oldest);
  }

  /**
   * Starts the drain loop unless it is already running, and returns the promise for
   * the run in progress. Never rejects.
   */
  private wake(): Promise<void> {
    if (!this.draining) {
      this.draining = this.drain().finally(() => {
        this.draining = null;
      });
    }
    return this.draining;
  }

  /**
   * Sends batches until the buffer is empty. One request in flight at a time; anything
   * enqueued during a request is picked up by the next iteration.
   */
  private async drain(): Promise<void> {
    while (this.buffer.length > 0) {
      const batch = this.takeBatch();
      if (batch.length === 0) {
        // Unreachable: takeBatch always takes at least one entry from a non-empty
        // buffer. Dropping the head rather than continuing guarantees progress, so a
        // future change here cannot turn this into a hot loop that flush() waits on.
        this.dropHead();
        continue;
      }
      try {
        await this.send(batch);
      } catch (err) {
        const kind = err instanceof Error ? err.message : String(err);
        if (!this.warnedErrors.has(kind)) {
          this.warnedErrors.add(kind);
          console.warn(`[acruxcore] trace report failed — continuing without it: ${kind}`);
        }
        // The batch is dropped rather than retried: `send` already retries transient
        // failures, and holding it would stall every span queued behind it.
      }
    }
  }

  /**
   * Removes and returns the next batch, honouring the span cap and merging entries
   * that share a trace id.
   *
   * Always returns at least one entry when the buffer is non-empty, so an entry on its
   * own larger than the cap still makes progress instead of wedging the loop.
   */
  private takeBatch(): TraceInput[] {
    const batch: TraceInput[] = [];
    let spans = 0;

    while (this.buffer.length > 0 && spans < this.maxBatchSpans) {
      const next = this.buffer[0];
      const size = spanCount(next);
      const room = this.maxBatchSpans - spans;

      if (size <= room) {
        this.buffer.shift();
        this.queuedSpans -= size;
        batch.push(next);
        spans += size;
        continue;
      }

      // Does not fit. Leave it for the next batch if this one already has something.
      if (batch.length > 0) break;

      // It is alone and still over the cap. Split it when the trace can be addressed
      // by id: the drain is serial, so the first chunk is stored before the second is
      // sent and each one appends to the same trace in order. Without an id every
      // chunk would mint a trace of its own, so send it whole and let the server's
      // 413 surface as one dropped batch.
      if (!next.traceId) {
        this.buffer.shift();
        this.queuedSpans -= size;
        batch.push(next);
        spans += size;
        break;
      }
      batch.push({ ...next, spans: next.spans.slice(0, room) });
      this.buffer[0] = { ...next, spans: next.spans.slice(room) };
      this.queuedSpans -= room;
      spans += room;
      break;
    }

    return mergeByTraceId(batch);
  }

  /**
   * Waits until everything buffered has been sent (or dropped after a failure).
   *
   * @returns Resolves once the buffer is empty and the loop is idle. Never rejects —
   *   a telemetry failure is warned about, not thrown.
   */
  async flush(): Promise<void> {
    while (this.buffer.length > 0 || this.draining) {
      await (this.draining ?? this.wake());
    }
  }

  /**
   * Flushes, then refuses further work. Idempotent.
   *
   * @returns Resolves once the final flush completes.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
  }
}

/**
 * Folds entries that share a trace id into one entry of the outgoing `traces[]` array,
 * preserving span order within each trace and the order the traces first appeared.
 *
 * Entries with no trace id are left alone — each one mints its own trace server-side,
 * so merging them would collapse unrelated activity into a single trace.
 *
 * @param batch - Entries selected for one request.
 * @returns The same spans, in the same order, in as few entries as possible.
 */
function mergeByTraceId(batch: TraceInput[]): TraceInput[] {
  if (batch.length < 2) return batch;

  const merged: TraceInput[] = [];
  const byTraceId = new Map<string, TraceInput>();

  for (const entry of batch) {
    if (!entry.traceId) {
      merged.push(entry);
      continue;
    }
    const existing = byTraceId.get(entry.traceId);
    if (!existing) {
      // Copied so merging never mutates what the caller handed to `enqueue`.
      const copy: TraceInput = { ...entry, spans: [...(entry.spans ?? [])] };
      byTraceId.set(entry.traceId, copy);
      merged.push(copy);
      continue;
    }
    existing.spans.push(...(entry.spans ?? []));
    // A later entry may carry context the first lacked — a session id adopted
    // part-way through a tool loop, for instance.
    existing.sessionId ??= entry.sessionId;
    existing.name ??= entry.name;
    existing.tags ??= entry.tags;
    existing.metadata ??= entry.metadata;
  }

  return merged;
}
