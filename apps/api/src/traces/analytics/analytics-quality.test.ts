import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent, type AuthedAgent } from '../../test-utils';

const app = createApp();

/**
 * Ingests three one-span traces through POST /traces, costing $0.001, $0.002 and $0.010,
 * plus a second span on the cheapest trace so a trace's cost is a sum, not one span.
 *
 * @returns The stored trace ids, cheapest first.
 */
async function seedThreeTraces(owner: AuthedAgent, day: string): Promise<string[]> {
  const span = (id: string, costUsd: number, at: number) => ({
    spanId: id,
    name: 'answer',
    kind: 'llm',
    status: 'ok',
    model: 'gpt-4o-mini',
    usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    costUsd,
    startTime: `${day}T10:00:0${at}.000Z`,
    endTime: `${day}T10:00:0${at}.100Z`,
  });
  await owner.agent
    .post('/api/v1/traces')
    .send({
      traces: [
        { name: 'cheap', spans: [span('a1', 0.0004, 1), span('a2', 0.0006, 2)] },
        { name: 'mid', spans: [span('b1', 0.002, 3)] },
        { name: 'dear', spans: [span('c1', 0.01, 4)] },
      ],
    })
    .expect(200);
  const traces = await prisma.trace.findMany({ where: { teamId: owner.teamId }, select: { id: true, name: true } });
  return ['cheap', 'mid', 'dear'].map((n) => traces.find((t) => t.name === n)!.id);
}

/**
 * Creates an online-eval rule through the API, after registering the judge model the API
 * requires, so the rule is one the product itself would accept.
 *
 * @returns The created rule's id.
 */
async function createRule(owner: AuthedAgent, name: string): Promise<string> {
  const conn = await owner.agent
    .post('/api/v1/gateway/connections')
    .send({ provider: 'openai', label: 'openai test', apiKey: 'sk-test-abcdAB12', config: {} })
    .expect(201);
  await owner.agent
    .post('/api/v1/gateway/models')
    .send({ publicName: 'gpt-4o-mini', upstreamModel: 'gpt-4o-mini', credentialId: conn.body.id })
    .expect(201);
  const rule = await owner.agent
    .post('/api/v1/eval-rules')
    .send({ name, criteria: 'Is the reply polite?', sampleRate: 1, judgeModel: 'gpt-4o-mini' })
    .expect(201);
  return rule.body.id;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('cost per trace (issue #588 item 6)', () => {
  it('returns the median and p99 of the summed cost of each trace in the window', async () => {
    const owner = await authedAgent(app);
    await seedThreeTraces(owner, '2026-06-10');

    const res = await owner.agent.get('/api/v1/traces/analytics?from=2026-06-01&to=2026-07-01').expect(200);

    // Trace costs are 0.001 (two spans), 0.002 and 0.010. percentile_cont interpolates,
    // so p99 sits 98% of the way from the second to the third: 0.002 + 0.98 * 0.008.
    expect(res.body.costPerTrace.p50).toBeCloseTo(0.002, 12);
    expect(res.body.costPerTrace.p99).toBeCloseTo(0.00984, 12);
  });

  it('leaves a trace with no priced span out, instead of counting it as $0', async () => {
    const owner = await authedAgent(app);
    await seedThreeTraces(owner, '2026-06-10');
    // Three traces of a model with no price: their spans carry no cost at all.
    const unpriced = (n: string, at: number) => ({
      name: n,
      spans: [
        {
          spanId: n,
          name: 'answer',
          kind: 'llm',
          status: 'ok',
          model: 'my-own-finetune',
          usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
          startTime: `2026-06-10T11:00:0${at}.000Z`,
          endTime: `2026-06-10T11:00:0${at}.100Z`,
        },
      ],
    });
    await owner.agent
      .post('/api/v1/traces')
      .send({ traces: [unpriced('u1', 1), unpriced('u2', 2), unpriced('u3', 3)] })
      .expect(200);

    const res = await owner.agent.get('/api/v1/traces/analytics?from=2026-06-01&to=2026-07-01').expect(200);

    // Only the three priced traces count, so the result matches the test above.
    expect(res.body.costPerTrace.p50).toBeCloseTo(0.002, 12);
    expect(res.body.costPerTrace.p99).toBeCloseTo(0.00984, 12);
  });

  it('is null when no trace falls in the window', async () => {
    const owner = await authedAgent(app);

    const res = await owner.agent.get('/api/v1/traces/analytics?from=2026-06-01&to=2026-07-01').expect(200);

    expect(res.body.costPerTrace).toEqual({ p50: null, p99: null });
  });
});

describe('GET /traces/analytics/scores (issue #588 item 5)', () => {
  it('counts thumbs feedback and online-eval verdicts per rule, with a daily trend', async () => {
    const owner = await authedAgent(app);
    const today = new Date().toISOString().slice(0, 10);
    const [cheap, mid, dear] = await seedThreeTraces(owner, today);

    // Two thumbs up, one thumbs down, and a comment with no thumb, which counts as neither.
    for (const [traceId, rating] of [[cheap, 1], [mid, 1], [dear, -1]] as const) {
      await owner.agent.post(`/api/v1/traces/${traceId}/feedback`).send({ rating }).expect(201);
    }
    await owner.agent.post(`/api/v1/traces/${dear}/feedback`).send({ comment: 'fine' }).expect(201);

    const ruleId = await createRule(owner, 'polite');
    // The judge itself is an external model call, so its verdicts are written directly.
    const spans = await prisma.span.findMany({ where: { teamId: owner.teamId }, orderBy: { startedAt: 'asc' } });
    const verdicts: Array<[number | null, boolean | null]> = [[90, true], [80, true], [20, false], [null, null]];
    for (const [i, [score, passed]] of verdicts.entries()) {
      await prisma.evalRuleScore.create({
        data: { teamId: owner.teamId, ruleId, traceId: spans[i].traceId, spanId: spans[i].id, score, passed },
      });
    }

    // Another team's rule and verdicts never leak in.
    const stranger = await authedAgent(app);
    await createRule(stranger, 'polite');

    const res = await owner.agent.get('/api/v1/traces/analytics/scores').expect(200);

    expect(res.body.feedback).toEqual({ up: 2, down: 1 });
    expect(res.body.rules).toEqual([
      { ruleId, name: 'polite', scored: 3, passed: 2, failed: 1, avgScore: 190 / 3 },
    ]);
    // Summed over every day, so the assertion holds when UTC midnight passes mid-test.
    type Day = { up: number; down: number; passed: number; failed: number };
    const sum = (res.body.days as Day[]).reduce(
      (a, d) => ({ up: a.up + d.up, down: a.down + d.down, passed: a.passed + d.passed, failed: a.failed + d.failed }),
      { up: 0, down: 0, passed: 0, failed: 0 },
    );
    expect(sum).toEqual({ up: 2, down: 1, passed: 2, failed: 1 });
  });

  it('reports the last day the window includes, not the exclusive end', async () => {
    const owner = await authedAgent(app);

    const res = await owner.agent.get('/api/v1/traces/analytics/scores?from=2026-10-04&to=2026-10-07').expect(200);

    // `to` is exclusive: the window holds 4, 5 and 6 October.
    expect(res.body.from).toBe('2026-10-04');
    expect(res.body.to).toBe('2026-10-06');
  });

  it('rejects a window whose start is after its end', async () => {
    const owner = await authedAgent(app);

    await owner.agent.get('/api/v1/traces/analytics/scores?from=2026-07-01&to=2026-06-01').expect(400);
  });
});
