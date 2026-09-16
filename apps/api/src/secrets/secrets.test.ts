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

describe('secret names are matched literally (issue #490)', () => {
  it('deletes a secret whose name differs from another only at an underscore', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${apiKey}`);

    const victim = await auth(request(app).post('/api/v1/secrets'))
      .send({ name: 'WEATHER_KEY', value: 'aaaa1111' }).expect(201);
    await auth(request(app).post('/api/v1/secrets'))
      .send({ name: 'WEATHERXKEY', value: 'bbbb2222' }).expect(201);

    const tool = await auth(request(app).post('/api/v1/tools'))
      .send({ name: `underscore_probe_${Date.now()}` }).expect(201);
    await auth(request(app).post(`/api/v1/tools/${tool.body.id}/versions`)).send({
      description: 'references WEATHERXKEY only',
      parametersSchema: { type: 'object', properties: {}, required: [] },
      executor: {
        type: 'http', method: 'GET', url: 'https://example.com/weather',
        headers: [{ name: 'Authorization', value: 'Bearer {{secret.WEATHERXKEY}}' }],
      },
    }).expect(201);

    // `_` is LIKE's single-character wildcard, so WEATHER_KEY used to match the
    // WEATHERXKEY reference and the delete was refused naming a tool that does
    // not use it — leaving the secret impossible to remove.
    await auth(request(app).delete(`/api/v1/secrets/${victim.body.id}`)).expect(204);
  }, 60000);

  it('still refuses to delete a secret a tool really does reference', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${apiKey}`);
    const used = await auth(request(app).post('/api/v1/secrets'))
      .send({ name: 'REALLY_USED', value: 'cccc3333' }).expect(201);
    const tool = await auth(request(app).post('/api/v1/tools'))
      .send({ name: `real_ref_${Date.now()}` }).expect(201);
    await auth(request(app).post(`/api/v1/tools/${tool.body.id}/versions`)).send({
      description: 'genuinely uses it',
      parametersSchema: { type: 'object', properties: {}, required: [] },
      executor: {
        type: 'http', method: 'GET', url: 'https://example.com/x',
        headers: [{ name: 'Authorization', value: 'Bearer {{secret.REALLY_USED}}' }],
      },
    }).expect(201);

    await auth(request(app).delete(`/api/v1/secrets/${used.body.id}`)).expect(409);
  }, 60000);
});
