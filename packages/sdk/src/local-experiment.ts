import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { acruxcoreError } from './error';
import { pinPrompts, validateOverrides } from './prompt-overrides';
import { sleep } from './fetch';
import type { NamespaceHost } from './host';
import type {
  CompareLocalOptions,
  JudgeScorerOptions,
  LocalComparison,
  LocalExample,
  LocalRunItem,
  LocalRunResult,
  LocalScore,
  LocalScoreSummary,
  RunDetailDto,
  RunLocalOptions,
  Score,
  Scorer,
  ScorerReturn,
} from './eval-types';

/**
 * The run whose example is being scored, so a judge scorer knows where to send its call
 * without the caller passing a run id it does not have yet.
 */
const currentRunId = new AsyncLocalStorage<string>();

/** Results per `POST /runs/:id/results` call. The server accepts up to 100. */
export const LOCAL_RESULT_BATCH_SIZE = 20;

/**
 * Byte budget for one results request. The API's JSON body limit is 1 MB and one
 * output may be up to 64 KB, so 20 large outputs would not fit in one request.
 */
const BATCH_BYTE_BUDGET = 800_000;

/**
 * Timing knobs of a local run. Internal: exported so tests can shorten them.
 *
 * `flushIntervalMs` — finished results are uploaded at least this often, even when
 * fewer than a batch are waiting. The stale-run sweep fails a running run that has
 * stored no new result for 120 minutes, so a run of slow examples must keep
 * uploading as it goes, not only every 20 examples.
 *
 * @internal
 */
export const localRunTuning = { flushIntervalMs: 60_000 };

/** Examples run at once when the caller names no `concurrency`. */
const DEFAULT_CONCURRENCY = 4;

/** Upload attempts per batch. Safe to repeat: the server replaces an example's result. */
const UPLOAD_ATTEMPTS = 3;

/** First backoff between upload attempts; doubles each time. */
const UPLOAD_BACKOFF_MS = 250;

/** The server's cap on one result's serialized output (64 KB). */
const MAX_OUTPUT_BYTES = 64 * 1024;

/** The server's cap on an error or reason string. */
const MAX_TEXT_CHARS = 5000;

/** The server's cap on a score name. */
const MAX_NAME_CHARS = 100;

/** The create response, as the server sends it (snake_case). */
interface CreateLocalResponse {
  experiment_id: string;
  run_id: string;
  cell_key: string;
  url: string | null;
  examples: LocalExample[];
}

/** One result on the wire. Scores are 0–100 here. */
interface WireResult {
  example_id: string;
  output: unknown;
  trace_id: string | null;
  error?: string;
  scores: Array<{ name: string; score: number | null; passed: boolean | null; reason: string | null }>;
}

/**
 * Runs the caller's app code over a dataset and stores the outcome as one run.
 *
 * The SDK does the work the server cannot: it calls `task` once per frozen example,
 * grades each output with the caller's scorers, records one `chain` span per example
 * so every result opens a trace, and uploads results in batches as they complete.
 * The server stores them as an ordinary run, so the run list, report, drill-down and
 * Compare read it like any other.
 *
 * A task or scorer error is recorded and never stops the run. Only a failure the run
 * cannot recover from — an upload that keeps failing — stops it; the run is then
 * finished as failed with that error before the error is re-thrown, so it never sits
 * in `running` until the stale-run sweep.
 *
 * @param host - The client to send requests through.
 * @param datasetId - The dataset whose examples are frozen into the run.
 * @param options - The task, scorers, run name and limits. See {@link RunLocalOptions}.
 * @returns The run's ids, URL, final status, every item and a per-score summary.
 * @throws {acruxcoreError} VALIDATION_ERROR before any request, for a missing `task`
 *   or `name`, a non-function scorer, or a `concurrency` that is not a positive integer.
 * @throws {acruxcoreError} API_ERROR / NETWORK_ERROR when the create call fails, or when
 *   an upload still fails after its retries (the run is finished as failed first).
 */
