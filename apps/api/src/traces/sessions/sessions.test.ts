import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';

const app = createApp();

/** A window wide enough (2020–2030) to never clip a test's own dates by accident. */
const WIDE_RANGE = 'from=2020-01-01&to=2030-01-01';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Returns `{ startTime, endTime }` ISO strings anchored to the real clock at
 * call time, `msFromNow` milliseconds offset from "now" (negative = past).
 * Using the real clock (not hardcoded calendar dates) keeps the date-window
 * tests correct no matter when the suite actually runs.
 */
function at(msFromNow: number, durationMs = 1000): { startTime: string; endTime: string } {
  const start = Date.now() + msFromNow;
  return { startTime: new Date(start).toISOString(), endTime: new Date(start + durationMs).toISOString() };
}

/** Rewrites the caller's role in their own team so the viewer-read tests can run. */
async function setRole(
  userId: string,
  teamId: string,
  role: 'owner' | 'admin' | 'editor' | 'viewer',
): Promise<void> {
  await prisma.teamMember.update({ where: { userId_teamId: { userId, teamId } }, data: { role } });
}

/** Posts one trace (single llm span) via the real T2 ingestion endpoint. */
async function postTrace(
  agent: ReturnType<typeof request.agent>,
  opts: {
    sessionId?: string;
    name: string;
    startTime: string;
    endTime: string;
    totalTokens: number;
    costUsd: number;
    tags?: string[];
  },
): Promise<void> {
  await agent
    .post('/api/v1/traces')
    .send({
      traces: [
        {
          ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
          ...(opts.tags ? { tags: opts.tags } : {}),
          name: opts.name,
          spans: [
            {
              spanId: `sp-${Math.random().toString(36).slice(2)}`,
              name: opts.name,
              kind: 'llm',
              status: 'ok',
              startTime: opts.startTime,
              endTime: opts.endTime,
              model: 'gpt-4o-mini',
              provider: 'openai',
              usage: { promptTokens: opts.totalTokens, completionTokens: 0, totalTokens: opts.totalTokens },
              costUsd: opts.costUsd,
            },
          ],
        },
      ],
    })
    .expect(200);
}

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE
    span_payloads, spans, traces, team_trace_settings,
    audit_log, api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /api/v1/sessions — rollups', () => {
  it('lists distinct sessions with hand-summed rollups, newest activity first', async () => {
    const { agent } = await authedAgent(app);
    const t1 = at(-10 * DAY_MS);
    const t2 = at(-9 * DAY_MS);
    const t3 = at(-8 * DAY_MS);
    await postTrace(agent, { sessionId: 's1', name: 'a', ...t1, totalTokens: 100, costUsd: 0.001 });
    await postTrace(agent, { sessionId: 's1', name: 'b', ...t2, totalTokens: 200, costUsd: 0.002 });
    await postTrace(agent, { sessionId: 's1', name: 'c', ...t3, totalTokens: 300, costUsd: 0.003 });
    await postTrace(agent, { sessionId: 's2', name: 'd', ...at(-5 * DAY_MS), totalTokens: 50, costUsd: 0 });
    await postTrace(agent, { sessionId: 's2', name: 'e', ...at(-4 * DAY_MS), totalTokens: 70, costUsd: 0 });

    const res = await agent.get(`/api/v1/sessions?${WIDE_RANGE}`).expect(200);

    expect(res.body.total).toBe(2);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(20);
    expect(res.body.data.map((s: { sessionId: string }) => s.sessionId)).toEqual(['s2', 's1']);

    const s1 = res.body.data.find((s: { sessionId: string }) => s.sessionId === 's1');
    expect(s1.traceCount).toBe(3);
    expect(s1.totalTokens).toBe(600);
    expect(s1.totalCostUsd).toBeCloseTo(0.006, 6);
    // firstAt/lastAt are MIN/MAX(started_at) — compare exactly against the
    // instants actually posted (t1 = earliest, t3 = latest), not a recomputed clock.
    expect(new Date(s1.firstAt).toISOString()).toBe(new Date(t1.startTime).toISOString());
    expect(new Date(s1.lastAt).toISOString()).toBe(new Date(t3.startTime).toISOString());
  });

  it('excludes traces that have no session_id', async () => {
    const { agent } = await authedAgent(app);
    await postTrace(agent, { sessionId: 's1', name: 'grouped', ...at(-1 * DAY_MS), totalTokens: 10, costUsd: 0 });
    await postTrace(agent, { name: 'ungrouped', ...at(-1 * DAY_MS + 1000), totalTokens: 10, costUsd: 0 });

    const res = await agent.get(`/api/v1/sessions?${WIDE_RANGE}`).expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data.map((s: { sessionId: string }) => s.sessionId)).toEqual(['s1']);
  });
});

