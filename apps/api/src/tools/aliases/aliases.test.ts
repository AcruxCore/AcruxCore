import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { signupTestUserWithApiKey } from '../../test-utils';

const app = createApp();

const paramsSchema = { type: 'object', properties: {} };
const clientExecutor = { type: 'client' as const };

async function toolWithTwoVersions(apiKey: string): Promise<string> {
  const t = await request(app).post('/api/v1/tools').set('Authorization', `Bearer ${apiKey}`).send({ name: `t_${Date.now()}` }).expect(201);
  await request(app).post(`/api/v1/tools/${t.body.id}/versions`).set('Authorization', `Bearer ${apiKey}`).send({ parametersSchema: paramsSchema, executor: clientExecutor }).expect(201);
  await request(app).post(`/api/v1/tools/${t.body.id}/versions`).set('Authorization', `Bearer ${apiKey}`).send({ parametersSchema: paramsSchema, executor: clientExecutor }).expect(201);
  return t.body.id;
}

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE tool_aliases, tool_versions, tools, prompt_aliases, prompt_versions, audit_log, prompts, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
});
afterAll(async () => { await prisma.$disconnect(); });

describe('tool aliases', () => {
  it('lists the auto-created aliases (both at v1)', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await toolWithTwoVersions(apiKey);
    const res = await request(app).get(`/api/v1/tools/${toolId}/aliases`).set('Authorization', `Bearer ${apiKey}`).expect(200);
    const byName = Object.fromEntries(res.body.data.map((a: { alias: string; versionNumber: number }) => [a.alias, a.versionNumber]));
    expect(byName.production).toBe(1);
    expect(byName.staging).toBe(1);
  });

  it('promotes production to v2, and rolls back to v1', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await toolWithTwoVersions(apiKey);
    await request(app).post(`/api/v1/tools/${toolId}/aliases/production/promote`).set('Authorization', `Bearer ${apiKey}`)
      .send({ version_number: 2 }).expect(200).then((r) => expect(r.body.versionNumber).toBe(2));
    // rollback == promote to an older number
    await request(app).post(`/api/v1/tools/${toolId}/aliases/production/promote`).set('Authorization', `Bearer ${apiKey}`)
      .send({ version_number: 1 }).expect(200).then((r) => expect(r.body.versionNumber).toBe(1));
    const row = await prisma.toolAlias.findFirst({ where: { toolId, alias: 'production' }, include: { version: true } });
    expect(row!.version.versionNumber).toBe(1);
  });

  it('404s promoting to a non-existent version', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await toolWithTwoVersions(apiKey);
    await request(app).post(`/api/v1/tools/${toolId}/aliases/production/promote`).set('Authorization', `Bearer ${apiKey}`)
      .send({ version_number: 99 }).expect(404);
  });
});