export async function runLocalExperiment<O>(
  host: NamespaceHost,
  datasetId: string,
  options: RunLocalOptions<O>,
): Promise<LocalRunResult<O>> {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  validateOptions(options, concurrency);
  const overrides = validateOverrides(options.promptOverrides);
  const hasOverrides = Object.keys(overrides).length > 0;
  const scorers = options.scorers ?? [];
  const scorerNames = scorers.map((fn, i) => (fn.name ? fn.name : `scorer_${i}`));

  const createBody: Record<string, unknown> = { dataset_id: datasetId, name: options.name };
  if (options.model !== undefined) createBody['model'] = options.model;
  if (options.primaryScore !== undefined) createBody['primary_score'] = options.primaryScore;
  if (options.metadata !== undefined || hasOverrides) {
    // Stored with the run, so its page says which versions it ran on.
    createBody['metadata'] = { ...(options.metadata ?? {}), ...(hasOverrides ? { prompt_overrides: overrides } : {}) };
  }
  const createRes = await host._request('POST', '/experiments/local', createBody, 'creating local experiment');
  const created = (await host._parseJsonOrThrow(createRes, 'creating local experiment')) as CreateLocalResponse;
  const runId = created.run_id;

  const items: LocalRunItem<O>[] = new Array<LocalRunItem<O>>(created.examples.length);
  const pending: WireResult[] = [];
  let uploads: Promise<void> = Promise.resolve();
  let uploadError: unknown;
  let ingestWarned = false;
  let lastFlushAt = Date.now();

  // Uploads are chained so they go out one at a time, in completion order. A failed
  // one records the error so every worker stops picking up new examples.
  const queueUpload = (batch: WireResult[]): void => {
    uploads = uploads.then(async () => {
      if (uploadError !== undefined) return;
      try {
        await uploadBatch(host, runId, batch);
      } catch (err) {
        uploadError = err;
      }
    });
  };

  // Moves every waiting result into requests that fit both the count cap and the byte budget.
  const flushPending = (): void => {
    lastFlushAt = Date.now();
    for (const batch of splitIntoBatches(pending.splice(0, pending.length))) queueUpload(batch);
  };

  // Every example runs inside the run's async context: the pins reach the app's renders,
  // and the run id reaches a judge scorer, without leaking into a second run alongside.
  const runOne = (index: number): Promise<void> =>
    currentRunId.run(runId, () => pinPrompts(overrides, () => runOneExample(index)));

  const runOneExample = async (index: number): Promise<void> => {
    const example = created.examples[index];
    const traceId = randomUUID();
    const startTime = new Date().toISOString();
    let output: O | null = null;
    let error: string | null = null;
    try {
      output = await options.task(example.input, {
        id: example.id,
        input: example.input,
        criteria: example.criteria ?? null,
        expected: example.expected ?? null,
        history: example.history ?? null,
        traceId,
        trace: { traceId, name: options.name },
      });
    } catch (err) {
      error = describeError(err);
    }
    const endTime = new Date().toISOString();

    const scores = error === null ? await runScorers(scorers, scorerNames, output as O, example) : [];
    const safeOutput = error === null ? toWireOutput(output) : null;

    const traced = await ingestSpan(host, {
      traceId,
      runName: options.name,
      runId,
      example,
      output: safeOutput,
      error,
      startTime,
      endTime,
    });
    if (!traced && !ingestWarned) {
      ingestWarned = true;
      console.warn(
        `acruxcore: could not record the trace span for local run ${runId}; affected results are uploaded without a trace.`,
      );
    }

    items[index] = {
      exampleId: example.id,
      input: example.input,
      expected: example.expected ?? null,
      output: error === null ? output : null,
      error,
      traceId: traced ? traceId : null,
      scores,
    };
    pending.push({
      example_id: example.id,
      output: safeOutput,
      trace_id: traced ? traceId : null,
      ...(error !== null ? { error: truncate(error) } : {}),
      scores: scores.map((s) => ({
        name: s.name,
        score: s.score === null ? null : Math.round(s.score * 1e6) / 1e4,
        passed: s.passed,
        reason: s.reason === null ? null : truncate(s.reason),
      })),
    });
    if (pending.length >= LOCAL_RESULT_BATCH_SIZE || Date.now() - lastFlushAt >= localRunTuning.flushIntervalMs) {
      flushPending();
    }
  };

  let loopError: unknown;
  let detail: RunDetailDto | undefined;
  try {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (uploadError === undefined && next < created.examples.length) {
        await runOne(next++);
      }
    };
    const workerCount = Math.min(concurrency, created.examples.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    if (pending.length > 0) flushPending();
    await uploads;
    if (uploadError !== undefined) throw uploadError;
  } catch (err) {
    loopError = err;
    throw err;
  } finally {
    const finishBody = loopError !== undefined ? { error: truncate(describeError(loopError)) } : {};
    try {
      const finishRes = await host._request('POST', `/runs/${encodeURIComponent(runId)}/finish`, finishBody, 'finishing local run');
      detail = (await host._parseJsonOrThrow(finishRes, 'finishing local run')) as RunDetailDto;
    } catch (finishErr) {
      // The loop's own error is the one the caller needs; a finish failure on top of
      // it would hide it, so it is reported as a warning. Without a loop error, the
      // finish failure is the error.
      if (loopError === undefined) throw finishErr;
      console.warn(
        `acruxcore: could not mark run ${runId} as failed: ${describeError(finishErr)}. ` +
          'The server fails it after it stops making progress.',
      );
    }
  }

  return {
    runId,
    experimentId: created.experiment_id,
    url: created.url,
    status: detail?.status ?? 'succeeded',
    items: items.filter((item): item is LocalRunItem<O> => item !== undefined),
    summary: summarize(items),
  };
}