describe('GET /api/v1/sessions — date window', () => {
  it('with no from/to, scopes to [now-30d, now) — an older-than-30d trace is excluded', async () => {
    const { agent } = await authedAgent(app);
    await postTrace(agent, { sessionId: 'recent', name: 'x', ...at(-15 * DAY_MS), totalTokens: 1, costUsd: 0 });
    await postTrace(agent, { sessionId: 'ancient', name: 'x', ...at(-40 * DAY_MS), totalTokens: 1, costUsd: 0 });

    const res = await agent.get('/api/v1/sessions').expect(200);
    expect(res.body.data.map((s: { sessionId: string }) => s.sessionId)).toEqual(['recent']);
  });

  it('from-only: to defaults to now, and the supplied from is used verbatim (not the 30d default)', async () => {
    const { agent } = await authedAgent(app);
    // Under the default 30-day window both of these would be "recent enough".
    // Supplying from = 10 days ago should exclude the one at 20 days ago.
    await postTrace(agent, { sessionId: 'in-range', name: 'x', ...at(-5 * DAY_MS), totalTokens: 1, costUsd: 0 });
    await postTrace(agent, { sessionId: 'too-old-for-explicit-from', name: 'x', ...at(-20 * DAY_MS), totalTokens: 1, costUsd: 0 });

    const from = new Date(Date.now() - 10 * DAY_MS).toISOString();
    const res = await agent.get(`/api/v1/sessions?from=${from}`).expect(200);
    expect(res.body.data.map((s: { sessionId: string }) => s.sessionId)).toEqual(['in-range']);
  });

  it('to-only: from defaults to (supplied to) minus 30d, not (now minus 30d)', async () => {
    const { agent } = await authedAgent(app);
    const to = new Date(Date.now() - 10 * DAY_MS).toISOString();
    // Window should resolve to [to-30d, to) = [40 days ago, 10 days ago).
    await postTrace(agent, { sessionId: 'inside-window', name: 'x', ...at(-35 * DAY_MS), totalTokens: 1, costUsd: 0 });
    // Would be excluded by a "now - 30d" default from (30 days ago > 35 days ago),
    // so its presence proves `from` was computed off the supplied `to`, not `now`.
    await postTrace(agent, { sessionId: 'after-to-excluded', name: 'x', ...at(-5 * DAY_MS), totalTokens: 1, costUsd: 0 });
    await postTrace(agent, { sessionId: 'before-from-excluded', name: 'x', ...at(-45 * DAY_MS), totalTokens: 1, costUsd: 0 });

    const res = await agent.get(`/api/v1/sessions?to=${to}`).expect(200);
    expect(res.body.data.map((s: { sessionId: string }) => s.sessionId)).toEqual(['inside-window']);
  });

  it('both from and to supplied: both bounds are respected exactly', async () => {
    const { agent } = await authedAgent(app);
    const from = new Date(Date.now() - 20 * DAY_MS).toISOString();
    const to = new Date(Date.now() - 10 * DAY_MS).toISOString();
    await postTrace(agent, { sessionId: 'inside', name: 'x', ...at(-15 * DAY_MS), totalTokens: 1, costUsd: 0 });
    await postTrace(agent, { sessionId: 'before-from', name: 'x', ...at(-25 * DAY_MS), totalTokens: 1, costUsd: 0 });
    await postTrace(agent, { sessionId: 'after-to', name: 'x', ...at(-5 * DAY_MS), totalTokens: 1, costUsd: 0 });

    const res = await agent.get(`/api/v1/sessions?from=${from}&to=${to}`).expect(200);
    expect(res.body.data.map((s: { sessionId: string }) => s.sessionId)).toEqual(['inside']);
  });

  it('the upper bound is exclusive: a trace exactly at `to` is excluded', async () => {
    const { agent } = await authedAgent(app);
    const to = new Date(Date.now() - 10 * DAY_MS);
    await postTrace(agent, {
      sessionId: 'just-before-to',
      name: 'x',
      startTime: new Date(to.getTime() - 1).toISOString(),
      endTime: new Date(to.getTime()).toISOString(),
      totalTokens: 1,
      costUsd: 0,
    });
    await postTrace(agent, {
      sessionId: 'exactly-at-to',
      name: 'x',
      startTime: to.toISOString(),
      endTime: new Date(to.getTime() + 1000).toISOString(),
      totalTokens: 1,
      costUsd: 0,
    });

    const res = await agent
      .get(`/api/v1/sessions?from=2020-01-01&to=${to.toISOString()}`)
      .expect(200);
    expect(res.body.data.map((s: { sessionId: string }) => s.sessionId)).toEqual(['just-before-to']);
  });

  it('rejects an invalid date with 400 VALIDATION_ERROR', async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get('/api/v1/sessions?from=not-a-date').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/v1/sessions — pagination', () => {
  it('caps results at limit, reports the full total, and page 2 returns the remainder', async () => {
    const { agent } = await authedAgent(app);
    await postTrace(agent, { sessionId: 'a', name: 'x', ...at(-3 * DAY_MS), totalTokens: 1, costUsd: 0 });
    await postTrace(agent, { sessionId: 'b', name: 'x', ...at(-2 * DAY_MS), totalTokens: 1, costUsd: 0 });
    await postTrace(agent, { sessionId: 'c', name: 'x', ...at(-1 * DAY_MS), totalTokens: 1, costUsd: 0 });

    const page1 = await agent.get(`/api/v1/sessions?limit=2&${WIDE_RANGE}`).expect(200);
    expect(page1.body.total).toBe(3);
    expect(page1.body.page).toBe(1);
    expect(page1.body.data.map((s: { sessionId: string }) => s.sessionId)).toEqual(['c', 'b']);

    const page2 = await agent.get(`/api/v1/sessions?limit=2&page=2&${WIDE_RANGE}`).expect(200);
    expect(page2.body.total).toBe(3);
    expect(page2.body.page).toBe(2);
    expect(page2.body.data.map((s: { sessionId: string }) => s.sessionId)).toEqual(['a']);
  });

  it('breaks lastAt ties deterministically by session_id DESC', async () => {
    const { agent } = await authedAgent(app);
    const tied = at(-1 * DAY_MS);
    await postTrace(agent, { sessionId: 's-a', name: 'x', ...tied, totalTokens: 1, costUsd: 0 });
    await postTrace(agent, { sessionId: 's-b', name: 'x', ...tied, totalTokens: 1, costUsd: 0 });

    const res = await agent.get(`/api/v1/sessions?${WIDE_RANGE}`).expect(200);
    expect(res.body.data.map((s: { sessionId: string }) => s.sessionId)).toEqual(['s-b', 's-a']);
  });
});

describe('GET /api/v1/sessions — q filter', () => {
  it('filters by q (case-insensitive substring of session_id)', async () => {
    const { agent } = await authedAgent(app);
    await postTrace(agent, { sessionId: 'chat-42', name: 'x', ...at(-2 * DAY_MS), totalTokens: 1, costUsd: 0 });
    await postTrace(agent, { sessionId: 'batch-99', name: 'x', ...at(-1 * DAY_MS), totalTokens: 1, costUsd: 0 });

    const res = await agent.get(`/api/v1/sessions?q=CHAT&${WIDE_RANGE}`).expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].sessionId).toBe('chat-42');
  });

  it('an empty q is treated as "no filter" (200, all sessions) — not a 400', async () => {
    const { agent } = await authedAgent(app);
    await postTrace(agent, { sessionId: 'chat-42', name: 'x', ...at(-2 * DAY_MS), totalTokens: 1, costUsd: 0 });
    await postTrace(agent, { sessionId: 'batch-99', name: 'x', ...at(-1 * DAY_MS), totalTokens: 1, costUsd: 0 });

    const res = await agent.get(`/api/v1/sessions?q=&${WIDE_RANGE}`).expect(200);
    expect(res.body.total).toBe(2);
  });

  it('a whitespace-only q is treated as "no filter" (200, all sessions) — not a 400', async () => {
    const { agent } = await authedAgent(app);
    await postTrace(agent, { sessionId: 'chat-42', name: 'x', ...at(-2 * DAY_MS), totalTokens: 1, costUsd: 0 });
    await postTrace(agent, { sessionId: 'batch-99', name: 'x', ...at(-1 * DAY_MS), totalTokens: 1, costUsd: 0 });

    const res = await agent.get(`/api/v1/sessions?q=${encodeURIComponent('   ')}&${WIDE_RANGE}`).expect(200);
    expect(res.body.total).toBe(2);
  });
});

