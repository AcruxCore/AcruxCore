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
   * Most spans held in memory before the oldest are dropped. Defaults to 20,000, about
   * eight minutes of a 20 request/s app with two spans per request. Clamped to at least 1.
   */
  maxQueuedSpans?: number;
  /** Pause before the first retry, in ms; it doubles on each failure in a row. Defaults to 1000. */
  backoffInitialMs?: number;
  /** Longest pause between retries, in ms. Defaults to 30,000. */
  backoffMaxMs?: number;
  /**
   * How long `flush()` and `close()` wait on a server that keeps failing before they
   * return, in ms. Defaults to 10,000. A flush that gives up leaves the spans queued and
   * still retried; a close drops them, with a warning saying how many.
   */
  giveUpAfterMs?: number;
}

const DEFAULT_MAX_BATCH_SPANS = 200;
const DEFAULT_MAX_QUEUED_SPANS = 20_000;
const DEFAULT_BACKOFF_INITIAL_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 30_000;
const DEFAULT_GIVE_UP_AFTER_MS = 10_000;

/** Attempts a batch gets when the server keeps answering 500 before it is dropped. */
const SERVER_ERROR_ATTEMPTS = 3;

/** Statuses that mean "the server, or the proxy in front of it, is not ready yet". */
const TRY_AGAIN_STATUSES = new Set([408, 429, 502, 503, 504]);

type FailureAction = 'retry' | 'retryLimited' | 'drop';

/**
 * Decides what a failed send means for its batch.
 *
 * - No answer at all (refused, reset, timed out), or 408/429/502/503/504: the server is
 *   down, restarting, overloaded or behind a proxy that cannot reach it. Retry for as long
 *   as the buffer has room.
 * - Any other 5xx: the server answered and failed on this batch. Retry a few times, then
 *   drop it, so one batch the server cannot store never blocks the rest.
 * - Any other 4xx, or an error that is not about the network: retrying cannot help. Drop.
 *
 * @param err - What the sender threw. An HTTP failure carries a numeric `statusCode`
 *   (an {@link acruxcoreError}) or `status`.
 * @returns What to do with the batch.
 */
function failureAction(err: unknown): FailureAction {
  const e = err as {
    statusCode?: unknown;
    status?: unknown;
    name?: unknown;
    code?: unknown;
    cause?: { code?: unknown };
  } | null;
  const status = typeof e?.statusCode === 'number' ? e.statusCode : e?.status;
  if (typeof status === 'number') {
    if (TRY_AGAIN_STATUSES.has(status)) return 'retry';
    return status >= 500 ? 'retryLimited' : 'drop';
  }
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return 'retry';
  const code = typeof e?.code === 'string' ? e.code : e?.cause?.code;
  if (typeof code === 'string' && /^(E[A-Z]+|UND_ERR_)/.test(code)) return 'retry';
  // undici reports every network failure as `TypeError: fetch failed`.
  if (err instanceof TypeError && /fetch failed|network/i.test(err.message)) return 'retry';
  return 'drop';
}

/**
 * A cancellable wait.
 *
 * @param ms - How long to wait.
 * @param unref - True for a background wait that must not hold the process open.
 * @returns `done` resolves after `ms`, or at once when `cancel()` is called.
 */
function delay(ms: number, unref: boolean): { done: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
    timer = setTimeout(r, ms);
    if (unref) (timer as { unref?: () => void }).unref?.();
  });
  return {
    done,
    cancel: () => {
      clearTimeout(timer);
      resolve();
    },
  };
}