/**
 * Runs the same task once per variant, all at the same time, one run each, so a store or
 * database that changes over time changes for every variant alike.
 *
 * @param host - The client to send requests through.
 * @param datasetId - The dataset every variant runs over.
 * @param options - `runLocal`'s options, with `variants` in place of `name`.
 * @returns One run per variant, and Compare per example links from the first variant.
 * @throws {acruxcoreError} VALIDATION_ERROR for no variants or an invalid version; the
 *   first run error otherwise, after every variant has settled.
 */
export async function compareLocalVariants<O>(
  host: NamespaceHost,
  datasetId: string,
  options: CompareLocalOptions<O>,
): Promise<LocalComparison<O>> {
  const names = Object.keys(options.variants ?? {});
  if (names.length === 0) {
    throw new acruxcoreError(
      "acruxcore: compareLocal needs at least one variant, e.g. { production: null }.",
      'VALIDATION_ERROR',
    );
  }
  for (const name of names) validateOverrides(options.variants[name]);
  const { variants, ...shared } = options;
  const settled = await Promise.allSettled(
    names.map((name) =>
      runLocalExperiment(host, datasetId, { ...shared, name, promptOverrides: variants[name] ?? undefined }),
    ),
  );
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason;
  const runs: Record<string, LocalRunResult<O>> = {};
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') runs[names[i]] = r.value;
  });
  const base = runs[names[0]];
  const compareUrls: Record<string, string> = {};
  if (base.url) {
    for (const name of names.slice(1)) compareUrls[name] = `${base.url}/compare?target_run=${runs[name].runId}`;
  }
  return { runs, compareUrls };
}

/**
 * A scorer that grades each output with the LLM judge on the server, against the
 * example's criteria and the dataset's overall feedback as frozen when the run started.
 *
 * @param host - The client to send requests through.
 * @param model - The judge model, a name under Gateway → Models.
 * @param options - An optional judge prompt (and version of it) and score name.
 * @returns A scorer for `runLocal`'s `scorers`.
 * @throws {acruxcoreError} VALIDATION_ERROR when `model` is empty, or
 *   `judgePromptVersion` is given without `judgePromptId`.
 */
