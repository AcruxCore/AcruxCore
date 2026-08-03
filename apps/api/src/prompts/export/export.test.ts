import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';

const app = createApp();

interface SetupResult {
  agent: ReturnType<typeof request.agent>;
  apiKey: string;
}

async function signupAndGetKey(): Promise<SetupResult> {
  const { agent } = await authedAgent(app);
  const keyRes = await agent.post('/api/v1/api-keys').send({ name: 'test' });
  return { agent, apiKey: keyRes.body.key };
}

async function createPromptWithVersion(agent: ReturnType<typeof request.agent>, apiKey: string): Promise<{ promptId: string }> {
  const p = await agent
    .post('/api/v1/prompts')
    .send({ name: `export-prompt-${Date.now()}` })
    .expect(201);
  const promptId: string = p.body.id;

  await request(app)
    .post(`/api/v1/prompts/${promptId}/versions`)
    .set('Authorization', `Bearer ${apiKey}`)
    .send({ messages: [{ role: 'system', content: 'You are {{ role }}.' }] })
    .expect(201);

  return { promptId };
}

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE audit_log, prompt_aliases, prompt_versions, prompts, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /api/v1/prompts/:id/versions/:version_number/export', () => {
  it('returns a portable export file with correct schema', async () => {
    const { agent, apiKey } = await signupAndGetKey();
    const { promptId } = await createPromptWithVersion(agent, apiKey);

    const res = await request(app)
      .get(`/api/v1/prompts/${promptId}/versions/1/export`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);

    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toContain('attachment');

    expect(res.body.schemaVersion).toBe(1);
    expect(res.body.exportedAt).toBeDefined();
    expect(res.body.prompt.name).toBeDefined();
    expect(res.body.version.versionNumber).toBe(1);
    expect(Array.isArray(res.body.version.messages)).toBe(true);
    expect(res.body.version.messages[0].content).toBe('You are {{ role }}.');
  });

  it('returns 404 for a non-existent version number', async () => {
    const { agent, apiKey } = await signupAndGetKey();
    const { promptId } = await createPromptWithVersion(agent, apiKey);

    const res = await request(app)
      .get(`/api/v1/prompts/${promptId}/versions/99/export`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(404);

    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 for a non-existent prompt', async () => {
    const { apiKey } = await signupAndGetKey();

    const res = await request(app)
      .get('/api/v1/prompts/00000000-0000-0000-0000-000000000000/versions/1/export')
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(404);

    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
