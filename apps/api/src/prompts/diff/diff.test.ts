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

async function setupTwoVersions(agent: ReturnType<typeof request.agent>, apiKey: string): Promise<{ promptId: string }> {
  const p = await agent
    .post('/api/v1/prompts')
    .send({ name: `diff-prompt-${Date.now()}` })
    .expect(201);
  const promptId: string = p.body.id;

  await request(app)
    .post(`/api/v1/prompts/${promptId}/versions`)
    .set('Authorization', `Bearer ${apiKey}`)
    .send({ messages: [{ role: 'system', content: 'Hello {{ name }}' }] })
    .expect(201);

  await request(app)
    .post(`/api/v1/prompts/${promptId}/versions`)
    .set('Authorization', `Bearer ${apiKey}`)
    .send({ messages: [{ role: 'system', content: 'Hi there, {{ name }}!' }] })
    .expect(201);

  return { promptId };
}

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE audit_log, prompt_aliases, prompt_versions, prompts, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /api/v1/prompts/:id/versions/diff', () => {
  it('returns a unified diff between v1 and v2', async () => {
    const { agent, apiKey } = await signupAndGetKey();
    const { promptId } = await setupTwoVersions(agent, apiKey);

    const res = await request(app)
      .get(`/api/v1/prompts/${promptId}/versions/diff?from=1&to=2`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);

    expect(res.body.diff).toContain('Hello {{ name }}');
    expect(res.body.diff).toContain('Hi there, {{ name }}!');
    expect(res.body.fromVersion).toBe(1);
    expect(res.body.toVersion).toBe(2);
  });

  it('returns an empty-hunk diff when comparing a version to itself', async () => {
    const { agent, apiKey } = await signupAndGetKey();
    const { promptId } = await setupTwoVersions(agent, apiKey);

    const res = await request(app)
      .get(`/api/v1/prompts/${promptId}/versions/diff?from=1&to=1`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);

    expect(res.body.diff).toBeDefined();
    expect(res.body.fromVersion).toBe(1);
    expect(res.body.toVersion).toBe(1);
  });

  it('returns 404 when a version number does not exist', async () => {
    const { agent, apiKey } = await signupAndGetKey();
    const { promptId } = await setupTwoVersions(agent, apiKey);

    const res = await request(app)
      .get(`/api/v1/prompts/${promptId}/versions/diff?from=1&to=99`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(404);

    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 for a non-existent prompt', async () => {
    const { apiKey } = await signupAndGetKey();

    const res = await request(app)
      .get('/api/v1/prompts/00000000-0000-0000-0000-000000000000/versions/diff?from=1&to=2')
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(404);

    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 when query params are missing', async () => {
    const { agent, apiKey } = await signupAndGetKey();
    const { promptId } = await setupTwoVersions(agent, apiKey);

    await request(app)
      .get(`/api/v1/prompts/${promptId}/versions/diff`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(400);
  });
});
