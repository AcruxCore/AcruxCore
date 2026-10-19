import prisma from '../../shared/db/client';
import { processRetentionPurge } from './retention.processor';
import { RETENTION_PURGE_JOB } from './retention.queue';
import { CacheRepository } from '../../gateway/cache/cache.repository';

async function truncate(): Promise<void> {
  await prisma.$executeRaw`TRUNCATE TABLE gateway_cache, span_payloads, spans, traces, team_trace_settings, audit_log, teams, users RESTART IDENTITY CASCADE`;
}

async function seedPayload(createdAt: Date): Promise<string> {
  const team = await prisma.team.create({ data: { name: 'Retention Team' } });
  const trace = await prisma.trace.create({ data: { teamId: team.id, startedAt: new Date() } });
  const span = await prisma.span.create({
    data: { teamId: team.id, traceId: trace.id, spanRef: 's', kind: 'llm', name: 'm', startedAt: new Date() },
  });
  await prisma.spanPayload.create({ data: { spanId: span.id, teamId: team.id, input: { a: 1 } } });
  await prisma.$executeRaw`UPDATE span_payloads SET created_at = ${createdAt} WHERE span_id = ${span.id}::uuid`;
  return span.id;
}

beforeEach(truncate);
afterAll(async () => {
  await truncate();
  await prisma.$disconnect();
});

describe('processRetentionPurge', () => {
  it('purges payloads older than retentionDays, relative to `now`', async () => {
    const now = new Date('2026-07-27T03:00:00Z');
    const old = await seedPayload(new Date('2026-04-01T00:00:00Z')); // well past 90 days
    const recent = await seedPayload(new Date('2026-07-20T00:00:00Z')); // within 90 days

    const deleted = await processRetentionPurge({ retentionDays: 90 }, now);

    expect(deleted).toBe(1);
    expect(await prisma.spanPayload.findUnique({ where: { spanId: old } })).toBeNull();
    expect(await prisma.spanPayload.findUnique({ where: { spanId: recent } })).not.toBeNull();
  });

  it('throws on an unknown job name', async () => {
    // Guards against a stale job payload from a previous build, mirroring processDigest.
    const { processRetentionJob } = await import('./retention.processor');
    await expect(processRetentionJob('not-a-real-job', {}, { retentionDays: 90 })).rejects.toThrow(
      /unknown/i,
    );
  });

  it('processRetentionJob routes RETENTION_PURGE_JOB to the purge', async () => {
    const { processRetentionJob } = await import('./retention.processor');
    const now = new Date('2026-07-27T03:00:00Z');
    const old = await seedPayload(new Date('2026-04-01T00:00:00Z'));

    await processRetentionJob(RETENTION_PURGE_JOB, {}, { retentionDays: 90 }, now);

    expect(await prisma.spanPayload.findUnique({ where: { spanId: old } })).toBeNull();
  });
});

describe('expired gateway_cache sweep (issue #652)', () => {
  async function seedCacheRow(teamId: string, cacheKey: string, expiresAt: Date): Promise<void> {
    await prisma.gatewayCache.create({
      data: {
        teamId,
        cacheKey,
        response: { choices: [{ message: { role: 'assistant', content: 'cached answer' } }] },
        promptTokens: 1,
        completionTokens: 1,
        expiresAt,
      },
    });
  }

  it('deletes cache rows whose TTL has passed and keeps live ones', async () => {
    const { processRetentionJob } = await import('./retention.processor');
    const now = new Date('2026-10-19T08:00:00Z');
    const team = await prisma.team.create({ data: { name: 'Cache Sweep Team' } });
    await seedCacheRow(team.id, 'expired', new Date('2026-10-19T07:59:00Z'));
    await seedCacheRow(team.id, 'live', new Date('2026-10-19T08:01:00Z'));

    await processRetentionJob('purge-expired-gateway-cache', {}, { retentionDays: 90 }, now);

    const left = await prisma.gatewayCache.findMany({ where: { teamId: team.id }, select: { cacheKey: true } });
    expect(left.map((r) => r.cacheKey)).toEqual(['live']);
  });

  it('deletes a backlog larger than one batch, a batch per statement', async () => {
    const now = new Date('2026-10-19T08:00:00Z');
    const team = await prisma.team.create({ data: { name: 'Cache Backlog Team' } });
    for (let i = 0; i < 5; i++) await seedCacheRow(team.id, `old-${i}`, new Date('2026-09-01T00:00:00Z'));
    await seedCacheRow(team.id, 'live', new Date('2026-10-19T09:00:00Z'));

    const deleted = await new CacheRepository().purgeExpired(now, 2);

    expect(deleted).toBe(5);
    const left = await prisma.gatewayCache.findMany({ where: { teamId: team.id }, select: { cacheKey: true } });
    expect(left.map((r) => r.cacheKey)).toEqual(['live']);
  });
});
