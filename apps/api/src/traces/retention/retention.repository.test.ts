import prisma from '../../shared/db/client';
import { RetentionRepository } from './retention.repository';

const repo = new RetentionRepository();

async function truncate(): Promise<void> {
  await prisma.$executeRaw`TRUNCATE TABLE span_payloads, spans, traces, team_trace_settings, audit_log, teams, users RESTART IDENTITY CASCADE`;
}

/** Seeds a team, a trace, a span, and a span_payload with a specific created_at. */
async function seedPayload(createdAt: Date): Promise<{ teamId: string; spanId: string }> {
  const team = await prisma.team.create({ data: { name: 'Retention Team' } });
  const trace = await prisma.trace.create({ data: { teamId: team.id, startedAt: new Date() } });
  const span = await prisma.span.create({
    data: {
      teamId: team.id,
      traceId: trace.id,
      spanRef: 's',
      kind: 'llm',
      name: 'm',
      startedAt: new Date(),
    },
  });
  await prisma.spanPayload.create({
    data: { spanId: span.id, teamId: team.id, input: { role: 'user' } },
  });
  // created_at has a DB default (now()); backdate it directly, same pattern
  // digest.test.ts uses for gateway_requests.created_at.
  await prisma.$executeRaw`UPDATE span_payloads SET created_at = ${createdAt} WHERE span_id = ${span.id}::uuid`;
  return { teamId: team.id, spanId: span.id };
}

beforeEach(truncate);
afterAll(async () => {
  await truncate();
  await prisma.$disconnect();
});

describe('RetentionRepository', () => {
  it('purgeOlderThan deletes only span_payloads older than the cutoff, across all teams', async () => {
    const cutoff = new Date('2026-07-01T00:00:00Z');
    const old = await seedPayload(new Date('2026-06-01T00:00:00Z'));
    const recent = await seedPayload(new Date('2026-07-15T00:00:00Z'));

    const deleted = await repo.purgeOlderThan(cutoff);

    expect(deleted).toBe(1);
    expect(await prisma.spanPayload.findUnique({ where: { spanId: old.spanId } })).toBeNull();
    expect(await prisma.spanPayload.findUnique({ where: { spanId: recent.spanId } })).not.toBeNull();
  });

  it('purgeOlderThan does not touch the owning span or trace rows — only the payload', async () => {
    const cutoff = new Date('2026-07-01T00:00:00Z');
    const { spanId } = await seedPayload(new Date('2026-06-01T00:00:00Z'));

    await repo.purgeOlderThan(cutoff);

    const span = await prisma.span.findUnique({ where: { id: spanId } });
    expect(span).not.toBeNull(); // span itself survives — only its payload is purged
  });

  it('purgeOlderThan returns 0 when nothing is old enough', async () => {
    await seedPayload(new Date('2026-07-20T00:00:00Z'));
    const deleted = await repo.purgeOlderThan(new Date('2026-07-01T00:00:00Z'));
    expect(deleted).toBe(0);
  });
});
