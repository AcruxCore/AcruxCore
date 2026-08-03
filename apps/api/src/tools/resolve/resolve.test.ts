import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { addUserToTeam, authHeaders, signupTestUserWithApiKey } from '../../test-utils';

const app = createApp();

const paramsSchema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };

/** Registers a tool through the sync endpoint and returns its id. */
async function sync(apiKey: string, body: Record<string, unknown>): Promise<string> {
  const res = await request(app)
    .post('/api/v1/tools/sync')
    .set('Authorization', `Bearer ${apiKey}`)
    .send({ parametersSchema: paramsSchema, executor: { type: 'client' }, ...body })
    .expect(200);
  return res.body.toolId;
}

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE tool_aliases, tool_versions, tools, secrets, prompt_aliases, prompt_versions, audit_log, prompts, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /tools/resolve', () => {
  it('resolves a client tool to its schema, id, version and executor type', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await sync(apiKey, { name: 'get_weather', description: 'Get the weather.' });

    const res = await request(app)
      .post('/api/v1/tools/resolve')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ refs: [{ name: 'get_weather', alias: 'production' }] })
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toEqual({
      toolId,
      versionNumber: 1,
      executorType: 'client',
      function: { name: 'get_weather', description: 'Get the weather.', parameters: paramsSchema },
    });
  });

  it('defaults a missing alias to production and preserves input order', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    await sync(apiKey, { name: 'alpha', description: 'A.' });
    await sync(apiKey, { name: 'beta', description: 'B.' });

    const res = await request(app)
      .post('/api/v1/tools/resolve')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ refs: [{ name: 'beta' }, { name: 'alpha' }] })
      .expect(200);

    expect(res.body.data.map((d: { function: { name: string } }) => d.function.name)).toEqual(['beta', 'alpha']);
  });

  it('never leaks executor headers, urls or {{secret.NAME}} values', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    await request(app)
      .post('/api/v1/secrets')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'WEATHER_KEY', value: 'super-secret-value' })
      .expect(201);
    await sync(apiKey, {
      name: 'get_weather',
      description: 'Get the weather.',
      executor: {
        type: 'http',
        url: 'https://1.1.1.1/weather',
        method: 'GET',
        headers: [{ name: 'x-api-key', value: '{{secret.WEATHER_KEY}}' }],
      },
    });

    const res = await request(app)
      .post('/api/v1/tools/resolve')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ refs: [{ name: 'get_weather' }] })
      .expect(200);

    expect(res.body.data[0].executorType).toBe('http');
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain('super-secret-value');
    expect(serialised).not.toContain('WEATHER_KEY');
    expect(serialised).not.toContain('x-api-key');
    expect(serialised).not.toContain('1.1.1.1');
    expect(res.body.data[0]).not.toHaveProperty('executor');
  });

  it('reports EVERY unresolvable ref in one 404, not just the first', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    await sync(apiKey, { name: 'exists', description: 'E.' });

    const res = await request(app)
      .post('/api/v1/tools/resolve')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        refs: [{ name: 'ghost_one' }, { name: 'exists' }, { name: 'ghost_two' }, { name: 'exists', alias: 'nope' }],
      })
      .expect(404);

    expect(res.body.error.code).toBe('TOOL_REF_NOT_FOUND');
    expect(res.body.error.refs).toEqual([
      { name: 'ghost_one', alias: 'production' },
      { name: 'ghost_two', alias: 'production' },
      { name: 'exists', alias: 'nope' },
    ]);
  });

  it('resolves the tool-level description when the version has a changelog but no description', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const created = await request(app)
      .post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'get_weather', description: 'Tool-level summary.' })
      .expect(201);
    await request(app)
      .post(`/api/v1/tools/${created.body.id}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ changelog: 'v1 - initial import', parametersSchema: paramsSchema, executor: { type: 'client' } })
      .expect(201);

    const res = await request(app)
      .post('/api/v1/tools/resolve')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ refs: [{ name: 'get_weather' }] })
      .expect(200);

    // The changelog must never reach the model; the tool-level description does.
    expect(res.body.data[0].function.description).toBe('Tool-level summary.');
    expect(JSON.stringify(res.body)).not.toContain('initial import');
  });

  it("404s on another team's tool", async () => {
    const a = await signupTestUserWithApiKey(app);
    const b = await signupTestUserWithApiKey(app);
    await sync(a.apiKey, { name: 'get_weather', description: 'A.' });

    await request(app)
      .post('/api/v1/tools/resolve')
      .set('Authorization', `Bearer ${b.apiKey}`)
      .send({ refs: [{ name: 'get_weather' }] })
      .expect(404);
  });

  it('rejects an empty refs array', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    await request(app)
      .post('/api/v1/tools/resolve')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ refs: [] })
      .expect(400)
      .then((r) => expect(r.body.error.code).toBe('VALIDATION_ERROR'));
  });

  it('allows a viewer — resolving is a read', async () => {
    const owner = await signupTestUserWithApiKey(app);
    await sync(owner.apiKey, { name: 'get_weather', description: 'A.' });
    const viewer = await addUserToTeam(app, owner.teamId, 'viewer');

    const res = await request(app)
      .post('/api/v1/tools/resolve')
      .set(authHeaders(viewer))
      .send({ refs: [{ name: 'get_weather' }] })
      .expect(200);
    expect(res.body.data[0].function.name).toBe('get_weather');
  });
});
