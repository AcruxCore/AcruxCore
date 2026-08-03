import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { SessionsRepository } from './sessions.repository';
import { authedAgent } from '../../test-utils';

const app = createApp();
const repo = new SessionsRepository();

const WIDE_FROM = new Date('2020-01-01T00:00:00Z');
const WIDE_TO = new Date('2030-01-01T00:00:00Z');

/**
 * Posts one trace (single llm span) via the real T2 ingestion endpoint so the
 * write path computes the trace rollups. `sessionId` may be omitted (ungrouped).
 */
async function postTrace(
  agent: ReturnType<typeof request.agent>,
  opts: {
    sessionId?: string;
    name: string;
    startTime: string;
    endTime: string;
    totalTokens: number;
    costUsd: number;
  },
): Promise<string> {
  const res = await agent
    .post('/api/v1/traces')
    .send({
      traces: [
        {
          ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
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
  return res.body.traceIds[0] as string;
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

describe('SessionsRepository.listSessions', () => {
  it('groups traces by session_id with correct rollups and newest-activity-first order', async () => {
    const { agent, teamId } = await authedAgent(app);
    // Session s1: 3 traces. tokens 100+200+300=600, cost 0.001+0.002+0.003=0.006.
    await postTrace(agent, { sessionId: 's1', name: 'run-a', startTime: '2026-07-01T10:00:00Z', endTime: '2026-07-01T10:00:01Z', totalTokens: 100, costUsd: 0.001 });
    await postTrace(agent, { sessionId: 's1', name: 'run-b', startTime: '2026-07-01T10:05:00Z', endTime: '2026-07-01T10:05:01Z', totalTokens: 200, costUsd: 0.002 });
    await postTrace(agent, { sessionId: 's1', name: 'run-c', startTime: '2026-07-01T10:10:00Z', endTime: '2026-07-01T10:10:01Z', totalTokens: 300, costUsd: 0.003 });
    // Session s2: 2 traces, more recent activity. tokens 50+70=120, cost 0.
    await postTrace(agent, { sessionId: 's2', name: 'run-d', startTime: '2026-07-02T09:00:00Z', endTime: '2026-07-02T09:00:01Z', totalTokens: 50, costUsd: 0 });
    await postTrace(agent, { sessionId: 's2', name: 'run-e', startTime: '2026-07-02T09:30:00Z', endTime: '2026-07-02T09:30:01Z', totalTokens: 70, costUsd: 0 });

    const { data, total } = await repo.listSessions(teamId, { from: WIDE_FROM, to: WIDE_TO, page: 1, limit: 20 });

    expect(total).toBe(2);
    // s2 is newest activity → first.
    expect(data.map((s) => s.sessionId)).toEqual(['s2', 's1']);

    const s1 = data.find((s) => s.sessionId === 's1')!;
    expect(s1.traceCount).toBe(3);
    expect(s1.totalTokens).toBe(600);
    expect(s1.totalCostUsd).toBeCloseTo(0.006, 6);
    expect(new Date(s1.firstAt).toISOString()).toBe('2026-07-01T10:00:00.000Z');
    expect(new Date(s1.lastAt).toISOString()).toBe('2026-07-01T10:10:00.000Z');

    const s2 = data.find((s) => s.sessionId === 's2')!;
    expect(s2.traceCount).toBe(2);
    expect(s2.totalTokens).toBe(120);
    // All-zero cost sums to 0 (not null) because the traces carried a cost of 0.
    expect(s2.totalCostUsd).toBeCloseTo(0, 6);
  });

  it('excludes traces that have no session_id', async () => {
    const { agent, teamId } = await authedAgent(app);
    await postTrace(agent, { sessionId: 's1', name: 'grouped', startTime: '2026-07-01T10:00:00Z', endTime: '2026-07-01T10:00:01Z', totalTokens: 10, costUsd: 0 });
    await postTrace(agent, { name: 'ungrouped', startTime: '2026-07-01T11:00:00Z', endTime: '2026-07-01T11:00:01Z', totalTokens: 10, costUsd: 0 });

    const { data, total } = await repo.listSessions(teamId, { from: WIDE_FROM, to: WIDE_TO, page: 1, limit: 20 });
    expect(total).toBe(1);
    expect(data.map((s) => s.sessionId)).toEqual(['s1']);
  });

  it('paginates and reports the full distinct-session total', async () => {
    const { agent, teamId } = await authedAgent(app);
    await postTrace(agent, { sessionId: 'a', name: 'x', startTime: '2026-07-01T10:00:00Z', endTime: '2026-07-01T10:00:01Z', totalTokens: 1, costUsd: 0 });
    await postTrace(agent, { sessionId: 'b', name: 'x', startTime: '2026-07-02T10:00:00Z', endTime: '2026-07-02T10:00:01Z', totalTokens: 1, costUsd: 0 });
    await postTrace(agent, { sessionId: 'c', name: 'x', startTime: '2026-07-03T10:00:00Z', endTime: '2026-07-03T10:00:01Z', totalTokens: 1, costUsd: 0 });

    const page1 = await repo.listSessions(teamId, { from: WIDE_FROM, to: WIDE_TO, page: 1, limit: 2 });
    expect(page1.total).toBe(3);
    expect(page1.data).toHaveLength(2);
    expect(page1.data.map((s) => s.sessionId)).toEqual(['c', 'b']); // newest first

    const page2 = await repo.listSessions(teamId, { from: WIDE_FROM, to: WIDE_TO, page: 2, limit: 2 });
    expect(page2.total).toBe(3);
    expect(page2.data.map((s) => s.sessionId)).toEqual(['a']);
  });

  it('filters by q as a case-insensitive substring of session_id', async () => {
    const { agent, teamId } = await authedAgent(app);
    await postTrace(agent, { sessionId: 'chat-42', name: 'x', startTime: '2026-07-01T10:00:00Z', endTime: '2026-07-01T10:00:01Z', totalTokens: 1, costUsd: 0 });
    await postTrace(agent, { sessionId: 'batch-99', name: 'x', startTime: '2026-07-02T10:00:00Z', endTime: '2026-07-02T10:00:01Z', totalTokens: 1, costUsd: 0 });

    const { data, total } = await repo.listSessions(teamId, { from: WIDE_FROM, to: WIDE_TO, page: 1, limit: 20, q: 'CHAT' });
    expect(total).toBe(1);
    expect(data[0].sessionId).toBe('chat-42');
  });

  it('applies the date window on started_at (exclusive upper bound)', async () => {
    const { agent, teamId } = await authedAgent(app);
    await postTrace(agent, { sessionId: 'in-range', name: 'x', startTime: '2026-07-01T10:00:00Z', endTime: '2026-07-01T10:00:01Z', totalTokens: 1, costUsd: 0 });
    await postTrace(agent, { sessionId: 'out-of-range', name: 'x', startTime: '2020-01-01T10:00:00Z', endTime: '2020-01-01T10:00:01Z', totalTokens: 1, costUsd: 0 });

    const { data, total } = await repo.listSessions(teamId, {
      from: new Date('2026-06-01T00:00:00Z'),
      to: new Date('2026-08-01T00:00:00Z'),
      page: 1,
      limit: 20,
    });
    expect(total).toBe(1);
    expect(data.map((s) => s.sessionId)).toEqual(['in-range']);
  });

  it('enforces team isolation: identical session_id in another team never contributes', async () => {
    const teamA = await authedAgent(app);
    const teamB = await authedAgent(app);
    await postTrace(teamA.agent, { sessionId: 'shared', name: 'a1', startTime: '2026-07-01T10:00:00Z', endTime: '2026-07-01T10:00:01Z', totalTokens: 100, costUsd: 0.01 });
    await postTrace(teamB.agent, { sessionId: 'shared', name: 'b1', startTime: '2026-07-01T11:00:00Z', endTime: '2026-07-01T11:00:01Z', totalTokens: 500, costUsd: 0.5 });

    const { data, total } = await repo.listSessions(teamA.teamId, { from: WIDE_FROM, to: WIDE_TO, page: 1, limit: 20 });
    expect(total).toBe(1);
    expect(data[0].sessionId).toBe('shared');
    expect(data[0].traceCount).toBe(1);
    expect(data[0].totalTokens).toBe(100);
  });
});

describe('SessionsRepository.getSession', () => {
  it('returns the summary plus the session traces newest-first', async () => {
    const { agent, teamId } = await authedAgent(app);
    await postTrace(agent, { sessionId: 's1', name: 'oldest', startTime: '2026-07-01T10:00:00Z', endTime: '2026-07-01T10:00:01Z', totalTokens: 100, costUsd: 0.001 });
    await postTrace(agent, { sessionId: 's1', name: 'middle', startTime: '2026-07-01T10:05:00Z', endTime: '2026-07-01T10:05:01Z', totalTokens: 200, costUsd: 0.002 });
    await postTrace(agent, { sessionId: 's1', name: 'newest', startTime: '2026-07-01T10:10:00Z', endTime: '2026-07-01T10:10:01Z', totalTokens: 300, costUsd: 0.003 });

    const result = await repo.getSession(teamId, 's1');
    expect(result).not.toBeNull();
    expect(result!.session.sessionId).toBe('s1');
    expect(result!.session.traceCount).toBe(3);
    expect(result!.session.totalTokens).toBe(600);
    expect(result!.session.totalCostUsd).toBeCloseTo(0.006, 6);

    expect(result!.traces.map((t) => t.name)).toEqual(['newest', 'middle', 'oldest']);
    expect(result!.traces[0].spanCount).toBe(1);
    expect(result!.traces[0].totalTokens).toBe(300);
    expect(result!.traces[0].totalCostUsd).toBeCloseTo(0.003, 6);
    expect(result!.traces[0].status).toBe('ok');
  });

  it('returns null when the team has no trace with that session_id', async () => {
    const { agent, teamId } = await authedAgent(app);
    await postTrace(agent, { sessionId: 's1', name: 'x', startTime: '2026-07-01T10:00:00Z', endTime: '2026-07-01T10:00:01Z', totalTokens: 1, costUsd: 0 });
    expect(await repo.getSession(teamId, 'does-not-exist')).toBeNull();
  });

  it('enforces team isolation: another team with the identical session_id is invisible', async () => {
    const teamA = await authedAgent(app);
    const teamB = await authedAgent(app);
    await postTrace(teamB.agent, { sessionId: 'shared', name: 'b1', startTime: '2026-07-01T10:00:00Z', endTime: '2026-07-01T10:00:01Z', totalTokens: 1, costUsd: 0 });

    expect(await repo.getSession(teamA.teamId, 'shared')).toBeNull();
  });
});
