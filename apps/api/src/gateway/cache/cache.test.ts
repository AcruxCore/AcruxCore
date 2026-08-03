import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { CacheRepository } from './cache.repository';
import type { NormalizedResponse, Usage } from '../providers/types';
import { authedAgent } from '../../test-utils';

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

describe('DELETE /api/v1/gateway/cache', () => {
  it('owner flushes the team cache and gets the deleted count', async () => {
    const owner = await authedAgent(app);
    await repo.store(owner.teamId, 'k1', sampleResponse, sampleUsage, 300);
    await repo.store(owner.teamId, 'k2', sampleResponse, sampleUsage, 300);

    const res = await owner.agent.delete('/api/v1/gateway/cache').expect(200);

    expect(res.body.deleted).toBe(2);
    expect(await prisma.gatewayCache.count({ where: { teamId: owner.teamId } })).toBe(0);
  });

  it('returns { deleted: 0 } when the cache is already empty', async () => {
    const owner = await authedAgent(app);
    const res = await owner.agent.delete('/api/v1/gateway/cache').expect(200);
    expect(res.body.deleted).toBe(0);
  });

  it('does not touch another team’s cache', async () => {
    const owner = await authedAgent(app);
    const other = await authedAgent(app);
    await repo.store(owner.teamId, 'k1', sampleResponse, sampleUsage, 300);
    await repo.store(other.teamId, 'k1', sampleResponse, sampleUsage, 300);

    await owner.agent.delete('/api/v1/gateway/cache').expect(200);

    expect(await prisma.gatewayCache.count({ where: { teamId: other.teamId } })).toBe(1);
  });

  it('rejects an editor with 403', async () => {
    // The signup helper makes each new user the owner of a brand-new team, so to
    // test the editor-403 path we demote a solo user to editor in their own team.
    const soloEditor = await authedAgent(app);
    await prisma.teamMember.update({
      where: { userId_teamId: { userId: soloEditor.userId, teamId: soloEditor.teamId } },
      data: { role: 'editor' },
    });

    const res = await soloEditor.agent.delete('/api/v1/gateway/cache').expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('rejects an unauthenticated caller with 401', async () => {
    await request(app).delete('/api/v1/gateway/cache').expect(401);
  });
});