export function makeJudgeScorer<O>(host: NamespaceHost, model: string, options: JudgeScorerOptions = {}): Scorer<O> {
  if (!model) {
    throw new acruxcoreError("acruxcore: judge() needs a judge model, e.g. judge('gpt-4o-mini').", 'VALIDATION_ERROR');
  }
  if (options.judgePromptVersion !== undefined && options.judgePromptId === undefined) {
    throw new acruxcoreError(
      'acruxcore: judgePromptVersion needs judgePromptId: it names a version of that judge prompt.',
      'VALIDATION_ERROR',
    );
  }
  const name = options.name ?? 'judge';
  const judge = async ({ output, example }: { output: O; example: LocalExample }): Promise<Score> => {
    const runId = currentRunId.getStore();
    if (runId === undefined) {
      throw new acruxcoreError('acruxcore: a judge scorer only works inside experiments.runLocal.', 'VALIDATION_ERROR');
    }
    const body: Record<string, unknown> = { example_id: example.id, output: toWireOutput(output), model };
    if (options.judgePromptId !== undefined) body['judge_prompt_id'] = options.judgePromptId;
    if (options.judgePromptVersion !== undefined) body['judge_prompt_version'] = options.judgePromptVersion;
    const res = await host._request('POST', `/runs/${encodeURIComponent(runId)}/judge`, body, 'judging local output');
    const verdict = (await host._parseJsonOrThrow(res, 'judging local output')) as {
      score: number | null;
      passed: boolean | null;
      reason: string | null;
    };
    return { name, score: verdict.score === null ? null : verdict.score / 100, passed: verdict.passed, reason: verdict.reason };
  };
  Object.defineProperty(judge, 'name', { value: name });
  return judge;
}

/** Rejects options that would fail later, before anything is created on the server. */
function validateOptions<O>(options: RunLocalOptions<O>, concurrency: number): void {
  if (typeof options?.task !== 'function') {
    throw new acruxcoreError('acruxcore: runLocal needs a `task` function.', 'VALIDATION_ERROR');
  }
  if (typeof options.name !== 'string' || options.name.trim().length === 0) {
    throw new acruxcoreError('acruxcore: runLocal needs a `name` for the run, e.g. "v2".', 'VALIDATION_ERROR');
  }
  if ((options.scorers ?? []).some((fn) => typeof fn !== 'function')) {
    throw new acruxcoreError('acruxcore: every entry in `scorers` must be a function.', 'VALIDATION_ERROR');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new acruxcoreError('acruxcore: `concurrency` must be a positive integer.', 'VALIDATION_ERROR');
  }
}

/**
 * Runs every scorer on one output and flattens what they return into named scores.
 * Names stay unique within the result (the server rejects duplicates): see
 * {@link uniqueNames}.
 */
async function runScorers<O>(
  scorers: Scorer<O>[],
  names: string[],
  output: O,
  example: LocalExample,
): Promise<LocalScore[]> {
  const scores: LocalScore[] = [];
  for (let i = 0; i < scorers.length; i++) {
    let returned: ScorerReturn;
    try {
      returned = await scorers[i]({
        output,
        expected: example.expected ?? null,
        input: example.input,
        criteria: example.criteria ?? null,
        example,
      });
    } catch (err) {
      scores.push({ name: names[i], score: null, passed: null, reason: describeError(err) });
      continue;
    }
    scores.push(...normalizeScores(returned, names[i]));
  }
  return uniqueNames(scores);
}

/**
 * Renames repeats to `x_2`, `x_3`, … skipping any suffix that is already a name in
 * the result, so a rename never collides with a real score called `x_2`. The Python
 * SDK applies the same rule, so both name the same scorers the same way.
 */
function uniqueNames(scores: LocalScore[]): LocalScore[] {
  const clip = (name: string) => name.slice(0, MAX_NAME_CHARS);
  const reserved = new Set(scores.map((s) => clip(s.name)));
  const used = new Set<string>();
  return scores.map((s) => {
    let name = clip(s.name);
    if (used.has(name)) {
      let n = 2;
      let candidate: string;
      do {
        const suffix = `_${n++}`;
        candidate = `${name.slice(0, MAX_NAME_CHARS - suffix.length)}${suffix}`;
      } while (used.has(candidate) || reserved.has(candidate));
      name = candidate;
    }
    used.add(name);
    return { ...s, name };
  });
}