describe('GET /api/v1/sessions/:id', () => {
  it('returns the session summary plus its traces newest-first', async () => {
    const { agent } = await authedAgent(app);
    await postTrace(agent, { sessionId: 's1', name: 'oldest', ...at(-3 * DAY_MS), totalTokens: 100, costUsd: 0.001 });
    await postTrace(agent, { sessionId: 's1', name: 'middle', ...at(-2 * DAY_MS), totalTokens: 200, costUsd: 0.002 });
    await postTrace(agent, { sessionId: 's1', name: 'newest', ...at(-1 * DAY_MS), totalTokens: 300, costUsd: 0.003 });

    const res = await agent.get('/api/v1/sessions/s1').expect(200);

    expect(res.body.session.sessionId).toBe('s1');
    expect(res.body.session.traceCount).toBe(3);
    expect(res.body.session.totalTokens).toBe(600);
    expect(res.body.session.totalCostUsd).toBeCloseTo(0.006, 6);

    expect(res.body.traces.map((t: { name: string }) => t.name)).toEqual(['newest', 'middle', 'oldest']);
    expect(res.body.traces[0].spanCount).toBe(1);
    expect(res.body.traces[0].totalTokens).toBe(300);
    expect(res.body.traces[0].status).toBe('ok');
  });

  it('trace items carry tags and sessionId — the shape the web TraceTable renders', async () => {
    const { agent } = await authedAgent(app);
    await postTrace(agent, { sessionId: 's1', name: 'tagged', ...at(-1 * DAY_MS), totalTokens: 10, costUsd: 0, tags: ['prod', 'beta'] });
    await postTrace(agent, { sessionId: 's1', name: 'untagged', ...at(-2 * DAY_MS), totalTokens: 10, costUsd: 0 });

    const res = await agent.get('/api/v1/sessions/s1').expect(200);

    const tagged = res.body.traces.find((t: { name: string }) => t.name === 'tagged');
    const untagged = res.body.traces.find((t: { name: string }) => t.name === 'untagged');
    expect(tagged.tags).toEqual(['prod', 'beta']);
    expect(untagged.tags).toEqual([]);
    expect(tagged.sessionId).toBe('s1');
  });

  it('returns 404 for a session_id the team never used', async () => {
    const { agent } = await authedAgent(app);
    await postTrace(agent, { sessionId: 's1', name: 'x', ...at(-1 * DAY_MS), totalTokens: 1, costUsd: 0 });
    const res = await agent.get('/api/v1/sessions/nope').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('is NOT date-filtered: a session with only traces outside the default 30d window still returns full detail', async () => {
    const { agent } = await authedAgent(app);
    await postTrace(agent, { sessionId: 'old-only', name: 'ancient-a', ...at(-200 * DAY_MS), totalTokens: 10, costUsd: 0.01 });
    await postTrace(agent, { sessionId: 'old-only', name: 'ancient-b', ...at(-190 * DAY_MS), totalTokens: 20, costUsd: 0.02 });

    // Confirm it's genuinely outside the default list window first.
    const list = await agent.get('/api/v1/sessions').expect(200);
    expect(list.body.data.map((s: { sessionId: string }) => s.sessionId)).not.toContain('old-only');

    // Detail still returns it in full, undated.
    const detail = await agent.get('/api/v1/sessions/old-only').expect(200);
    expect(detail.body.session.traceCount).toBe(2);
    expect(detail.body.session.totalTokens).toBe(30);
    expect(detail.body.traces).toHaveLength(2);
  });
});

describe('sessions auth', () => {
  it('allows a viewer to list sessions (read-only, any role)', async () => {
    const { agent, userId, teamId } = await authedAgent(app);
    await postTrace(agent, { sessionId: 's1', name: 'x', ...at(-1 * DAY_MS), totalTokens: 1, costUsd: 0 });
    await setRole(userId, teamId, 'viewer');

    const res = await agent.get(`/api/v1/sessions?${WIDE_RANGE}`).expect(200);
    expect(res.body.total).toBe(1);
  });

  it('allows a viewer to get session detail (read-only, any role)', async () => {
    const { agent, userId, teamId } = await authedAgent(app);
    await postTrace(agent, { sessionId: 's1', name: 'x', ...at(-1 * DAY_MS), totalTokens: 1, costUsd: 0 });
    await setRole(userId, teamId, 'viewer');

    const res = await agent.get('/api/v1/sessions/s1').expect(200);
    expect(res.body.session.sessionId).toBe('s1');
  });

  it('requires authentication for the list endpoint (401 without a session)', async () => {
    await request(app).get('/api/v1/sessions').expect(401);
  });

  it('requires authentication for the detail endpoint (401 without a session)', async () => {
    await request(app).get('/api/v1/sessions/s1').expect(401);
  });
});

describe('sessions team isolation', () => {
  it("team B's identical session_id never appears for team A, and never contributes to A's rollup", async () => {
    const a = await authedAgent(app);
    const b = await authedAgent(app);

    await postTrace(a.agent, { sessionId: 'shared', name: 'a-trace', ...at(-2 * DAY_MS), totalTokens: 10, costUsd: 0.001 });
    await postTrace(b.agent, { sessionId: 'shared', name: 'b-trace', ...at(-1 * DAY_MS), totalTokens: 999, costUsd: 0.999 });

    // A sees only its own "shared" session (1 trace, 10 tokens), never B's data.
    const listA = await a.agent.get(`/api/v1/sessions?${WIDE_RANGE}`).expect(200);
    expect(listA.body.total).toBe(1);
    const sharedA = listA.body.data[0];
    expect(sharedA.sessionId).toBe('shared');
    expect(sharedA.traceCount).toBe(1);
    expect(sharedA.totalTokens).toBe(10);
    expect(sharedA.totalCostUsd).toBeCloseTo(0.001, 6);

    const detailA = await a.agent.get('/api/v1/sessions/shared').expect(200);
    expect(detailA.body.session.traceCount).toBe(1);
    expect(detailA.body.session.totalTokens).toBe(10);
    expect(detailA.body.traces.map((t: { name: string }) => t.name)).toEqual(['a-trace']);

    // B, symmetrically, sees only its own side of the shared session_id.
    const detailB = await b.agent.get('/api/v1/sessions/shared').expect(200);
    expect(detailB.body.session.traceCount).toBe(1);
    expect(detailB.body.session.totalTokens).toBe(999);
    expect(detailB.body.traces.map((t: { name: string }) => t.name)).toEqual(['b-trace']);
  });
});
