import prisma from '../../shared/db/client';
import { UsageRepository } from './usage.repository';

const repo = new UsageRepository();

let teamId: string;
let vk1: string;
let vk2: string;

const FROM = new Date('2026-06-01T00:00:00Z');
const TO = new Date('2026-07-01T00:00:00Z');

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE
    gateway_requests, gateway_cache, budgets, virtual_keys, provider_connections,
    audit_log, prompt_aliases, prompt_versions, prompts,
    api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`;

  // Minimal real user + team + two virtual keys (FK targets for virtual_key_id).
  const user = await prisma.user.create({
    data: { email: `agg-${Date.now()}@example.com` },
  });
  const team = await prisma.team.create({ data: { name: 'agg-team' } });
  teamId = team.id;
  const k1 = await prisma.virtualKey.create({
    data: { teamId, name: 'vk1', keyHash: 'hash-1', keyLastFour: 'aaaa', createdBy: user.id },
  });
  const k2 = await prisma.virtualKey.create({
    data: { teamId, name: 'vk2', keyHash: 'hash-2', keyLastFour: 'bbbb', createdBy: user.id },
  });
  vk1 = k1.id;
  vk2 = k2.id;

  await prisma.gatewayRequest.createMany({
    data: [
      { teamId, virtualKeyId: vk1, provider: 'openai', requestedModel: 'gpt-4o-mini', resolvedModel: 'gpt-4o-mini', status: 'success', promptTokens: 100, completionTokens: 20, totalTokens: 120, costUsd: 0.001, cacheHit: false, createdAt: new Date('2026-06-10T10:00:00Z') },
      { teamId, virtualKeyId: vk1, provider: 'openai', requestedModel: 'gpt-4o-mini', resolvedModel: 'gpt-4o-mini', status: 'success', promptTokens: 200, completionTokens: 40, totalTokens: 240, costUsd: 0.002, cacheHit: false, createdAt: new Date('2026-06-10T12:00:00Z') },
      { teamId, virtualKeyId: vk2, provider: 'openai', requestedModel: 'gpt-4o', resolvedModel: 'gpt-4o', status: 'success', promptTokens: 300, completionTokens: 60, totalTokens: 360, costUsd: 0.010, cacheHit: false, createdAt: new Date('2026-06-11T10:00:00Z') },
      { teamId, virtualKeyId: vk1, provider: 'openai', requestedModel: 'gpt-4o-mini', resolvedModel: 'gpt-4o-mini', status: 'cache_hit', promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, cacheHit: true, createdAt: new Date('2026-06-11T11:00:00Z') },
      { teamId, virtualKeyId: vk2, provider: 'anthropic', requestedModel: 'claude-3-5-sonnet', resolvedModel: 'claude-3-5-sonnet', status: 'error', promptTokens: 150, completionTokens: 30, totalTokens: 180, costUsd: 0, cacheHit: false, errorCode: 'PROVIDER_ERROR', createdAt: new Date('2026-06-11T13:00:00Z') },
    ],
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('UsageRepository.aggregateUsage', () => {
  it('computes correct totals across the range', async () => {
    const { totals } = await repo.aggregateUsage(teamId, FROM, TO, 'day');
    expect(totals.requests).toBe(5);
    expect(totals.promptTokens).toBe(750);
    expect(totals.completionTokens).toBe(150);
    expect(totals.costUsd).toBeCloseTo(0.013, 6);
    expect(totals.cacheHitRate).toBeCloseTo(0.2, 6);
    expect(totals.errorRate).toBeCloseTo(0.2, 6);
  });

  it('groups by model with per-model sums', async () => {
    const { buckets } = await repo.aggregateUsage(teamId, FROM, TO, 'model');
    const byKey = Object.fromEntries(buckets.map((b) => [b.key, b]));
    expect(byKey['gpt-4o-mini'].requests).toBe(3);
    expect(byKey['gpt-4o-mini'].promptTokens).toBe(300);
    expect(byKey['gpt-4o-mini'].costUsd).toBeCloseTo(0.003, 6);
    expect(byKey['gpt-4o'].requests).toBe(1);
    expect(byKey['gpt-4o'].costUsd).toBeCloseTo(0.010, 6);
    expect(byKey['claude-3-5-sonnet'].requests).toBe(1);
    expect(byKey['claude-3-5-sonnet'].costUsd).toBeCloseTo(0, 6);
  });

  it('groups by day', async () => {
    const { buckets } = await repo.aggregateUsage(teamId, FROM, TO, 'day');
    const byKey = Object.fromEntries(buckets.map((b) => [b.key, b]));
    expect(byKey['2026-06-10'].requests).toBe(2);
    expect(byKey['2026-06-10'].promptTokens).toBe(300);
    expect(byKey['2026-06-11'].requests).toBe(3);
  });

  it('groups by provider', async () => {
    const { buckets } = await repo.aggregateUsage(teamId, FROM, TO, 'provider');
    const byKey = Object.fromEntries(buckets.map((b) => [b.key, b]));
    expect(byKey['openai'].requests).toBe(4);
    expect(byKey['anthropic'].requests).toBe(1);
  });

  it('filters by virtual_key_id', async () => {
    const { totals, buckets } = await repo.aggregateUsage(teamId, FROM, TO, 'virtual_key', vk1);
    expect(totals.requests).toBe(3);
    expect(totals.costUsd).toBeCloseTo(0.003, 6);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].key).toBe(vk1);
    expect(buckets[0].requests).toBe(3);
  });
});

describe('UsageRepository.listRequests / getRequest', () => {
  it('paginates newest-first and reports total', async () => {
    const { rows, total } = await repo.listRequests(teamId, {}, 1, 2);
    expect(total).toBe(5);
    expect(rows).toHaveLength(2);
    expect(new Date(rows[0].createdAt).getTime()).toBeGreaterThanOrEqual(new Date(rows[1].createdAt).getTime());
  });

  it('filters by status', async () => {
    const { rows, total } = await repo.listRequests(teamId, { status: 'error' }, 1, 20);
    expect(total).toBe(1);
    expect(rows[0].errorCode).toBe('PROVIDER_ERROR');
    expect(rows[0].costUsd).toBe(0);
  });

  it('getRequest returns a single row scoped to the team, else null', async () => {
    const { rows } = await repo.listRequests(teamId, {}, 1, 1);
    const found = await repo.getRequest(teamId, rows[0].id);
    expect(found?.id).toBe(rows[0].id);
    const missing = await repo.getRequest(teamId, '00000000-0000-0000-0000-000000000000');
    expect(missing).toBeNull();
  });
});
