import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { IngestSpan, SpanKind, TraceInput, TraceOptions } from './types';

/**
 * `hub.traces.step` / `hub.traces.wrap` — trace your app's own steps, with model calls
 * nested under them.
 *
 * A step is one span the SDK writes for a piece of your code: a retrieval, a parse, a
 * whole request handler. The open step lives in an `AsyncLocalStorage`, so a step opened
 * inside another becomes its child, and a `gateway.chat()` or `gateway.stream()` made
 * inside a step joins that step's trace as its child too.
 *
 * Spans are held in memory and sent when the outermost ("root") step ends. That is
 * required, not an optimisation: `POST /traces` rejects a span whose `parentSpanId` is
 * not stored yet, and a step always ends after the calls inside it. A gateway call is the
 * exception — the gateway writes its `llm` span server-side at once, pointing at the
 * step's id, and the trace view links it when the step arrives.
 *
 * Mirrors `packages/sdk-python/src/acruxcore/steps.py`, including the fixes from the
 * PR #613 review. Two things go further, and the Python module does the same since:
 * reports are routed to their root by trace id rather than by the caller's context, and
 * a step still open when its root is sent keeps buffering its own subtree.
 *
 * Steps belong to the client that opened them: a call on another client inside a step
 * does not join it, since that client may hold another team's key. One root holds at
 * most `stepLimits.maxSpans` spans; past that, new spans are dropped and counted on the
 * root span as `droppedSpans`.
 */

/** Sends a finished trace report. The client hands it to its span queue. */
export type StepSink = (payload: TraceInput) => void;

/** Options for {@link TracesNamespace.step} and {@link TracesNamespace.wrap}. */
export interface StepOptions {
  /** Span kind shown in the trace view. Default `'chain'`. */
  kind?: SpanKind;
  /**
   * The step's input. For `step()` it defaults to nothing; for `wrap()` it defaults to
   * the wrapped function's arguments, as an array.
   */
  input?: unknown;
  /** `false` records no input, not even the arguments. Default `true`. */
  captureInput?: boolean;
  /** `false` records no output. Default `true`. */
  captureOutput?: boolean;
  /** Session for the trace. Only the first one set on a trace is kept. */
  sessionId?: string;
  /** Tags for the trace. A nested step's tags are added to the root's. */
  tags?: string[];
  /** Metadata for the trace, shallow-merged with the root's. */
  metadata?: Record<string, unknown>;
}

/**
 * The open step handed to a {@link TracesNamespace.step} callback.
 *
 * `traceId` is what to pass to `runToolLoop({ trace: { traceId } })` so the loop joins
 * this step's trace; `chat()` and `stream()` join it on their own.
 */
export interface Step {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  /**
   * What the step produced. Defaults to the callback's return value; set it to record
   * something else.
   */
  output?: unknown;
}

/** A `trace` option after it joined an open step: it may carry the step's name. */
export type JoinedTrace = TraceOptions & { defaultName?: string };

/**
 * Limits on what one root step holds in memory.
 *
 * `maxSpans` is half the span queue's default limit (2000), so a finished tree still fits
 * in the queue beside other traffic: an entry larger than the queue's limit is the first
 * one its drop-oldest rule discards.
 */
export const stepLimits = { maxSpans: 1000 };

/** What every step of one trace shares: the id, the name, and the spans not yet sent. */
interface Root {
  traceId: string;
  name: string;
  sink: StepSink;
  /** The client this trace belongs to (its span queue). Only that client's calls join. */
  owner: unknown;
  /** Spans dropped over the limit, and their ids, so a dropped span's children go too. */
  dropped: number;
  droppedIds: Set<string>;
  /** Every `parentSpanId` a buffered span names: such a step is kept over the limit. */
  parents: Set<string>;
  sessionId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  spans: IngestSpan[];
  /**
   * Routed reports that set `capturePayloads`. The flag covers a whole trace entry, so
   * they travel as entries of their own, after the spans they may point at.
   */
  riders: TraceInput[];
  /** Span ids of the steps still open on this trace. */
  open: Set<string>;
  /** Set once the root step has ended and its report was handed to the sink. */
  sent: boolean;
}

interface Frame {
  spanId: string;
  root: Root;
  /** The frame that was current when this one opened, whichever client it belongs to. */
  outer?: Frame;
}

const storage = new AsyncLocalStorage<Frame>();

/**
 * Roots that may still take spans, by trace id. A report is routed by the trace it names,
 * not by the caller's context, so a stream read after its step's callback returned, or a
 * call that passes the step's `traceId` by hand, still joins the buffer.
 */
const roots = new Map<string, Root>();