/** Spans in a batch, across its entries. */
function spansIn(batch: TraceInput[]): number {
  return batch.reduce((n, e) => n + spanCount(e), 0);
}

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
 * When the server cannot be reached, or answers "try again later", the batch goes back to
 * the head of the buffer and is sent again after a growing pause (1 s, 2 s, 4 s ... up to
 * 30 s), so an outage or a restart loses nothing while the buffer has room. The buffer is
 * the only memory bound: past `maxQueuedSpans` the oldest spans are dropped, with one
 * warning. A batch the server refuses (a 4xx) is dropped at once, and one that keeps failing
 * with a 500 after three attempts, so neither can block everything behind it. The server
 * stores a re-sent span once (it upserts on trace id + span id), so a retry after a reply
 * lost on the way back does not duplicate it. The pause between retries does not keep the
 * process alive.
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
  private readonly backoffInitialMs: number;
  private readonly backoffMaxMs: number;
  private readonly giveUpAfterMs: number;

  private buffer: TraceInput[] = [];
  private queuedSpans = 0;
  private inFlightSpans = 0;
  /** `Date.now()` of the first failure in the current run of failures; null while healthy. */
  private failingSince: number | null = null;
  private failuresInARow = 0;
  private headServerErrors = 0;
  private backoff: { done: Promise<void>; cancel: () => void } | null = null;
  private draining: Promise<void> | null = null;
  private closed = false;

  private warnedDropped = false;
  private warnedClosed = false;
  private readonly warnedErrors = new Set<string>();

  /**
   * @param send - Performs one `POST /traces` for a batch. Must reject on a network
   *   failure or a non-2xx response (with a numeric `statusCode` for the latter); the queue
   *   warns once per error kind and retries or drops the batch by the rules above.
   * @param options - See {@link SpanQueueOptions}.
   */
  constructor(send: (batch: TraceInput[]) => Promise<void>, options?: SpanQueueOptions) {
    this.send = send;
    // Clamped to >= 1: a cap of 0 would make every batch empty, so the buffer could
    // never drain and flush() would never resolve.
    this.maxBatchSpans = Math.max(1, options?.maxBatchSpans ?? DEFAULT_MAX_BATCH_SPANS);
    this.maxQueuedSpans = Math.max(1, options?.maxQueuedSpans ?? DEFAULT_MAX_QUEUED_SPANS);
    this.backoffInitialMs = Math.max(0, options?.backoffInitialMs ?? DEFAULT_BACKOFF_INITIAL_MS);
    this.backoffMaxMs = Math.max(this.backoffInitialMs, options?.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS);
    this.giveUpAfterMs = Math.max(0, options?.giveUpAfterMs ?? DEFAULT_GIVE_UP_AFTER_MS);
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
    this.shedOverflow();
    // Starts the send in this same tick. `void` is safe because `drain()` swallows
    // every failure, so `draining` never rejects.
    void this.wake();
  }

  /**
   * Drops the OLDEST entries past the cap, keeping the most recent activity — the part
   * someone debugging is looking at. Warns the first time only.
   */
  private shedOverflow(): void {
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
      const size = spansIn(batch);
      this.inFlightSpans = size;
      try {
        await this.send(batch);
      } catch (err) {
        this.inFlightSpans = 0;
        let action = failureAction(err);
        if (action === 'retryLimited' && ++this.headServerErrors >= SERVER_ERROR_ATTEMPTS) action = 'drop';
        const retrying = action !== 'drop' && !this.closed;
        const kind = err instanceof Error ? err.message : String(err);
        if (!this.warnedErrors.has(kind)) {
          this.warnedErrors.add(kind);
          console.warn(
            `[acruxcore] trace report failed — ${retrying ? 'retrying' : 'continuing without it'}: ${kind}`,
          );
        }
        this.failingSince ??= Date.now();
        if (!retrying) {
          this.headServerErrors = 0;
          continue;
        }
        // Back to the head, ahead of anything newer, then wait before the next attempt.
        this.buffer.unshift(...batch);
        this.queuedSpans += size;
        this.shedOverflow();
        this.failuresInARow++;
        this.backoff = delay(this.backoffMs(), true);
        await this.backoff.done;
        this.backoff = null;
        continue;
      }
      this.inFlightSpans = 0;
      this.failingSince = null;
      this.failuresInARow = 0;
      this.headServerErrors = 0;
    }
  }

  /**
   * The pause before the next attempt: doubling from the initial value up to the maximum,
   * with +/-20% jitter so many clients do not retry in step.
   */
  private backoffMs(): number {
    const base = Math.min(this.backoffMaxMs, this.backoffInitialMs * 2 ** (this.failuresInARow - 1));
    return base * (0.8 + Math.random() * 0.4);
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
   * Waits until everything buffered has been sent or dropped.
   *
   * When the server keeps failing, waits at most `giveUpAfterMs` from the later of the
   * first failure and the start of this call, then resolves with the spans still queued;
   * the loop goes on retrying them in the background.
   *
   * @returns Resolves once the buffer is empty and the loop is idle, or on giving up.
   *   Never rejects — a telemetry failure is warned about, not thrown.
   */
  async flush(): Promise<void> {
    const started = Date.now();
    while (this.buffer.length > 0 || this.draining) {
      if (this.failingSince !== null && Date.now() - Math.max(this.failingSince, started) >= this.giveUpAfterMs) {
        return;
      }
      // A referenced timer: the caller is waiting on this flush, so the process should too.
      const tick = delay(100, false);
      await Promise.race([this.draining ?? this.wake(), tick.done]);
      tick.cancel();
    }
  }

  /**
   * Flushes, then refuses further work. Idempotent.
   *
   * If the server is still failing when the flush gives up, what is left is dropped and
   * one warning says how many spans were lost.
   *
   * @returns Resolves once the final flush completes.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
    const left = this.queuedSpans + this.inFlightSpans;
    this.buffer = [];
    this.queuedSpans = 0;
    this.backoff?.cancel();
    if (left > 0) {
      console.warn(
        `[acruxcore] ${left} spans were not sent before the client closed: the trace server did not answer`,
      );
    }
  }
}

/**
 * Folds entries that share a trace id into one entry of the outgoing `traces[]` array,
 * preserving span order within each trace and the order the traces first appeared.
 *
 * Entries with no trace id are left alone — each one mints its own trace server-side,
 * so merging them would collapse unrelated activity into a single trace. Entries that
 * set `capturePayloads` differently stay apart too, because the flag covers a whole
 * entry: merging applied one entry's choice to the other's spans, which stored payloads
 * a caller had opted out of.
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
    const key = `${entry.traceId}\u0000${String(entry.capturePayloads)}`;
    const existing = byTraceId.get(key);
    if (!existing) {
      // Copied so merging never mutates what the caller handed to `enqueue`.
      const copy: TraceInput = { ...entry, spans: [...(entry.spans ?? [])] };
      byTraceId.set(key, copy);
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
