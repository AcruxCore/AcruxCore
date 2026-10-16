import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { acruxcore } from '../../src/client';
import { acruxcoreError } from '../../src/error';
import { localRunTuning } from '../../src/local-experiment';
import type { LocalTaskContext, Score } from '../../src/eval-types';

/**
 * `experiments.runLocal` — the SDK runs the task and scorers, the server stores the run.
 *
 * `fetch` is replaced by a small fake of the three local-run endpoints plus trace
 * ingest, so what is under test is what the SDK sends on the wire and what it returns.
 */
describe('experiments.runLocal', () => {
  const BASE = 'http://localhost:3000/api/v1';
  const RUN_ID = '11111111-1111-4111-8111-111111111111';
  let hub: acruxcore;

  interface FakeOptions {
    exampleCount?: number;
    /** Status for every `POST /traces`. */
    traceStatus?: number;
    /** Statuses for successive `POST /runs/:id/results` calls; 200 once exhausted. */
    resultStatuses?: number[];
    /** Status for every `POST /runs/:id/finish`; 200 by default. */
    finishStatus?: number;
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const exampleId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

  const examples = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: exampleId(i),
      input: { question: `q${i}`, n: i },
      criteria: i === 0 ? 'Be exact.' : null,
      expected: { answer: `a${i}` },
      history: i === 0 ? [{ role: 'user', content: 'earlier turn' }, { role: 'assistant', content: 'earlier reply' }] : null,
    }));

  /** Installs the fake server. */
  function fakeServer(opts: FakeOptions = {}) {
    const resultStatuses = [...(opts.resultStatuses ?? [])];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const path = url.replace(BASE, '');
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      if (path === '/experiments/local') {
        return json(201, {
          experiment_id: 'exp-1',
          run_id: RUN_ID,
          cell_key: `${body.name}|local`,
          url: `http://app/evaluations/runs/${RUN_ID}`,
          examples: examples(opts.exampleCount ?? 2),
        });
      }
      if (path === '/traces') {
        const status = opts.traceStatus ?? 202;
        return json(status, status < 300 ? { accepted: 1, traceIds: [body.traces[0].traceId] } : { error: { message: 'nope' } });
      }
      if (path === `/runs/${RUN_ID}/results`) {
        const status = resultStatuses.shift() ?? 200;
        return status === 200
          ? json(200, { written: body.results.length, completed: 0, total: 0 })
          : json(status, { error: { code: 'X', message: `status ${status}` } });
      }
      if (path === `/runs/${RUN_ID}/finish`) {
        if (opts.finishStatus && opts.finishStatus !== 200) {
          return json(opts.finishStatus, { error: { code: 'X', message: `status ${opts.finishStatus}` } });
        }
        return json(200, {
          id: RUN_ID,
          kind: 'local',
          status: body.error ? 'failed' : 'succeeded',
          error: body.error ?? null,
          results: { total: 0, succeeded: 0, errored: 0 },
        });
      }
      return json(404, { error: { message: `unexpected ${path}` } });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  const calls = () => (global.fetch as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
  const bodiesTo = (suffix: string) =>
    calls()
      .filter(([url]) => url.endsWith(suffix))
      .map(([, init]) => JSON.parse(String(init.body)));
  const uploaded = () => bodiesTo('/results').flatMap((b) => b.results);

  beforeEach(() => {
    hub = new acruxcore({ apiKey: 'test-key', baseUrl: BASE, maxRetries: 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('creates the run, runs a sync task with full ctx, and finishes it', async () => {
    fakeServer();
    const seen: LocalTaskContext[] = [];
    const result = await hub.experiments.runLocal('ds-1', {
      name: 'v2',
      model: 'glm-5.3',
      metadata: { git_sha: 'abc' },
      task: (input, ctx) => {
        seen.push(ctx);
        return `answer to ${String(input.question)}`;
      },
    });

    expect(bodiesTo('/experiments/local')).toEqual([
      { dataset_id: 'ds-1', name: 'v2', model: 'glm-5.3', metadata: { git_sha: 'abc' } },
    ]);
    const first = seen.find((c) => c.id === exampleId(0))!;
    expect(first.input).toEqual({ question: 'q0', n: 0 });
    expect(first.expected).toEqual({ answer: 'a0' });
    expect(first.criteria).toBe('Be exact.');
    expect(first.traceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.trace).toEqual({ traceId: first.traceId, name: 'v2' });
    expect(new Set(seen.map((c) => c.traceId)).size).toBe(2);

    expect(result.runId).toBe(RUN_ID);
    expect(result.experimentId).toBe('exp-1');
    expect(result.url).toBe(`http://app/evaluations/runs/${RUN_ID}`);
    expect(result.status).toBe('succeeded');
    expect(result.items.map((i) => i.output)).toEqual(['answer to q0', 'answer to q1']);
    expect(result.items[0].traceId).toBe(first.traceId);
    expect(bodiesTo('/finish')).toEqual([{}]);
  });

  it('awaits an async task and ingests one chain span per example into its trace', async () => {
    fakeServer();
    const result = await hub.experiments.runLocal('ds-1', {
      name: 'v2',
      task: async (input) => {
        await new Promise((r) => setTimeout(r, 5));
        return { echoed: input.n };
      },
    });

    expect(result.items.map((i) => i.output)).toEqual([{ echoed: 0 }, { echoed: 1 }]);
    const traces = bodiesTo('/traces').map((b) => b.traces[0]);
    expect(traces).toHaveLength(2);
    const t0 = traces.find((t) => t.spans[0].attributes.example_id === exampleId(0));
    expect(t0.traceId).toBe(result.items[0].traceId);
    expect(t0.spans[0]).toMatchObject({
      name: 'v2',
      kind: 'chain',
      status: 'ok',
      input: { question: 'q0', n: 0 },
      output: { echoed: 0 },
      attributes: { experiment_run_id: RUN_ID, example_id: exampleId(0) },
    });
    expect(new Date(t0.spans[0].endTime).getTime()).toBeGreaterThanOrEqual(new Date(t0.spans[0].startTime).getTime());
    expect(uploaded().find((r) => r.example_id === exampleId(0)).trace_id).toBe(t0.traceId);
  });

  it('normalizes every scorer return type and sends scores as 0–100', async () => {
    fakeServer({ exampleCount: 1 });
    const scorerArgs: unknown[] = [];
    const result = await hub.experiments.runLocal('ds-1', {
      name: 'v2',
      task: () => 'out',
      scorers: [
        function isExact(args) {
          scorerArgs.push(args);
          return true;
        },
        function similarity() {
          return 0.7;
        },
        function judged(): Score {
          return { score: 0.4, passed: true, reason: 'close enough' };
        },
        function many(): Score[] {
          return [{ name: 'items', score: 1 }, { name: 'total', score: null, reason: 'no total' }];
        },
        function tooBig() {
          return 70;
        },
        () => false,
      ],
    });

    expect(scorerArgs[0]).toEqual({
      output: 'out',
      expected: { answer: 'a0' },
      input: { question: 'q0', n: 0 },
      criteria: 'Be exact.',
      example: examples(1)[0],
    });
    expect(result.items[0].scores).toEqual([
      { name: 'isExact', score: 1, passed: true, reason: null },
      { name: 'similarity', score: 0.7, passed: true, reason: null },
      { name: 'judged', score: 0.4, passed: true, reason: 'close enough' },
      { name: 'items', score: 1, passed: true, reason: null },
      { name: 'total', score: null, passed: null, reason: 'no total' },
      expect.objectContaining({ name: 'tooBig', score: null, passed: null }),
      { name: 'scorer_5', score: 0, passed: false, reason: null },
    ]);
    expect(result.items[0].scores[5].reason).toContain('outside 0–1');

    const wire = uploaded()[0].scores;
    expect(wire.map((s: { name: string; score: number | null }) => [s.name, s.score])).toEqual([
      ['isExact', 100],
      ['similarity', 70],
      ['judged', 40],
      ['items', 100],
      ['total', null],
      ['tooBig', null],
      ['scorer_5', 0],
    ]);
    expect(bodiesTo('/experiments/local')[0]).not.toHaveProperty('primary_score');
    expect(result.summary.similarity).toEqual({ mean: 0.7, passRate: 1, scored: 1 });
    expect(result.summary.total).toEqual({ mean: null, passRate: null, scored: 0 });
  });

  it('records a throwing scorer as a null score and keeps running the others', async () => {
    fakeServer();
    const result = await hub.experiments.runLocal('ds-1', {
      name: 'v2',
      primaryScore: 'ok',
      task: () => 'out',
      scorers: [
        function broken() {
          throw new TypeError('cannot read x');
        },
        async function ok() {
          return 1;
        },
      ],
    });

    expect(bodiesTo('/experiments/local')[0].primary_score).toBe('ok');
    for (const item of result.items) {
      expect(item.scores).toEqual([
        { name: 'broken', score: null, passed: null, reason: 'TypeError: cannot read x' },
        { name: 'ok', score: 1, passed: true, reason: null },
      ]);
    }
    expect(result.status).toBe('succeeded');
  });

  it('turns a throwing task into an errored result without calling scorers', async () => {
    fakeServer();
    const scorer = vi.fn(() => true);
    const result = await hub.experiments.runLocal('ds-1', {
      name: 'v2',
      task: (input) => {
        if (input.n === 1) throw new RangeError('boom');
        return 'fine';
      },
      scorers: [scorer],
    });

    const failed = result.items.find((i) => i.exampleId === exampleId(1))!;
    expect(failed).toMatchObject({ error: 'RangeError: boom', output: null, scores: [] });
    expect(scorer).toHaveBeenCalledTimes(1);
    const wire = uploaded().find((r) => r.example_id === exampleId(1));
    expect(wire).toMatchObject({ error: 'RangeError: boom', scores: [], output: null });
    const span = bodiesTo('/traces').map((b) => b.traces[0].spans[0]).find((s) => s.attributes.example_id === exampleId(1));
    expect(span).toMatchObject({ status: 'error', error: 'RangeError: boom' });
    expect(span).not.toHaveProperty('output');
  });

  it('uploads 45 results in three batches: 20, 20 and 5', async () => {
    fakeServer({ exampleCount: 45 });
    const result = await hub.experiments.runLocal('ds-1', { name: 'v2', task: (i) => i.n, concurrency: 7 });

    expect(bodiesTo('/results').map((b) => b.results.length)).toEqual([20, 20, 5]);
    expect(new Set(uploaded().map((r) => r.example_id)).size).toBe(45);
    expect(result.items).toHaveLength(45);
    // finish comes after every upload
    const urls = calls().map(([u]) => u);
    expect(urls.lastIndexOf(`${BASE}/runs/${RUN_ID}/finish`)).toBeGreaterThan(urls.lastIndexOf(`${BASE}/runs/${RUN_ID}/results`));
  });

  it('retries a failed upload, then succeeds', async () => {
    fakeServer({ resultStatuses: [503] });
    const result = await hub.experiments.runLocal('ds-1', { name: 'v2', task: () => 'x' });
    expect(bodiesTo('/results')).toHaveLength(2);
    expect(result.status).toBe('succeeded');
  });

  it('finishes the run with the error and re-throws when uploads keep failing', async () => {
    fakeServer({ resultStatuses: [400] });
    const err = await hub.experiments.runLocal('ds-1', { name: 'v2', task: () => 'x' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(acruxcoreError);
    expect((err as acruxcoreError).statusCode).toBe(400);
    expect(bodiesTo('/results')).toHaveLength(1); // a 400 is not retried
    const finish = bodiesTo('/finish');
    expect(finish).toHaveLength(1);
    expect(finish[0].error).toContain('acruxcoreError: acruxcore API error 400');
  });

  it('sends trace_id null and warns once when span ingest fails', async () => {
    fakeServer({ exampleCount: 3, traceStatus: 500 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await hub.experiments.runLocal('ds-1', { name: 'v2', task: () => 'x' });

    expect(uploaded().map((r) => r.trace_id)).toEqual([null, null, null]);
    expect(result.items.every((i) => i.traceId === null)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('falls back to String(output) for an output JSON cannot represent', async () => {
    fakeServer({ exampleCount: 1 });
    const result = await hub.experiments.runLocal('ds-1', { name: 'v2', task: () => BigInt(42) });
    expect(uploaded()[0].output).toBe('42');
    expect(result.items[0].output).toBe(BigInt(42));
  });

  it('rejects bad options before sending anything', async () => {
    const fetchMock = fakeServer();
    await expect(hub.experiments.runLocal('ds-1', { name: '', task: () => 1 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(hub.experiments.runLocal('ds-1', { name: 'v2', task: () => 1, concurrency: 0 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('PR #602 review fixes', () => {
    const original = { ...localRunTuning };
    afterEach(() => Object.assign(localRunTuning, original));

    it('keeps every results request under the 1 MB body limit when outputs are large', async () => {
      fakeServer({ exampleCount: 20 });
      const big = 'x'.repeat(55_000);
      await hub.experiments.runLocal('ds-1', { name: 'v2', task: () => big });

      const sizes = calls()
        .filter(([url]) => url.endsWith('/results'))
        .map(([, init]) => Buffer.byteLength(String(init.body), 'utf8'));
      expect(Math.max(...sizes)).toBeLessThan(1_000_000);
      expect(new Set(uploaded().map((r) => r.example_id)).size).toBe(20);
    });

    it('uploads finished results on a timer, so a slow run keeps showing progress before 20 are done', async () => {
      localRunTuning.flushIntervalMs = 20;
      fakeServer({ exampleCount: 3 });
      await hub.experiments.runLocal('ds-1', {
        name: 'v2',
        concurrency: 1,
        task: async () => {
          await new Promise((r) => setTimeout(r, 40));
          return 'x';
        },
      });
      expect(bodiesTo('/results').map((b) => b.results.length)).toEqual([1, 1, 1]);
    });

    it("passes the example's history to the task", async () => {
      fakeServer({ exampleCount: 2 });
      const seen: LocalTaskContext[] = [];
      await hub.experiments.runLocal('ds-1', { name: 'v2', task: (_i, ctx) => seen.push(ctx) });
      const first = seen.find((c) => c.id === exampleId(0))!;
      expect(first.history).toEqual([{ role: 'user', content: 'earlier turn' }, { role: 'assistant', content: 'earlier reply' }]);
      expect(seen.find((c) => c.id === exampleId(1))!.history).toBeNull();
    });

    it('never produces a duplicate score name, even when a rename collides with a real name', async () => {
      fakeServer({ exampleCount: 1 });
      const exact = () => true;
      const exactAgain = () => true;
      Object.defineProperty(exactAgain, 'name', { value: 'exact' });
      const exact2 = () => true;
      Object.defineProperty(exact2, 'name', { value: 'exact_2' });
      await hub.experiments.runLocal('ds-1', { name: 'v2', task: () => 'x', scorers: [exact, exactAgain, exact2] });

      const names = uploaded()[0].scores.map((s: { name: string }) => s.name);
      expect(new Set(names).size).toBe(names.length);
      expect(names).toContain('exact');
      expect(names).toContain('exact_2');
    });

    it('names the entries of a list-returning scorer like the Python SDK: x_1, x_2', async () => {
      fakeServer({ exampleCount: 1 });
      function multi(): Score[] {
        return [{ score: 1 }, { score: 0 }];
      }
      await hub.experiments.runLocal('ds-1', { name: 'v2', task: () => 'x', scorers: [multi] });
      expect(uploaded()[0].scores.map((s: { name: string }) => s.name)).toEqual(['multi_1', 'multi_2']);
    });

    it('warns when the run cannot be closed after an upload failure, instead of hiding it', async () => {
      fakeServer({ resultStatuses: [400], finishStatus: 500 });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const err = await hub.experiments.runLocal('ds-1', { name: 'v2', task: () => 'x' }).catch((e: unknown) => e);

      expect((err as acruxcoreError).statusCode).toBe(400); // the upload error is still the one thrown
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`could not mark run ${RUN_ID} as failed`));
    });
  });
});
