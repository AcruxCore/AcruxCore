import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { CacheRepository } from './cache.repository';
import type { NormalizedResponse, Usage } from '../providers/types';
import { signupTestUser } from '../../test-utils';

const app = createApp();
const repo = new CacheRepository();

const sampleResponse: NormalizedResponse = {
  id: 'chatcmpl-test',
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
};
const sampleUsage: Usage = { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 };

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE
    gateway_cache, team_invites, audit_log, prompt_aliases, prompt_versions, prompts,
    api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('CacheRepository', () => {
  it('store then lookup returns the stored response and token counts', async () => {
    const { teamId } = await signupTestUser(app);

    await repo.store(teamId, 'key-1', sampleResponse, sampleUsage, 300);
    const hit = await repo.lookup(teamId, 'key-1');

    expect(hit).toBeDefined();
    expect(hit!.response.choices[0].message.content).toBe('Hi');
    expect(hit!.promptTokens).toBe(12);
    expect(hit!.completionTokens).toBe(1);
  });

  it('lookup returns undefined for a missing key', async () => {
    const { teamId } = await signupTestUser(app);
    expect(await repo.lookup(teamId, 'nope')).toBeUndefined();
  });

  it('treats an expired row as a miss', async () => {
    const { teamId } = await signupTestUser(app);

    await repo.store(teamId, 'key-exp', sampleResponse, sampleUsage, 300);
    // Force expiry into the past.
    await prisma.gatewayCache.updateMany({
      where: { teamId, cacheKey: 'key-exp' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect(await repo.lookup(teamId, 'key-exp')).toBeUndefined();
  });

  it('store upserts on conflict (team_id, cache_key) — refreshes response + expiry', async () => {
    const { teamId } = await signupTestUser(app);

    await repo.store(teamId, 'key-up', sampleResponse, sampleUsage, 300);
    const updated: NormalizedResponse = {
      ...sampleResponse,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello again' }, finish_reason: 'stop' }],
    };
    await repo.store(teamId, 'key-up', updated, { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 }, 300);

    const rows = await prisma.gatewayCache.findMany({ where: { teamId, cacheKey: 'key-up' } });
    expect(rows).toHaveLength(1); // upsert, not a second insert
    const hit = await repo.lookup(teamId, 'key-up');
    expect(hit!.response.choices[0].message.content).toBe('Hello again');
    expect(hit!.promptTokens).toBe(20);
  });

  it('flushTeam deletes only that team’s rows and returns the count', async () => {
    const { teamId: teamA } = await signupTestUser(app);
    const { teamId: teamB } = await signupTestUser(app);

    await repo.store(teamA, 'a1', sampleResponse, sampleUsage, 300);
    await repo.store(teamA, 'a2', sampleResponse, sampleUsage, 300);
    await repo.store(teamB, 'b1', sampleResponse, sampleUsage, 300);

    const deleted = await repo.flushTeam(teamA);
    expect(deleted).toBe(2);

    expect(await prisma.gatewayCache.count({ where: { teamId: teamA } })).toBe(0);
    expect(await prisma.gatewayCache.count({ where: { teamId: teamB } })).toBe(1); // untouched
  });

  it('two teams with the same cache_key get separate rows (no cross-tenant hit)', async () => {
    const { teamId: teamA } = await signupTestUser(app);
    const { teamId: teamB } = await signupTestUser(app);

    await repo.store(teamA, 'shared-key', sampleResponse, sampleUsage, 300);

    // Team B has never stored 'shared-key' → miss, even though team A has it.
    expect(await repo.lookup(teamB, 'shared-key')).toBeUndefined();
    expect(await repo.lookup(teamA, 'shared-key')).toBeDefined();
  });
});