const UNSET: unique symbol = Symbol('unset');

/** The innermost open step of `owner`'s client in this context. */
function nearest(owner: unknown): Frame | undefined {
  let frame = storage.getStore();
  while (frame && frame.root.owner !== owner) frame = frame.outer;
  return frame;
}

/**
 * Fills a `chat()` / `stream()` call's `trace` option from the open step, if there is one.
 *
 * `trace: false` still opts out, and every key the caller set wins, so a call can report
 * to another trace from inside a step.
 *
 * @param trace - The caller's `trace` option.
 * @param owner - The calling client's span queue. Only that client's steps are joined.
 * @returns The option to use — unchanged outside a step of this client.
 */
export function joinStep(trace: boolean | TraceOptions | undefined, owner: unknown): boolean | JoinedTrace | undefined {
  const frame = nearest(owner);
  if (!frame || trace === false) return trace;
  const conf: JoinedTrace = typeof trace === 'object' ? { ...trace } : {};
  if (conf.traceId === undefined || conf.traceId === frame.root.traceId) {
    conf.traceId = frame.root.traceId;
    conf.parentSpanId ??= frame.spanId;
    // Offered, not asserted: the gateway applies it only when nothing named the trace yet.
    conf.defaultName ??= frame.root.name;
    if (frame.root.sessionId) conf.sessionId ??= frame.root.sessionId;
  }
  return conf;
}

/**
 * The open root step's name when `traceId` is a step's trace, else `undefined`.
 *
 * For calls that take an explicit `traceId` rather than joining the step: whichever call
 * creates the trace first names it, so they should offer the step's name.
 */
export function stepTraceName(traceId: string | undefined): string | undefined {
  return traceId ? roots.get(traceId)?.name : undefined;
}

/**
 * Hands a trace report to its root step instead of sending it now, when it may point at
 * a span that root has not sent yet.
 *
 * Called on every report the SDK makes. A BYO `llm` span inside a step points at that
 * step, so it must travel in the same request as the step, or the server rejects it.
 *
 * @param payload - A trace report about to be enqueued.
 * @param owner - The reporting client's span queue. Another client's root never takes it.
 * @returns `true` when a step took it; the caller must not send it then.
 */
export function routeReport(payload: TraceInput, owner: unknown): boolean {
  const root = payload.traceId ? roots.get(payload.traceId) : undefined;
  if (!root || root.owner !== owner) return false;
  const spans = [...(payload.spans ?? [])];
  // After the root was sent, only a report that hangs under a still-open step must
  // wait; anything else can go now, behind the root that is already queued.
  if (root.sent) {
    const held = openChecker(root, spans);
    if (!spans.some(held)) return false;
  }
  const kept = parentFirst(spans).filter((s) => keep(root, s));
  if (payload.capturePayloads !== undefined) {
    root.riders.push({ traceId: root.traceId, capturePayloads: payload.capturePayloads, spans: kept });
  } else {
    root.spans.push(...kept);
  }
  // Trace-level fields are merged the way a nested step's own are. The name is left
  // alone: the root step names the trace.
  mergeTraceContext(root, payload.tags, payload.metadata, payload.sessionId);
  return true;
}

/** Adds tags, metadata and a session to the trace rather than dropping them. */
function mergeTraceContext(
  root: Root,
  tags: string[] | undefined,
  metadata: Record<string, unknown> | undefined,
  sessionId: string | undefined,
): void {
  if (tags?.length) root.tags = [...new Set([...(root.tags ?? []), ...tags])];
  if (metadata && Object.keys(metadata).length) root.metadata = { ...root.metadata, ...metadata };
  if (sessionId && !root.sessionId) root.sessionId = sessionId;
}

/** Warned once per process: a trace passed the span limit. */
let warnedCap = false;

/**
 * Whether `span` may join the root's buffer; counts it as dropped when not. Over the limit
 * a span is still kept when it is the root step (`always`) or a step that buffered spans
 * point at — dropping either would orphan spans already kept.
 */
function keep(root: Root, span: IngestSpan, always = false): boolean {
  const buffered = root.spans.length + root.riders.reduce((n, r) => n + r.spans.length, 0);
  const parent = span.parentSpanId;
  if (always || root.parents.has(span.spanId)
    || (!(parent && root.droppedIds.has(parent)) && buffered < stepLimits.maxSpans)) {
    if (parent) root.parents.add(parent);
    return true;
  }
  root.dropped += 1;
  root.droppedIds.add(span.spanId);
  if (!warnedCap) {
    warnedCap = true;
    console.warn(`[acruxcore] a step trace passed ${stepLimits.maxSpans} spans — dropping the rest (counted as droppedSpans on its root span)`);
  }
  return false;
}