/**
 * Turns one scorer's return value into named 0–1 scores. Unnamed entries of a list
 * are `<scorer>_1`, `<scorer>_2`, …; a one-entry list keeps the scorer's name.
 */
function normalizeScores(returned: unknown, name: string): LocalScore[] {
  if (Array.isArray(returned)) {
    return returned.map((entry, i) => normalizeOne(entry, returned.length === 1 ? name : `${name}_${i + 1}`));
  }
  return [normalizeOne(returned, name)];
}

/** Turns one returned value into a named score; anything unusable becomes a null score with a reason. */
function normalizeOne(value: unknown, defaultName: string): LocalScore {
  if (typeof value === 'boolean') {
    return { name: defaultName, score: value ? 1 : 0, passed: value, reason: null };
  }
  if (typeof value === 'number') {
    return fromNumber(value, defaultName, null, null);
  }
  if (typeof value === 'object' && value !== null && 'score' in value) {
    const s = value as Score;
    const name = typeof s.name === 'string' && s.name.trim().length > 0 ? s.name.trim() : defaultName;
    const reason = typeof s.reason === 'string' ? s.reason : null;
    if (s.score === null) {
      return { name, score: null, passed: typeof s.passed === 'boolean' ? s.passed : null, reason };
    }
    if (typeof s.score === 'boolean') {
      return { name, score: s.score ? 1 : 0, passed: typeof s.passed === 'boolean' ? s.passed : s.score, reason };
    }
    if (typeof s.score === 'number') {
      return fromNumber(s.score, name, typeof s.passed === 'boolean' ? s.passed : null, reason);
    }
  }
  return {
    name: defaultName,
    score: null,
    passed: null,
    reason: `Scorer returned ${describeValue(value)}; expected a boolean, a number in 0–1, a Score object or a list of them.`,
  };
}

/** A 0–1 number as a score; an out-of-range or non-finite one is recorded as unscored, with why. */
function fromNumber(value: number, name: string, passed: boolean | null, reason: string | null): LocalScore {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    return {
      name,
      score: null,
      passed: null,
      reason: `Scorer returned ${value}, outside 0–1. Scores are 0–1; the SDK sends 0–100.${reason ? ` ${reason}` : ''}`,
    };
  }
  return { name, score: value, passed: passed ?? value >= 0.5, reason };
}

/** Short type description of an unusable scorer return, for its reason. */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `the string ${JSON.stringify(value.slice(0, 50))}`;
  return typeof value === 'object' ? 'an object without a `score`' : String(value);
}

