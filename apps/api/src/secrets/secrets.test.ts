import request from 'supertest';
import { createApp } from '../../app';
import prisma from '../shared/db/client';
import { signupTestUserWithApiKey } from '../test-utils';

const app = createApp();

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE secrets, tool_aliases, tool_versions, tools, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
});
afterAll(async () => { await prisma.$disconnect(); });

describe('secrets', () => {
  it('creates a secret exposing only lastFour, never the value', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const res = await request(app).post('/api/v1/secrets').set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'WEATHER_KEY', value: 'sk-abcd1234' }).expect(201);
    expect(res.body).toEqual(expect.objectContaining({ name: 'WEATHER_KEY', lastFour: '1234' }));
    expect(JSON.stringify(res.body)).not.toContain('sk-abcd1234');
    const row = await prisma.secret.findFirst({ where: { name: 'WEATHER_KEY' } });
    expect(row!.lastFour).toBe('1234');
  });

  it('lists secrets without values and rotates a value', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const { body: created } = await request(app).post('/api/v1/secrets').set('Authorization', `Bearer ${apiKey}`).send({ name: 'K', value: 'aaaa1111' }).expect(201);
    const list = await request(app).get('/api/v1/secrets').set('Authorization', `Bearer ${apiKey}`).expect(200);
    expect(list.body[0]).toEqual(expect.objectContaining({ name: 'K', lastFour: '1111' }));
    expect(JSON.stringify(list.body)).not.toContain('aaaa1111');
    await request(app).put(`/api/v1/secrets/${created.id}`).set('Authorization', `Bearer ${apiKey}`).send({ value: 'bbbb2222' }).expect(200)
      .then((r) => expect(r.body.lastFour).toBe('2222'));
  });

  it('rejects a duplicate name', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    await request(app).post('/api/v1/secrets').set('Authorization', `Bearer ${apiKey}`).send({ name: 'DUP', value: 'x1234' }).expect(201);
    await request(app).post('/api/v1/secrets').set('Authorization', `Bearer ${apiKey}`).send({ name: 'DUP', value: 'y5678' }).expect(409);
  });

  it('deletes an unreferenced secret', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const { body } = await request(app).post('/api/v1/secrets').set('Authorization', `Bearer ${apiKey}`).send({ name: 'GONE', value: 'z9999' }).expect(201);
    await request(app).delete(`/api/v1/secrets/${body.id}`).set('Authorization', `Bearer ${apiKey}`).expect(204);
  });

  it('blocks deleting a secret referenced by a live tool, but allows it once that tool is deleted', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const auth = { Authorization: `Bearer ${apiKey}` };
    const { body: secret } = await request(app).post('/api/v1/secrets').set(auth)
      .send({ name: 'REF_KEY', value: 'ref-value-1234' }).expect(201);
    const { body: tool } = await request(app).post('/api/v1/tools').set(auth)
      .send({ name: 'referencing-tool', description: 'uses REF_KEY' }).expect(201);
    await request(app).post(`/api/v1/tools/${tool.id}/versions`).set(auth).send({
      parametersSchema: { type: 'object', properties: {}, required: [] },
      executor: { type: 'http', method: 'GET', url: 'https://example.com', query: [{ name: 'api_key', value: '{{secret.REF_KEY}}' }] },
    }).expect(201);

    await request(app).delete(`/api/v1/secrets/${secret.id}`).set(auth).expect(409);

    await request(app).delete(`/api/v1/tools/${tool.id}`).set(auth).expect(204);
    await request(app).delete(`/api/v1/secrets/${secret.id}`).set(auth).expect(204);
  });
});