/**
 * A test for "this span hangs, through spans not yet sent, under a step still open", so
 * it cannot be sent before that step is. Builds the parent map once and remembers each
 * ancestor's answer, so checking a whole tree costs time in proportion to the tree.
 */
function openChecker(root: Root, extra: IngestSpan[] = []): (span: IngestSpan) => boolean {
  const parentOf = new Map<string, string | undefined>();
  for (const s of root.spans) parentOf.set(s.spanId, s.parentSpanId);
  for (const r of root.riders) for (const s of r.spans) parentOf.set(s.spanId, s.parentSpanId);
  for (const s of extra) parentOf.set(s.spanId, s.parentSpanId);
  const memo = new Map<string, boolean>();
  return (span) => {
    const path: string[] = [];
    let node = span.parentSpanId;
    let result = false;
    while (node) {
      const known = memo.get(node);
      if (known !== undefined) { result = known; break; }
      if (root.open.has(node)) { result = true; break; }
      if (path.includes(node)) break; // a cycle names no open step
      path.push(node);
      node = parentOf.get(node);
    }
    for (const seen of path) memo.set(seen, result);
    return result;
  };
}

/**
 * `spans` reordered so each parent comes before its children.
 *
 * Spans are recorded as they end, so a child is always ahead of its parent. That is fine
 * in one request, but the span queue splits a report over its 200-span cap, and a chunk
 * whose spans point at parents in a later chunk is rejected whole. Siblings keep their
 * order; a span whose parent is not in the list (one the gateway already stored) counts
 * as top level.
 */
function parentFirst(spans: IngestSpan[]): IngestSpan[] {
  const ids = new Set(spans.map((s) => s.spanId));
  const children = new Map<string | undefined, IngestSpan[]>();
  for (const s of spans) {
    const key = s.parentSpanId && ids.has(s.parentSpanId) ? s.parentSpanId : undefined;
    const list = children.get(key) ?? [];
    list.push(s);
    children.set(key, list);
  }
  const out: IngestSpan[] = [];
  const stack = [...(children.get(undefined) ?? [])].reverse();
  while (stack.length) {
    const span = stack.pop()!;
    out.push(span);
    stack.push(...[...(children.get(span.spanId) ?? [])].reverse());
  }
  return out;
}

/** Sink failures already warned about, by message — one warning per kind. */
const warnedSinkErrors = new Set<string>();

function send(root: Root, payload: TraceInput): void {
  try {
    root.sink(payload);
  } catch (err) {
    // Telemetry must never break the app, but a lost trace must not be silent either.
    const kind = err instanceof Error ? err.message : String(err);
    if (!warnedSinkErrors.has(kind)) {
      warnedSinkErrors.add(kind);
      console.warn(`[acruxcore] step trace could not be queued — dropping it: ${kind}`);
    }
  }
}

/**
 * Sends everything the root holds that no open step is still above.
 *
 * The first flush is the root's own report and names the trace. A step that was still
 * open then keeps buffering its subtree, and the next flush sends it when that step ends.
 */
function flush(root: Root): void {
  const first = !root.sent;
  const heldBack = openChecker(root);
  const ready: IngestSpan[] = [];
  const held: IngestSpan[] = [];
  for (const s of root.spans) (heldBack(s) ? held : ready).push(s);
  const readyRiders = root.riders.filter((r) => !r.spans.some(heldBack));
  root.riders = root.riders.filter((r) => !readyRiders.includes(r));
  root.spans = held;
  root.sent = true;
  if (root.open.size === 0) roots.delete(root.traceId);

  if (first || ready.length) {
    send(root, {
      traceId: root.traceId,
      ...(first ? { name: root.name } : {}),
      ...(root.sessionId ? { sessionId: root.sessionId } : {}),
      ...(root.tags?.length ? { tags: root.tags } : {}),
      ...(root.metadata && Object.keys(root.metadata).length ? { metadata: root.metadata } : {}),
      spans: parentFirst(ready),
    });
  }
  for (const rider of readyRiders) send(root, { ...rider, spans: parentFirst(rider.spans) });
}

/**
 * JSON-safe copy of `value`: a `bigint` becomes its decimal string, a repeated object
 * `'[Circular]'`, and anything else JSON cannot hold its `String()`.
 *
 * The span queue serialises a whole batch at once, so one unserialisable argument would
 * otherwise lose every span in that batch, not only this one.
 */
