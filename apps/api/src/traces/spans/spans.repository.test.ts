import prisma from '../../shared/db/client';
import { SpansRepository } from './spans.repository';

const repo = new SpansRepository();

async function truncate(): Promise<void> {
  await prisma.$executeRaw`TRUNCATE TABLE span_payloads, spans, traces, team_trace_settings, audit_log, teams, users RESTART IDENTITY CASCADE`;
}

/** Seeds a user + team directly so the repo has valid FKs to point at. */
async function seedTeam(): Promise<string> {
  const team = await prisma.team.create({ data: { name: 'Spans Team' } });
  return team.id;
}

beforeEach(truncate);
afterAll(async () => {
  await truncate();
  await prisma.$disconnect();
});

describe('SpansRepository', () => {
  it('createTrace honors an explicit id and defaults rollups to zero', async () => {
    const teamId = await seedTeam();
    const trace = await repo.createTrace({
      id: '11111111-1111-1111-1111-111111111111',
      teamId,
      sessionId: 'sess-1',
      name: 'gpt-4o-mini',
      startedAt: new Date('2026-07-04T10:00:00Z'),
    });
    expect(trace.id).toBe('11111111-1111-1111-1111-111111111111');
    expect(trace.spanCount).toBe(0);
    expect(trace.totalTokens).toBe(0);
    expect(trace.totalCostUsd).toBeNull();
    expect(trace.status).toBe('unset');
  });

  it('createTrace stores tags and metadata, defaulting to [] and {}', async () => {
    const teamId = await seedTeam();
    const withValues = await repo.createTrace({
      teamId,
      startedAt: new Date(),
      tags: ['prod', 'nl'],
      metadata: { env: 'prod', retries: 2 },
    });
    expect(withValues.tags).toEqual(['prod', 'nl']);
    expect(withValues.metadata).toEqual({ env: 'prod', retries: 2 });

    const defaults = await repo.createTrace({ teamId, startedAt: new Date() });
    expect(defaults.tags).toEqual([]);
    expect(defaults.metadata).toEqual({});
  });

  it('mergeTraceContext unions tags (deduped) and shallow-merges metadata', async () => {
    const teamId = await seedTeam();
    const trace = await repo.createTrace({
      teamId,
      startedAt: new Date(),
      tags: ['a'],
      metadata: { k: 'v1', j: '1' },
    });

    await repo.mergeTraceContext(trace.id, teamId, {
      tags: ['a', 'b'],
      metadata: { k: 'v2' },
    });

    const updated = await prisma.trace.findUnique({ where: { id: trace.id } });
    expect(updated!.tags.sort()).toEqual(['a', 'b']);
    expect(updated!.metadata).toEqual({ k: 'v2', j: '1' });
  });

  it('mergeTraceContext is a no-op when neither tags nor metadata is supplied', async () => {
    const teamId = await seedTeam();
    const trace = await repo.createTrace({ teamId, startedAt: new Date(), tags: ['a'] });
    await repo.mergeTraceContext(trace.id, teamId, {});
    const updated = await prisma.trace.findUnique({ where: { id: trace.id } });
    expect(updated!.tags).toEqual(['a']);
  });

  it('T9: mergeTraceContext overwrites name when supplied (last-explicit-write-wins)', async () => {
    const teamId = await seedTeam();
    const trace = await repo.createTrace({ teamId, startedAt: new Date(), name: '2026-07-05T00:00:00.000Z' });

    await repo.mergeTraceContext(trace.id, teamId, { name: 'trip-planner' });
    const renamed = await prisma.trace.findUnique({ where: { id: trace.id } });
    expect(renamed!.name).toBe('trip-planner');

    // A later call with no name is a no-op for name — does not reset it.
    await repo.mergeTraceContext(trace.id, teamId, { tags: ['nl'] });
    const untouched = await prisma.trace.findUnique({ where: { id: trace.id } });
    expect(untouched!.name).toBe('trip-planner');

    // A later call supplying a new name overwrites the previous explicit name too.
    await repo.mergeTraceContext(trace.id, teamId, { name: 'trip-planner-v2' });
    const renamedAgain = await prisma.trace.findUnique({ where: { id: trace.id } });
    expect(renamedAgain!.name).toBe('trip-planner-v2');
  });

  it('mergeTraceContext is team-scoped: does not touch another team\'s trace', async () => {
    const teamId = await seedTeam();
    const otherTeamId = await seedTeam();
    const trace = await repo.createTrace({ teamId, startedAt: new Date(), tags: ['a'] });
    await repo.mergeTraceContext(trace.id, otherTeamId, { tags: ['b'] });
    const updated = await prisma.trace.findUnique({ where: { id: trace.id } });
    expect(updated!.tags).toEqual(['a']); // unchanged — wrong team, no match
  });

  it('appendSpan bumps span_count, total_tokens, total_cost_usd and status/ended_at', async () => {
    const teamId = await seedTeam();
    const trace = await repo.createTrace({ teamId, startedAt: new Date('2026-07-04T10:00:00Z') });

    await repo.appendSpan({
      teamId,
      traceId: trace.id,
      spanRef: 'span-a',
      kind: 'llm',
      name: 'gpt-4o-mini',
      status: 'ok',
      startedAt: new Date('2026-07-04T10:00:01Z'),
      endedAt: new Date('2026-07-04T10:00:02Z'),
      totalTokens: 13,
      costUsd: 0.0000024,
    });
    await repo.appendSpan({
      teamId,
      traceId: trace.id,
      spanRef: 'span-b',
      kind: 'llm',
      name: 'gpt-4o-mini',
      status: 'ok',
      startedAt: new Date('2026-07-04T10:00:03Z'),
      endedAt: new Date('2026-07-04T10:00:05Z'),
      totalTokens: 7,
      costUsd: 0.0000010,
    });

    const rolled = await prisma.trace.findUnique({ where: { id: trace.id } });
    expect(rolled!.spanCount).toBe(2);
    expect(rolled!.totalTokens).toBe(20);
    expect(Number(rolled!.totalCostUsd)).toBeCloseTo(0.0000034, 9);
    expect(rolled!.status).toBe('ok');
    expect(rolled!.endedAt?.toISOString()).toBe('2026-07-04T10:00:05.000Z');
  });

  it('T9: appendSpan stores tags and metadata, defaulting to [] and {}', async () => {
    const teamId = await seedTeam();
    const trace = await repo.createTrace({ teamId, startedAt: new Date() });

    const withValues = await repo.appendSpan({
      teamId, traceId: trace.id, spanRef: 's1', kind: 'llm', name: 'intent-detection',
      startedAt: new Date(), tags: ['prod', 'nl'], metadata: { userId: 'u_789' },
    });
    expect(withValues.tags).toEqual(['prod', 'nl']);
    expect(withValues.metadata).toEqual({ userId: 'u_789' });

    const defaults = await repo.appendSpan({
      teamId, traceId: trace.id, spanRef: 's2', kind: 'llm', name: 'm', startedAt: new Date(),
    });
    expect(defaults.tags).toEqual([]);
    expect(defaults.metadata).toEqual({});
  });

  it('appendSpan with an error span sets the trace status to error', async () => {
    const teamId = await seedTeam();
    const trace = await repo.createTrace({ teamId, startedAt: new Date() });
    await repo.appendSpan({
      teamId, traceId: trace.id, spanRef: 's', kind: 'llm', name: 'm',
      status: 'error', startedAt: new Date(),
    });
    const rolled = await prisma.trace.findUnique({ where: { id: trace.id } });
    expect(rolled!.status).toBe('error');
  });

  it('writePayload stores input + output for a span; findTrace is team-scoped', async () => {
    const teamId = await seedTeam();
    const trace = await repo.createTrace({ teamId, startedAt: new Date() });
    const span = await repo.appendSpan({
      teamId, traceId: trace.id, spanRef: 's', kind: 'llm', name: 'm', startedAt: new Date(),
    });
    await repo.writePayload(span.id, teamId, {
      input: [{ role: 'user', content: 'hi' }],
      output: { choices: [{ message: { content: 'yo' } }] },
    });

    const payload = await prisma.spanPayload.findUnique({ where: { spanId: span.id } });
    expect(payload).not.toBeNull();
    expect(payload!.input).toEqual([{ role: 'user', content: 'hi' }]);

    expect(await repo.findTrace(trace.id, teamId)).not.toBeNull();
    expect(await repo.findTrace(trace.id, '99999999-9999-9999-9999-999999999999')).toBeNull();
  });

  it('writePayload redacts secret-shaped content before persisting (Finding #7)', async () => {
    const teamId = await seedTeam();
    const trace = await repo.createTrace({ teamId, startedAt: new Date() });
    const span = await repo.appendSpan({
      teamId, traceId: trace.id, spanRef: 's', kind: 'llm', name: 'm', startedAt: new Date(),
    });
    await repo.writePayload(span.id, teamId, {
      input: [{ role: 'user', content: 'my key is sk-abcdEFGH12345678ijklMNOP' }],
      output: { text: 'sure, email me at talha@livetheworld.com' },
    });

    const payload = await prisma.spanPayload.findUnique({ where: { spanId: span.id } });
    expect(payload!.input).toEqual([{ role: 'user', content: 'my key is [REDACTED]' }]);
    expect(payload!.output).toEqual({ text: 'sure, email me at [REDACTED]' });
  });

  it('writePayload is safe to call twice for the same span (idempotent OTLP retry safety)', async () => {
    const teamId = await seedTeam();
    const trace = await repo.createTrace({ teamId, startedAt: new Date() });
    const span = await repo.appendSpan({
      teamId, traceId: trace.id, spanRef: 's', kind: 'llm', name: 'm', startedAt: new Date(),
    });
    await repo.writePayload(span.id, teamId, { input: 'first', output: 'first' });
    await repo.writePayload(span.id, teamId, { input: 'first', output: 'first' }); // retry of the same batch

    const payload = await prisma.spanPayload.findUnique({ where: { spanId: span.id } });
    expect(payload).not.toBeNull();
    expect(payload!.input).toEqual('first');
  });

  it('findTraceById is team-agnostic: returns the row for any team, null if absent', async () => {
    const teamId = await seedTeam();
    const otherTeamId = await seedTeam();
    const trace = await repo.createTrace({ teamId, startedAt: new Date() });

    const found = await repo.findTraceById(trace.id);
    expect(found).not.toBeNull();
    expect(found!.teamId).toBe(teamId);
    expect(found!.teamId).not.toBe(otherTeamId);

    expect(await repo.findTraceById('99999999-9999-9999-9999-999999999999')).toBeNull();
  });

  it('listSpanRefs returns stored span_ref values for a trace, empty when none', async () => {
    const teamId = await seedTeam();
    const trace = await repo.createTrace({ teamId, startedAt: new Date() });

    expect(await repo.listSpanRefs(trace.id)).toEqual([]);

    await repo.appendSpan({
      teamId, traceId: trace.id, spanRef: 'span-a', kind: 'llm', name: 'm', startedAt: new Date(),
    });
    await repo.appendSpan({
      teamId, traceId: trace.id, spanRef: 'span-b', kind: 'llm', name: 'm', startedAt: new Date(),
    });

    expect((await repo.listSpanRefs(trace.id)).sort()).toEqual(['span-a', 'span-b']);
  });
});

