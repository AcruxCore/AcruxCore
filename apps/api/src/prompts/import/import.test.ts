import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { signupTestUserWithApiKey } from '../../test-utils';

const app = createApp();

const validPayload = {
  schemaVersion: 1,
  exportedAt: '2026-01-01T00:00:00.000Z',
  prompt: { name: 'imported-prompt', description: null },
  version: {
    versionNumber: 1,
    messages: [{ role: 'system', content: 'You are {{ role }}.' }],
    variables: ['role'],
    createdAt: '2026-01-01T00:00:00.000Z',
  },
};

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE audit_log, prompt_aliases, prompt_versions, prompts, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /api/v1/prompts/import', () => {
  it('creates a new prompt and version 1 from a valid export file', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);

    const res = await request(app)
      .post('/api/v1/prompts/import')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(validPayload)
      .expect(201);

    expect(res.body.prompt.id).toBeDefined();
    expect(res.body.prompt.name).toBe('imported-prompt');
    expect(res.body.version.id).toBeDefined();
    expect(res.body.version.versionNumber).toBe(1);

    const row = await prisma.promptVersion.findFirst({
      where: { promptId: res.body.prompt.id },
    });
    expect(row).not.toBeNull();
    expect(row!.versionNumber).toBe(1);
  });

  it('re-derives variables from message content, ignoring imported variables field', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);

    const payload = {
      ...validPayload,
      prompt: { name: 'derive-vars-prompt', description: null },
      version: {
        messages: [{ role: 'system', content: 'Hello {{ user }}, your code is {{ code }}.' }],
        variables: ['wrong', 'completely-ignored'],
      },
    };

    const res = await request(app)
      .post('/api/v1/prompts/import')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(payload)
      .expect(201);

    const row = await prisma.promptVersion.findFirst({
      where: { promptId: res.body.prompt.id },
    });
    expect(row).not.toBeNull();
    const vars = row!.variables as string[];
    expect(vars).toContain('user');
    expect(vars).toContain('code');
    expect(vars).not.toContain('wrong');
  });

  it('resolves name collisions by appending -imported-<ms>', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);

    await request(app)
      .post('/api/v1/prompts/import')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(validPayload)
      .expect(201);

    const res2 = await request(app)
      .post('/api/v1/prompts/import')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(validPayload)
      .expect(201);

    expect(res2.body.prompt.name).toMatch(/imported-prompt-imported-\d+/);
  });

  it('creates production and staging aliases pointing to version 1', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);

    const res = await request(app)
      .post('/api/v1/prompts/import')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ ...validPayload, prompt: { name: 'alias-check-prompt', description: null } })
      .expect(201);

    const aliases = await prisma.promptAlias.findMany({
      where: { promptId: res.body.prompt.id },
    });
    const aliasNames = aliases.map(a => a.alias);
    expect(aliasNames).toContain('production');
    expect(aliasNames).toContain('staging');
    for (const a of aliases) {
      expect(a.versionId).toBe(res.body.version.id);
    }
  });

  it('returns 400 UNSUPPORTED_SCHEMA_VERSION for schemaVersion !== 1', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);

    const res = await request(app)
      .post('/api/v1/prompts/import')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ ...validPayload, schemaVersion: 2 })
      .expect(400);

    expect(res.body.error.code).toBe('UNSUPPORTED_SCHEMA_VERSION');
  });

  it('returns 400 VALIDATION_ERROR when prompt.name is missing', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);

    const res = await request(app)
      .post('/api/v1/prompts/import')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ schemaVersion: 1, prompt: { name: '' }, version: { messages: [{ role: 'user', content: 'hi' }] } })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 VALIDATION_ERROR when version.messages is empty', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);

    const res = await request(app)
      .post('/api/v1/prompts/import')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ schemaVersion: 1, prompt: { name: 'x' }, version: { messages: [] } })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 401 when no auth is provided', async () => {
    await request(app)
      .post('/api/v1/prompts/import')
      .send(validPayload)
      .expect(401);
  });
});
