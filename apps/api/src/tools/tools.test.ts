import request from 'supertest';
import { createApp } from '../../app';
import prisma from '../shared/db/client';
import { signupTestUserWithApiKey } from '../test-utils';

const app = createApp();

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE tool_aliases, tool_versions, tools, prompt_aliases, prompt_versions, audit_log, prompts, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
});
afterAll(async () => { await prisma.$disconnect(); });

describe('tools CRUD', () => {
  it('creates a tool and persists a DB row', async () => {
    const { apiKey, teamId, userId } = await signupTestUserWithApiKey(app);
    const res = await request(app)
      .post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'get_weather', description: 'Fetch weather' })
      .expect(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe('get_weather');
    expect(res.body.teamId).toBe(teamId);
    expect(res.body.createdBy).toBe(userId);
    const row = await prisma.tool.findUnique({ where: { id: res.body.id } });
    expect(row!.name).toBe('get_weather');
    expect(row!.deletedAt).toBeNull();
  });

  it('rejects an invalid tool name (must match provider regex)', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const res = await request(app)
      .post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'bad name!' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('lists, gets, updates, and soft-deletes a tool', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const { body: created } = await request(app).post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`).send({ name: 'get_weather' }).expect(201);

    await request(app).get('/api/v1/tools').set('Authorization', `Bearer ${apiKey}`)
      .expect(200).then((r) => expect(r.body.total).toBe(1));

    await request(app).get(`/api/v1/tools/${created.id}`).set('Authorization', `Bearer ${apiKey}`)
      .expect(200).then((r) => expect(r.body.name).toBe('get_weather'));

    await request(app).patch(`/api/v1/tools/${created.id}`).set('Authorization', `Bearer ${apiKey}`)
      .send({ description: 'updated' }).expect(200).then((r) => expect(r.body.description).toBe('updated'));

    await request(app).delete(`/api/v1/tools/${created.id}`).set('Authorization', `Bearer ${apiKey}`).expect(204);
    const row = await prisma.tool.findUnique({ where: { id: created.id } });
    expect(row!.deletedAt).not.toBeNull();
    await request(app).get(`/api/v1/tools/${created.id}`).set('Authorization', `Bearer ${apiKey}`).expect(404);
  });

  it('isolates tools across teams', async () => {
    const a = await signupTestUserWithApiKey(app);
    const b = await signupTestUserWithApiKey(app);
    const { body: created } = await request(app).post('/api/v1/tools')
      .set('Authorization', `Bearer ${a.apiKey}`).send({ name: 'team_a_tool' }).expect(201);
    await request(app).get(`/api/v1/tools/${created.id}`).set('Authorization', `Bearer ${b.apiKey}`).expect(404);
  });

  // A tool name is how `POST /tools/sync` and every `tool_ref` find a tool, so two
  // active tools sharing a name inside one team make resolution ambiguous. The DB
  // enforces it; this asserts the caller sees a 409 rather than a leaked 500.
  it('rejects a duplicate tool name within a team with 409', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    await request(app).post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`).send({ name: 'get_weather' }).expect(201);

    const conflict = await request(app).post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`).send({ name: 'get_weather' }).expect(409);
    expect(conflict.body.error.code).toBe('TOOL_NAME_TAKEN');
  });

  it('frees a tool name for reuse once the tool is soft-deleted', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const { body: first } = await request(app).post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`).send({ name: 'get_weather' }).expect(201);
    await request(app).delete(`/api/v1/tools/${first.id}`).set('Authorization', `Bearer ${apiKey}`).expect(204);

    const { body: second } = await request(app).post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`).send({ name: 'get_weather' }).expect(201);
    expect(second.id).not.toBe(first.id);
  });

  it('lets two different teams each have a tool with the same name', async () => {
    const a = await signupTestUserWithApiKey(app);
    const b = await signupTestUserWithApiKey(app);
    await request(app).post('/api/v1/tools')
      .set('Authorization', `Bearer ${a.apiKey}`).send({ name: 'get_weather' }).expect(201);
    await request(app).post('/api/v1/tools')
      .set('Authorization', `Bearer ${b.apiKey}`).send({ name: 'get_weather' }).expect(201);
  });
});