describe('upsertSpan', () => {
  it('is safe to call twice with the same (traceId, spanRef) — one row, rollups not double-counted', async () => {
    const teamId = await seedTeam();
    const trace = await repo.createTrace({ teamId, startedAt: new Date('2026-08-10T00:00:00Z') });

    const input = {
      teamId, traceId: trace.id, spanRef: 's1', kind: 'llm' as const, name: 'x',
      status: 'ok' as const, startedAt: new Date('2026-08-10T00:00:00Z'),
      endedAt: new Date('2026-08-10T00:00:01Z'), totalTokens: 50, costUsd: 0.001,
    };

    await repo.upsertSpan(input);
    await repo.upsertSpan(input); // retry of the same OTLP batch

    const spans = await prisma.span.findMany({ where: { traceId: trace.id } });
    expect(spans).toHaveLength(1);
    const updatedTrace = await prisma.trace.findUnique({ where: { id: trace.id } });
    expect(updatedTrace?.spanCount).toBe(1);
    expect(updatedTrace?.totalTokens).toBe(50);
    expect(Number(updatedTrace?.totalCostUsd)).toBeCloseTo(0.001, 9);
  });

  it('recomputes trace status as error when any upserted span errored, and does not downgrade it back', async () => {
    const teamId = await seedTeam();
    const trace = await repo.createTrace({ teamId, startedAt: new Date('2026-08-10T00:00:00Z') });

    await repo.upsertSpan({
      teamId, traceId: trace.id, spanRef: 's1', kind: 'llm', name: 'x',
      status: 'error', startedAt: new Date('2026-08-10T00:00:00Z'),
    });
    await repo.upsertSpan({
      teamId, traceId: trace.id, spanRef: 's2', kind: 'tool', name: 'y',
      status: 'ok', startedAt: new Date('2026-08-10T00:00:01Z'),
    });

    const updatedTrace = await prisma.trace.findUnique({ where: { id: trace.id } });
    expect(updatedTrace?.status).toBe('error');
  });
});
