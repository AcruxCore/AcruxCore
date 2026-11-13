import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';

/**
 * Trace content search (`q`) scans captured payloads with `ILIKE '%q%'`, which no index
 * serves. These tests drive the real search through the API and check its three bounds:
 * the term's length, how long one statement may run, and how many searches one team may
 * run at once, so one team's searches cannot hold the shared connection pool.
 */

const app = createApp();

/**
 * A term, at the 256-character ceiling, that Postgres' pattern matcher spends work
 * proportional to its length on for every byte it scans.
 */
const SLOW_TERM = `a${'_'.repeat(254)}b`;

const ENV_KEYS = ['TRACE_SEARCH_STATEMENT_TIMEOUT_MS', 'TRACE_SEARCH_MAX_CONCURRENT_PER_TEAM'] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Signs up a team and stores one trace whose spans each capture `kb` KB of input text. */
async function teamWithLargePayload(spans = 1, kb = 300) {
  const ctx = await authedAgent(app);
  const startTime = new Date().toISOString();
  const res = await ctx.agent
    .post('/api/v1/traces')
    .send({
      traces: [
        {
          name: 'big-input',
          capturePayloads: true,
          spans: Array.from({ length: spans }, (_, i) => ({
            spanId: `s${i}`,
            name: 'llm',
            startTime,
            input: 'a'.repeat(kb * 1000),
          })),
        },
      ],
    })
    .expect(200);
  return { ...ctx, traceId: res.body.traceIds[0] as string };
}

describe('trace content search bounds', () => {
  it('rejects a search term longer than 256 characters with 400', async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get('/api/v1/traces').query({ q: 'x'.repeat(257) }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    await agent.get('/api/v1/traces').query({ q: 'x'.repeat(256) }).expect(200);
    // The feedback feed shares the filter vocabulary, so it has the same ceiling.
    await agent.get('/api/v1/traces/feedback').query({ q: 'x'.repeat(257) }).expect(400);
    // Session search matches `session_id` with the same unindexed ILIKE.
    await agent.get('/api/v1/sessions').query({ q: 'x'.repeat(257) }).expect(400);
  });

  it('stops a search that runs past the statement timeout and answers with a typed error', async () => {
    const { agent, traceId } = await teamWithLargePayload();
    // The feedback feed searches traces that have feedback, so give the big one some.
    await agent.post(`/api/v1/traces/${traceId}/feedback`).send({ rating: 1 }).expect(201);
    process.env.TRACE_SEARCH_STATEMENT_TIMEOUT_MS = '50';

    const res = await agent.get('/api/v1/traces').query({ q: SLOW_TERM, q_in: 'input' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SEARCH_TIMEOUT');

    const feed = await agent.get('/api/v1/traces/feedback').query({ q: SLOW_TERM, q_in: 'input' });
    expect(feed.status).toBe(422);
    expect(feed.body.error.code).toBe('SEARCH_TIMEOUT');

    // A search that fits the budget still works, and so does the plain list.
    process.env.TRACE_SEARCH_STATEMENT_TIMEOUT_MS = '5000';
    const ok = await agent.get('/api/v1/traces').query({ q: 'big-input', q_in: 'name' }).expect(200);
    expect(ok.body.data).toHaveLength(1);
  });

  it('refuses searches beyond the per-team concurrency cap while another team is still served', async () => {
    // Enough captured text that one search of team A's runs for about a second.
    const a = await teamWithLargePayload(3, 1000);
    const b = await teamWithLargePayload();
    process.env.TRACE_SEARCH_MAX_CONCURRENT_PER_TEAM = '1';
    process.env.TRACE_SEARCH_STATEMENT_TIMEOUT_MS = '3000';

    const search = (agent: typeof a.agent) =>
      agent.get('/api/v1/traces').query({ q: SLOW_TERM, q_in: 'input' }).then((r) => r);

    // Team A starts one slow search, then a second while the first still runs.
    const first = search(a.agent);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const [second, other] = await Promise.all([
      search(a.agent),
      b.agent.get('/api/v1/traces').query({ q: 'big-input', q_in: 'name' }),
    ]);
    const firstRes = await first;

    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe('RATE_LIMITED');
    expect([200, 422]).toContain(firstRes.status);
    // Team B's search is not held back by team A's.
    expect(other.status).toBe(200);
    expect(other.body.data).toHaveLength(1);

    // Once team A's search has finished, its slot is free again.
    await a.agent.get('/api/v1/traces').query({ q: 'big-input', q_in: 'name' }).expect(200);
  });
});
