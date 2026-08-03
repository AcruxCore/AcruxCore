import prisma from '../../shared/db/client';
import { FeedbackRepository } from './feedback.repository';

const repo = new FeedbackRepository();

// Window derived from real time (not a fixed calendar range) so this test never becomes a
// ticking time bomb: a hardcoded '2026-07-01'..'2026-08-01' window went stale the moment
// "now" crossed into August 2026, since freshly-created feedback rows (createdAt defaults
// to DB now()) landed on/after the exclusive upper bound and silently dropped out of every
// aggregate() bucket.
const FROM = new Date(Date.now() - 24 * 60 * 60 * 1000);
const TO = new Date(Date.now() + 24 * 60 * 60 * 1000);

async function truncate(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE
    span_payloads, spans, trace_feedback, traces, team_trace_settings,
    gateway_requests, gateway_cache, budgets, virtual_keys, provider_connections,
    gateway_model_fallbacks, gateway_models,
    audit_log, prompt_aliases, prompt_versions, prompts,
    api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`);
}

/** Creates a team plus a trace with one llm span (direct inserts — see §6 note above). */
async function seedTraceWithSpan(model: string): Promise<{ teamId: string; traceId: string; spanRef: string }> {
  const team = await prisma.team.create({ data: { name: `t6-repo-${Date.now()}-${Math.random()}` } });
  const trace = await prisma.trace.create({
    data: { teamId: team.id, name: 'trace', startedAt: new Date('2026-07-10T10:00:00Z') },
  });
  const span = await prisma.span.create({
    data: {
      teamId: team.id,
      traceId: trace.id,
      spanRef: 's1',
      kind: 'llm',
      name: model,
      startedAt: new Date('2026-07-10T10:00:00Z'),
      model,
    },
  });
  return { teamId: team.id, traceId: trace.id, spanRef: span.spanRef };
}

beforeEach(truncate);
afterAll(async () => {
  await truncate();
  await prisma.$disconnect();
});

describe('FeedbackRepository', () => {
  it('create → listForTrace round-trips newest-first with the span reference', async () => {
    const { teamId, traceId, spanRef } = await seedTraceWithSpan('gpt-4o-mini');
    const span = await repo.findSpanInTrace(traceId, spanRef);

    await repo.create({
      teamId, traceId, spanId: null,
      rating: 1, label: null, comment: 'first', source: 'user', createdBy: null,
    });
    await repo.create({
      teamId, traceId, spanId: span!.id,
      rating: -1, label: 'wrong_answer', comment: null, source: 'end_user', createdBy: null,
    });

    const rows = await repo.listForTrace(teamId, traceId);
    expect(rows).toHaveLength(2);
    // newest first
    expect(rows[0].comment).toBeNull();
    expect(rows[0].span?.spanRef).toBe('s1');
    expect(rows[1].comment).toBe('first');
    expect(rows[1].span).toBeNull();
  });

  it('findTraceForTeam returns null for another team (isolation)', async () => {
    const a = await seedTraceWithSpan('gpt-4o');
    const b = await seedTraceWithSpan('gpt-4o');
    expect(await repo.findTraceForTeam(a.teamId, a.traceId)).not.toBeNull();
    expect(await repo.findTraceForTeam(b.teamId, a.traceId)).toBeNull();
  });

  it('findSpanInTrace resolves a ref within its trace and rejects a foreign ref', async () => {
    const { traceId, spanRef } = await seedTraceWithSpan('gpt-4o');
    const other = await seedTraceWithSpan('gpt-4o'); // its span ref is also 's1' but under a different trace
    const found = await repo.findSpanInTrace(traceId, spanRef);
    expect(found?.spanRef).toBe('s1');
    // A ref that does not exist under this trace resolves to null.
    expect(await repo.findSpanInTrace(traceId, 'does-not-exist')).toBeNull();
    void other;
  });

  it('aggregate(group_by=model) computes count, avgRating, downCount per model', async () => {
    // Two traces, two models.
    const mini = await seedTraceWithSpan('gpt-4o-mini');
    const big = await seedTraceWithSpan('gpt-4o');
    // Reuse ONE team so the aggregate is team-scoped to it. Re-home big's trace/span into mini's team.
    await prisma.trace.update({ where: { id: big.traceId }, data: { teamId: mini.teamId } });
    await prisma.span.updateMany({ where: { traceId: big.traceId }, data: { teamId: mini.teamId } });

    // gpt-4o-mini: ratings 1 and -1  → count 2, avg 0, down 1
    await repo.create({ teamId: mini.teamId, traceId: mini.traceId, spanId: null, rating: 1, label: null, comment: null, source: 'user', createdBy: null });
    await repo.create({ teamId: mini.teamId, traceId: mini.traceId, spanId: null, rating: -1, label: null, comment: null, source: 'user', createdBy: null });
    // gpt-4o: rating 1  → count 1, avg 1, down 0
    await repo.create({ teamId: mini.teamId, traceId: big.traceId, spanId: null, rating: 1, label: null, comment: null, source: 'user', createdBy: null });

    const { groupBy, buckets } = await repo.aggregate(mini.teamId, { from: FROM, to: TO, groupBy: 'model' });
    expect(groupBy).toBe('model');
    const byKey = Object.fromEntries(buckets.map((b) => [b.key, b]));
    expect(byKey['gpt-4o-mini'].count).toBe(2);
    expect(byKey['gpt-4o-mini'].avgRating).toBeCloseTo(0, 6);
    expect(byKey['gpt-4o-mini'].downCount).toBe(1);
    expect(byKey['gpt-4o'].count).toBe(1);
    expect(byKey['gpt-4o'].avgRating).toBeCloseTo(1, 6);
    expect(byKey['gpt-4o'].downCount).toBe(0);
  });
});