function jsonable(value: unknown): unknown {
  const stack: unknown[] = [];
  try {
    const text = JSON.stringify(value, function (this: unknown, _key, v: unknown) {
      if (typeof v === 'bigint') return v.toString();
      if (typeof v === 'function' || typeof v === 'symbol') return String(v);
      if (v && typeof v === 'object') {
        // `this` is the object holding `v`; unwinding to it keeps `stack` the ancestor path.
        while (stack.length && stack[stack.length - 1] !== this) stack.pop();
        if (stack.includes(v)) return '[Circular]';
        stack.push(v);
      }
      return v;
    });
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return String(value);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function isGenerator(value: unknown): value is Generator {
  return Object.prototype.toString.call(value) === '[object Generator]';
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator {
  return Object.prototype.toString.call(value) === '[object AsyncGenerator]';
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return !!value && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { then?: unknown }).then === 'function';
}

/** One step from open to close. Made fresh per call, so concurrent calls share nothing. */
class OpenStep implements Step {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly frame: Frame;
  private explicitOutput: unknown = UNSET;
  private readonly parentSpanId?: string;
  private readonly startTime = new Date().toISOString();
  private closed = false;

  get output(): unknown {
    return this.explicitOutput === UNSET ? undefined : this.explicitOutput;
  }

  set output(value: unknown) {
    this.explicitOutput = value;
  }

  constructor(
    name: string,
    private readonly options: StepOptions,
    sink: StepSink,
    private readonly input: unknown,
    owner: unknown,
  ) {
    const outer = storage.getStore();
    const parent = nearest(owner);
    // A parent whose root was already sent and closed is gone from the map; the new step
    // still nests under it, and its own report follows the parent's in the queue.
    const root: Root = parent?.root ?? {
      traceId: randomUUID(), name, sink, owner, spans: [], riders: [], open: new Set(), sent: false,
      dropped: 0, droppedIds: new Set(), parents: new Set(),
      sessionId: options.sessionId, tags: options.tags, metadata: options.metadata,
    };
    if (parent) mergeTraceContext(root, options.tags, options.metadata, options.sessionId);
    if (!roots.has(root.traceId)) roots.set(root.traceId, root);
    this.name = name;
    this.traceId = root.traceId;
    this.spanId = randomUUID();
    this.parentSpanId = parent?.spanId;
    this.frame = { spanId: this.spanId, root, ...(outer ? { outer } : {}) };
    root.open.add(this.spanId);
  }

  close(error: unknown, hasError: boolean, returned: unknown = UNSET): void {
    if (this.closed) return;
    this.closed = true;
    const root = this.frame.root;
    const output = this.explicitOutput !== UNSET ? this.explicitOutput : returned;
    const span: IngestSpan = {
      spanId: this.spanId,
      name: this.name,
      kind: this.options.kind ?? 'chain',
      status: hasError ? 'error' : 'ok',
      startTime: this.startTime,
      endTime: new Date().toISOString(),
      ...(this.parentSpanId ? { parentSpanId: this.parentSpanId } : {}),
      ...(this.options.captureInput !== false && this.input !== undefined ? { input: jsonable(this.input) } : {}),
      ...(this.options.captureOutput !== false && output !== UNSET && output !== undefined
        ? { output: jsonable(output) }
        : {}),
      ...(hasError ? { error: errorText(error) } : {}),
      ...(!this.parentSpanId && root.dropped ? { attributes: { droppedSpans: root.dropped } } : {}),
    };
    root.open.delete(this.spanId);
    if (keep(root, span, !this.parentSpanId)) root.spans.push(span);
    if (!this.parentSpanId || root.sent) {
      // Back in the map if an earlier flush removed it, so reports under a step that is
      // still open keep finding it.
      roots.set(root.traceId, root);
      flush(root);
    }
  }
}

/**
 * Runs `fn` as one step and closes the step when it settles.
 *
 * A promise result keeps the step open until it settles. A generator result keeps it open
 * until the generator finishes, and makes it the open step only while the generator's own
 * code runs — otherwise the consumer's calls between items would be filed under it.
 *
 * @param name - The span's name; for the outermost step, the trace's too.
 * @param options - Kind, capture flags and trace-level fields.
 * @param sink - Where the finished root's report goes.
 * @param owner - The client's span queue: only this client's calls join the step.
 * @param input - The step's input, before `captureInput` is applied.
 * @param fn - The step's code.
 * @param generatorKind - From {@link generatorKindOf}; worked out from `fn` when omitted.
 * @returns What `fn` returns. A generator function's call returns a wrapped generator.
 */
export function runAsStep<T>(
  name: string,
  options: StepOptions,
  sink: StepSink,
  owner: unknown,
  input: unknown,
  fn: (step: Step) => T,
  generatorKind: GeneratorKind = generatorKindOf(fn),
): T {
  if (generatorKind) return wrapGenerator(name, options, sink, owner, input, fn, generatorKind) as T;
  const step = new OpenStep(name, options, sink, input, owner);
  let result: T;
  try {
    result = storage.run(step.frame, () => fn(step));
  } catch (err) {
    step.close(err, true);
    throw err;
  }
  if (isThenable(result)) {
    return Promise.resolve(result).then(
      (value) => { step.close(undefined, false, value); return value; },
      (err: unknown) => { step.close(err, true); throw err; },
    ) as T;
  }
  if (isGenerator(result) || isAsyncGenerator(result)) {
    // A function that returns a generator it did not create with `function*` itself.
    step.close(undefined, false);
    return result;
  }
  step.close(undefined, false, result);
  return result;
}

/** Whether a function is a `function*` or an `async function*`. */
export type GeneratorKind = 'sync' | 'async' | undefined;

/**
 * `'sync'` for a `function*`, `'async'` for an `async function*`, else `undefined`. Their
 * bodies run only when the result is iterated, so the step must open then, not at the call.
 *
 * @param fn - Any value; a non-function gives `undefined`.
 * @returns The kind of generator function `fn` is, if any.
 */
export function generatorKindOf(fn: unknown): GeneratorKind {
  const kind = (fn as { constructor?: { name?: string } } | undefined)?.constructor?.name;
  return kind === 'GeneratorFunction' ? 'sync' : kind === 'AsyncGeneratorFunction' ? 'async' : undefined;
}

/**
 * Closes the step of a wrapped generator that was dropped part-way, without `return()`.
 * JS runs no code when a generator is abandoned, so without this its step stayed open for
 * good: the root stayed in `roots`, and every span under the step was held back forever.
 * The held value is the step's box, never the generator, or the generator could not be
 * collected.
 */
const abandoned = new FinalizationRegistry<{ step?: OpenStep }>((box) => box.step?.close(undefined, false));

/**
 * Calls a generator function and returns a generator that is one step: opened on the
 * first `next()`, closed when it finishes, throws, is closed early by `break`, or is
 * dropped and garbage-collected.
 */
function wrapGenerator(
  name: string,
  options: StepOptions,
  sink: StepSink,
  owner: unknown,
  input: unknown,
  fn: (step: Step) => unknown,
  kind: 'sync' | 'async',
): Generator | AsyncGenerator {
  const box: { step?: OpenStep } = {};
  let inner: Generator | AsyncGenerator | undefined;
  const begin = (): Generator | AsyncGenerator => {
    if (!inner) {
      const opened = (box.step = new OpenStep(name, options, sink, input, owner));
      inner = storage.run(opened.frame, () => fn(opened)) as Generator | AsyncGenerator;
    }
    return inner;
  };
  const settle = <R extends IteratorResult<unknown>>(r: R): R => {
    if (r.done) box.step?.close(undefined, false);
    return r;
  };
  const fail = (err: unknown): never => {
    box.step?.close(err, true);
    throw err;
  };

  if (kind === 'async') {
    const call = async (op: (g: AsyncGenerator) => Promise<IteratorResult<unknown>>) => {
      const g = begin() as AsyncGenerator;
      try {
        return settle(await storage.run(box.step!.frame, () => op(g)));
      } catch (err) {
        return fail(err);
      }
    };
    const wrapped: AsyncGenerator = {
      next: (v?: unknown) => call((g) => g.next(v)),
      // An early `break` before the first item never opened the step: nothing to record.
      return: (v?: unknown) => (inner ? call((g) => g.return(v)) : Promise.resolve({ done: true, value: v })),
      throw: (e?: unknown) => call((g) => g.throw(e)),
      [Symbol.asyncIterator]() { return this; },
    } as unknown as AsyncGenerator;
    abandoned.register(wrapped, box);
    return wrapped;
  }

  const call = (op: (g: Generator) => IteratorResult<unknown>) => {
    const g = begin() as Generator;
    try {
      return settle(storage.run(box.step!.frame, () => op(g)));
    } catch (err) {
      return fail(err);
    }
  };
  const wrapped: Generator = {
    next: (v?: unknown) => call((g) => g.next(v)),
    return: (v?: unknown) => (inner ? call((g) => g.return(v)) : { done: true, value: v }),
    throw: (e?: unknown) => call((g) => g.throw(e)),
    [Symbol.iterator]() { return this; },
  } as unknown as Generator;
  abandoned.register(wrapped, box);
  return wrapped;
}