/**
 * `"<ErrorName>: <message>"` for an Error; the value as a string otherwise. Never
 * empty: the finish endpoint rejects an empty `error`, which would hide the failure.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message ? `${err.name}: ${err.message}` : err.name || 'Error';
  return String(err) || 'Unknown error (an empty value was thrown)';
}

/** Cuts a string to the server's text cap. */
function truncate(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS - 1)}…` : text;
}

/**
 * The output as it can travel in JSON. A value JSON cannot represent (a function, a
 * BigInt, a cycle) becomes `String(output)`. An output past the server's 64 KB cap is
 * cut to a string under it, because one oversized result would fail its whole batch.
 */
function toWireOutput(output: unknown): unknown {
  if (output === undefined) return null;
  let json: string | undefined;
  try {
    json = JSON.stringify(output);
  } catch {
    json = undefined;
  }
  const value: unknown = json === undefined ? String(output) : output;
  const text = json ?? JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') <= MAX_OUTPUT_BYTES) return value;

  const marker = ' … [truncated by the SDK: output exceeded 64 KB]';
  let keep = Math.floor(MAX_OUTPUT_BYTES / 2);
  let cut = `${text.slice(0, keep)}${marker}`;
  while (Buffer.byteLength(JSON.stringify(cut), 'utf8') > MAX_OUTPUT_BYTES && keep > 0) {
    keep = Math.floor(keep / 2);
    cut = `${text.slice(0, keep)}${marker}`;
  }
  return cut;
}

/** Splits results into requests of at most {@link LOCAL_RESULT_BATCH_SIZE} results and {@link BATCH_BYTE_BUDGET} bytes. */
function splitIntoBatches(results: WireResult[]): WireResult[][] {
  const batches: WireResult[][] = [];
  let batch: WireResult[] = [];
  let bytes = 0;
  for (const result of results) {
    const size = Buffer.byteLength(JSON.stringify(result), 'utf8');
    if (batch.length > 0 && (batch.length >= LOCAL_RESULT_BATCH_SIZE || bytes + size > BATCH_BYTE_BUDGET)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(result);
    bytes += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/** What {@link ingestSpan} records for one example. */
interface SpanFacts {
  traceId: string;
  runName: string;
  runId: string;
  example: LocalExample;
  output: unknown;
  error: string | null;
  startTime: string;
  endTime: string;
}

/**
 * Records the example's `chain` span into its trace (creating the trace when the task
 * made no traced call). Never throws: a failed span costs the result its trace link,
 * not the result itself.
 *
 * @returns Whether the span was accepted.
 */
async function ingestSpan(host: NamespaceHost, facts: SpanFacts): Promise<boolean> {
  const span: Record<string, unknown> = {
    spanId: randomUUID(),
    name: facts.runName,
    kind: 'chain',
    status: facts.error === null ? 'ok' : 'error',
    startTime: facts.startTime,
    endTime: facts.endTime,
    input: facts.example.input,
    attributes: { experiment_run_id: facts.runId, example_id: facts.example.id },
  };
  if (facts.error === null) span['output'] = facts.output;
  else span['error'] = facts.error;
  const body = {
    traces: [
      {
        traceId: facts.traceId,
        name: facts.runName,
        metadata: { experiment_run_id: facts.runId, example_id: facts.example.id },
        spans: [span],
      },
    ],
  };
  try {
    const response = await host._request('POST', '/traces', body, 'reporting local run span');
    // Drain the body so the connection is released, whatever the status.
    await response.text().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Uploads one batch, retrying a network error, a 429 or a 5xx with backoff. A 4xx
 * other than 429 is thrown at once, because sending the same body again cannot fix it.
 */
async function uploadBatch(host: NamespaceHost, runId: string, batch: WireResult[]): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < UPLOAD_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(UPLOAD_BACKOFF_MS * 2 ** (attempt - 1));
    try {
      const response = await host._request(
        'POST',
        `/runs/${encodeURIComponent(runId)}/results`,
        { results: batch },
        'uploading local run results',
      );
      await host._parseJsonOrThrow(response, 'uploading local run results');
      return;
    } catch (err) {
      lastError = err;
      const status = err instanceof acruxcoreError ? err.statusCode : undefined;
      const retryable = status === undefined || status === 429 || status >= 500;
      if (!retryable) throw err;
    }
  }
  throw lastError;
}

/** Per-name mean and pass rate over every item's scores, ignoring null scores. */
function summarize<O>(items: Array<LocalRunItem<O> | undefined>): Record<string, LocalScoreSummary> {
  const totals = new Map<string, { sum: number; passed: number; scored: number }>();
  for (const item of items) {
    for (const s of item?.scores ?? []) {
      const t = totals.get(s.name) ?? { sum: 0, passed: 0, scored: 0 };
      if (s.score !== null) {
        t.sum += s.score;
        t.scored += 1;
        if (s.passed === true) t.passed += 1;
      }
      totals.set(s.name, t);
    }
  }
  const summary: Record<string, LocalScoreSummary> = {};
  for (const [name, t] of totals) {
    summary[name] = {
      mean: t.scored > 0 ? t.sum / t.scored : null,
      passRate: t.scored > 0 ? t.passed / t.scored : null,
      scored: t.scored,
    };
  }
  return summary;
}
