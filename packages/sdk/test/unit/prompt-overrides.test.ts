import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { acruxcore } from '../../src/client';
import { pinPrompts, pinnedVersion } from '../../src/index';
import type { LocalExample } from '../../src/eval-types';

/**
 * Prompt overrides, `experiments.compareLocal` and the judge scorer.
 *
 * `fetch` is replaced by a fake that serves several local runs at once plus render,
 * `/prompt-versions`, judge and commit, so each test asserts on what the SDK sent. The
 * live run against a real server is the tutorial script under
 * `scripts/tutorials/improve-a-rag-agent-from-feedback`.
 */
describe('prompt overrides', () => {
  const BASE = 'http://localhost:3000/api/v1';
  const TEMPLATES: Record<number, string> = { 1: 'production template', 7: 'candidate template' };
  const examples = [0, 1, 2].map((i) => ({
    id: `00000000-0000-4000-8000-00000000000${i}`,
    input: { q: `question ${i}` },
    criteria: `rule ${i}`,
    expected: null,
    history: null,
  }));
  let hub: acruxcore;
  let runs: Map<string, { created: Record<string, unknown>; stored: Map<string, Record<string, unknown>> }>;
  let renders: Array<Record<string, unknown>>;
  let versionQueries: string[];
  let judgeCalls: Array<Record<string, unknown>>;
  // A server from before pinned renders drops the unknown `version` key.
  let ignoresPin: boolean;

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  beforeEach(() => {
    hub = new acruxcore({ apiKey: 'test-key', baseUrl: BASE, maxRetries: 0 });
    runs = new Map();
    renders = [];
    versionQueries = [];
    judgeCalls = [];
    ignoresPin = false;
    let nextRun = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const [path, query = ''] = url.replace(BASE, '').split('?');
        const body = init.body ? JSON.parse(String(init.body)) : {};
        if (path === '/experiments/local') {
          const runId = `11111111-1111-4111-8111-00000000000${nextRun++}`;
          runs.set(runId, { created: body, stored: new Map() });
          return json(201, {
            experiment_id: `exp-${runId}`,
            run_id: runId,
            cell_key: `${body.name}|local`,
            url: `http://app/evaluations/runs/${runId}`,
            examples,
          });
        }
        if (path === '/traces') return json(202, { accepted: 1, traceIds: [body.traces[0].traceId] });
        if (path.endsWith('/render')) {
          renders.push(body);
          const version = ignoresPin ? 1 : (body.version as number | undefined) ?? 1;
          if (!(version in TEMPLATES)) {
            return json(404, { error: { code: 'NOT_FOUND', message: `Version ${version} not found for prompt "support-agent"` } });
          }
          return json(200, {
            messages: [{ role: 'system', content: TEMPLATES[version] }],
            tools: [],
            toolResolutions: [],
            model: null,
            versionId: `v${version}-id`,
            versionNumber: version,
          });
        }
        if (path === '/prompt-versions') {
          versionQueries.push(query);
          const version = ignoresPin ? 1 : Number(new URLSearchParams(query).get('version') ?? 1);
          return json(200, { id: `v${version}-id`, promptId: 'p1', versionNumber: version, messages: [], variables: [], model: null });
        }
        if (path.endsWith('/judge')) {
          judgeCalls.push({ runId: path.split('/')[2], ...body });
          const passed = JSON.stringify(body.output).includes('candidate');
          return json(200, { score: passed ? 90 : 20, passed, reason: passed ? 'follows the rule' : 'ignores it', judge_trace_id: 't' });
        }
        if (path.endsWith('/commit')) {
          return json(201, { promptName: 'support-agent', created: true, version: { id: 'v7-id', versionNumber: 7, messages: [], model: null } });
        }
        if (path.endsWith('/results')) {
          const run = runs.get(path.split('/')[2])!;
          for (const r of body.results) run.stored.set(r.example_id, r);
          return json(200, { written: body.results.length, completed: run.stored.size, total: examples.length });
        }
        if (path.endsWith('/finish')) return json(200, { id: path.split('/')[2], status: 'succeeded' });
        return json(404, { error: { message: `unexpected ${path}` } });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const runNamed = (name: string) => [...runs.values()].find((r) => r.created['name'] === name)!;

  it('pinPrompts renders the pinned version, only for that prompt, and caches it apart', async () => {
    const plain = await hub.prompts.render('support-agent', 'production', { q: 'x' });
    const [pinned, other] = await pinPrompts({ 'support-agent': 7 }, () =>
      Promise.all([
        hub.prompts.render('support-agent', 'production', { q: 'x' }),
        hub.prompts.render('other-prompt', 'production', { q: 'x' }),
      ]),
    );
    const after = await hub.prompts.render('support-agent', 'production', { q: 'x' });

    expect(plain.messages[0].content).toBe('production template');
    expect(pinned.messages[0].content).toBe('candidate template');
    expect(pinned.versionNumber).toBe(7);
    expect(other.versionNumber).toBe(1);
    expect(after.messages[0].content).toBe('production template');
    expect(renders.map((r) => r['version'])).toEqual([undefined, 7, undefined]);
  });

  it('a pinned render the server did not honour throws instead of running the alias', async () => {
    ignoresPin = true;
    await pinPrompts({ 'support-agent': 7 }, async () => {
      const first = hub.prompts.render('support-agent', 'production', { q: 'old server' });
      await expect(first).rejects.toThrow('pinned to version 7');
      await expect(first).rejects.toMatchObject({ code: 'API_ERROR' });
      // Nothing was cached, so a retry asks the server again.
      await expect(hub.prompts.render('support-agent', 'production', { q: 'old server' })).rejects.toThrow();
    });
    expect(renders.map((r) => r.version)).toEqual([7, 7]);
  });

  it('a pinned version that does not exist names the server reason', async () => {
    const render = pinPrompts({ 'support-agent': 999 }, () =>
      hub.prompts.render('support-agent', 'production', { q: 'x' }),
    );
    await expect(render).rejects.toThrow('Version 999 not found');
    await expect(render).rejects.toMatchObject({ statusCode: 404 });
  });

  it('getByAlias asks for the pinned version by number, still naming the alias', async () => {
    const version = await pinPrompts({ 'support-agent': 7 }, () => hub.prompts.getByAlias('support-agent', 'production'));
    const unpinned = await hub.prompts.getByAlias('support-agent', 'production');
    expect(version.versionNumber).toBe(7);
    // The alias goes too, so the server refuses a misspelled one as render does.
    expect(versionQueries[0]).toBe('name=support-agent&alias=production&version=7');
    expect(unpinned.versionNumber).toBe(1);
    expect(versionQueries[1]).toBe('name=support-agent&alias=production');
  });

  it('a pinned getByAlias the server did not honour throws instead of returning the alias version', async () => {
    ignoresPin = true;
    await pinPrompts({ 'support-agent': 7 }, async () => {
      const first = hub.prompts.getByAlias('support-agent', 'production');
      await expect(first).rejects.toThrow('pinned to version 7');
      await expect(first).rejects.toMatchObject({ code: 'API_ERROR' });
    });
  });

  it('rejects a version that is not a positive integer', () => {
    expect(() => pinPrompts({ 'support-agent': 0 }, () => 1)).toThrow(/must be a version number/);
  });

  it('compareLocal runs variants at the same time, each with its own pins, graded by the judge', async () => {
    let inFlight = 0;
    let peak = 0;
    const agent = async (input: Record<string, unknown>) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      const rendered = await hub.prompts.render('support-agent', 'production', { q: input['q'] });
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return rendered.messages[0].content;
    };

    const cmp = await hub.experiments.compareLocal('ds-1', {
      task: agent,
      scorers: [hub.experiments.judge('gpt-4o-mini')],
      variants: { production: null, 'candidate-B': { 'support-agent': 7 } },
      metadata: { git_sha: 'abc' },
    });

    expect(Object.keys(cmp.runs)).toEqual(['production', 'candidate-B']);
    const base = runNamed('production');
    const cand = runNamed('candidate-B');
    expect(new Set([...base.stored.values()].map((r) => r['output']))).toEqual(new Set(['production template']));
    expect(new Set([...cand.stored.values()].map((r) => r['output']))).toEqual(new Set(['candidate template']));
    expect(peak).toBeGreaterThan(1);
    expect(cand.created['metadata']).toEqual({ git_sha: 'abc', prompt_overrides: { 'support-agent': 7 } });
    expect(base.created['metadata']).toEqual({ git_sha: 'abc' });
    for (const [runId, run] of runs) {
      const ids = judgeCalls.filter((c) => c['runId'] === runId).map((c) => c['example_id']);
      expect(new Set(ids)).toEqual(new Set(run.stored.keys()));
    }
    expect(cmp.runs['candidate-B'].summary['judge'].passRate).toBe(1);
    expect(cmp.runs['production'].summary['judge'].passRate).toBe(0);
    expect([...cand.stored.values()][0]['scores']).toEqual([{ name: 'judge', score: 90, passed: true, reason: 'follows the rule' }]);
    expect(cmp.compareUrls).toEqual({
      'candidate-B': `${cmp.runs['production'].url}/compare?target_run=${cmp.runs['candidate-B'].runId}`,
    });
  });

  it('the judge sends the judge prompt version it is given, from every variant', async () => {
    await hub.experiments.compareLocal('ds-1', {
      task: async (input: Record<string, unknown>) =>
        (await hub.prompts.render('support-agent', 'production', { q: input['q'] })).messages[0].content,
      scorers: [hub.experiments.judge('gpt-4o-mini', { judgePromptId: 'jp-1', judgePromptVersion: 3 })],
      variants: { production: null, 'candidate-B': { 'support-agent': 7 } },
    });
    expect(judgeCalls.length).toBe(examples.length * 2);
    expect(new Set(judgeCalls.map((c) => `${c['judge_prompt_id']}@${c['judge_prompt_version']}`))).toEqual(new Set(['jp-1@3']));
  });

  it('judgePromptVersion needs judgePromptId', () => {
    expect(() => hub.experiments.judge('gpt-4o-mini', { judgePromptVersion: 3 })).toThrow(/judgePromptVersion needs judgePromptId/);
  });

  it('pinnedVersion reads the pin, for an app that sends a gateway prompt reference', () => {
    expect(pinnedVersion('support-agent')).toBeUndefined();
    pinPrompts({ 'support-agent': 7 }, () => {
      expect(pinnedVersion('support-agent')).toBe(7);
      expect(pinnedVersion('other')).toBeUndefined();
    });
  });

  it('a judge scorer called outside a local run says so', async () => {
    const judge = hub.experiments.judge('gpt-4o-mini');
    const example: LocalExample = { id: 'e', input: {}, criteria: null, expected: null, history: null };
    await expect(
      Promise.resolve(judge({ output: 'x', expected: null, input: {}, criteria: null, example })),
    ).rejects.toThrow(/only works inside experiments.runLocal/);
  });

  it('commitCandidate returns what to pin', async () => {
    const result = await hub.runs.commitCandidate('run-1', 'cand-1');
    expect([result.promptName, result.version.versionNumber, result.created]).toEqual(['support-agent', 7, true]);
  });

  it('compareLocal needs at least one variant', async () => {
    await expect(hub.experiments.compareLocal('ds', { task: (x) => x, variants: {} })).rejects.toThrow(/at least one variant/);
  });
});
