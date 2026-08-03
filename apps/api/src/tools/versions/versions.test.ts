import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { signupTestUserWithApiKey } from '../../test-utils';

const app = createApp();

async function createTool(apiKey: string, name = `get_weather_${Date.now()}`): Promise<string> {
  const r = await request(app).post('/api/v1/tools').set('Authorization', `Bearer ${apiKey}`).send({ name }).expect(201);
  return r.body.id;
}

const clientExecutor = { type: 'client' as const };
const paramsSchema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE tool_aliases, tool_versions, tools, prompt_aliases, prompt_versions, audit_log, prompts, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
});
afterAll(async () => { await prisma.$disconnect(); });

describe('tool versions', () => {
  it('commits v1, auto-numbers, and auto-creates production+staging aliases', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await createTool(apiKey);
    const res = await request(app)
      .post(`/api/v1/tools/${toolId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ parametersSchema: paramsSchema, executor: clientExecutor })
      .expect(201);
    expect(res.body.versionNumber).toBe(1);
    expect(res.body.aliases.map((a: { alias: string }) => a.alias).sort()).toEqual(['production', 'staging']);
    const aliasRows = await prisma.toolAlias.findMany({ where: { toolId } });
    expect(aliasRows).toHaveLength(2);
  });

  it('increments the version number and does NOT re-create aliases on v2', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await createTool(apiKey);
    await request(app).post(`/api/v1/tools/${toolId}/versions`).set('Authorization', `Bearer ${apiKey}`)
      .send({ parametersSchema: paramsSchema, executor: clientExecutor }).expect(201);
    // A literal public IP (Cloudflare) — no live DNS lookup needed, so this stays
    // deterministic now that commit-time also runs the SSRF guard (`assertPublicUrl`).
    const v2 = await request(app).post(`/api/v1/tools/${toolId}/versions`).set('Authorization', `Bearer ${apiKey}`)
      .send({ parametersSchema: paramsSchema, executor: { type: 'http', url: 'https://1.1.1.1/w', method: 'GET' } }).expect(201);
    expect(v2.body.versionNumber).toBe(2);
    expect(v2.body.aliases).toBeUndefined();
    const aliasRows = await prisma.toolAlias.findMany({ where: { toolId } });
    expect(aliasRows).toHaveLength(2);
  });

  it('rejects an executor with an unknown type', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await createTool(apiKey);
    const res = await request(app).post(`/api/v1/tools/${toolId}/versions`).set('Authorization', `Bearer ${apiKey}`)
      .send({ parametersSchema: paramsSchema, executor: { type: 'grpc' } }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('lists versions and gets one by number', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await createTool(apiKey);
    await request(app).post(`/api/v1/tools/${toolId}/versions`).set('Authorization', `Bearer ${apiKey}`)
      .send({ parametersSchema: paramsSchema, executor: clientExecutor }).expect(201);
    await request(app).get(`/api/v1/tools/${toolId}/versions`).set('Authorization', `Bearer ${apiKey}`)
      .expect(200).then((r) => expect(r.body.total).toBe(1));
    await request(app).get(`/api/v1/tools/${toolId}/versions/1`).set('Authorization', `Bearer ${apiKey}`)
      .expect(200).then((r) => expect(r.body.executor.type).toBe('client'));
  });

  it('404s committing a version for another team\'s tool', async () => {
    const a = await signupTestUserWithApiKey(app);
    const b = await signupTestUserWithApiKey(app);
    const toolId = await createTool(a.apiKey);
    await request(app).post(`/api/v1/tools/${toolId}/versions`).set('Authorization', `Bearer ${b.apiKey}`)
      .send({ parametersSchema: paramsSchema, executor: clientExecutor }).expect(404);
  });

  it('rejects committing an http tool with a requestTransform that fails to compile', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await createTool(apiKey);
    await request(app).post(`/api/v1/tools/${toolId}/versions`).set('Authorization', `Bearer ${apiKey}`)
      .send({
        parametersSchema: paramsSchema,
        executor: {
          type: 'http',
          url: 'https://api.example.com',
          method: 'GET',
          requestTransform: 'function transform(input) { return {',
        },
      })
      .expect(400);
  });

  it('rejects committing an http tool referencing a missing secret', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await createTool(apiKey);
    await request(app).post(`/api/v1/tools/${toolId}/versions`).set('Authorization', `Bearer ${apiKey}`)
      .send({
        parametersSchema: paramsSchema,
        executor: {
          type: 'http',
          url: 'https://api.example.com',
          method: 'GET',
          headers: [{ name: 'X-Key', value: '{{secret.MISSING}}' }],
        },
      })
      .expect(400);
  });

  // ── TC4 final review Finding 2: commit-time SSRF pre-check (defense-in-depth) ──
  // An obviously-blocked address must be rejected the moment a version is committed,
  // not only the first time someone tries to execute it. This does NOT replace the
  // execute-time `safeFetch` guard in execute.service.ts — that stays, since a
  // hostname's DNS answer can legitimately change between commit and execute.
  it('rejects committing an http tool whose url is an obviously-blocked address (SSRF pre-check)', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await createTool(apiKey);
    const res = await request(app).post(`/api/v1/tools/${toolId}/versions`).set('Authorization', `Bearer ${apiKey}`)
      .send({
        parametersSchema: paramsSchema,
        executor: { type: 'http', url: 'http://169.254.169.254/latest/meta-data/', method: 'GET' },
      })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  // ── changelog / source (tool-path simplification, spec §4.1 + §4.4) ──────────
  // `description` is what the MODEL reads; `changelog` is a note for the team.
  // Before this split, the dashboard's own hint told people to put "what changed"
  // in `description`, which the resolver then served to the LLM as the tool's
  // purpose.
  it('stores changelog and source, and returns them on get and list', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await createTool(apiKey);
    const commit = await request(app)
      .post(`/api/v1/tools/${toolId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        description: 'Get the current weather for a city.',
        changelog: 'v1 - initial import',
        source: 'dashboard',
        parametersSchema: paramsSchema,
        executor: clientExecutor,
      })
      .expect(201);
    expect(commit.body.changelog).toBe('v1 - initial import');
    expect(commit.body.source).toBe('dashboard');

    const got = await request(app)
      .get(`/api/v1/tools/${toolId}/versions/1`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);
    expect(got.body.changelog).toBe('v1 - initial import');
    expect(got.body.source).toBe('dashboard');

    const listed = await request(app)
      .get(`/api/v1/tools/${toolId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);
    expect(listed.body.data[0].source).toBe('dashboard');
    expect(listed.body.data[0].changelog).toBe('v1 - initial import');

    const row = await prisma.toolVersion.findFirst({ where: { toolId, versionNumber: 1 } });
    expect(row?.source).toBe('dashboard');
  });

  it("defaults source to 'api' and rejects source: 'code' from this endpoint", async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await createTool(apiKey);
    const defaulted = await request(app)
      .post(`/api/v1/tools/${toolId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ parametersSchema: paramsSchema, executor: clientExecutor })
      .expect(201);
    expect(defaulted.body.source).toBe('api');

    // Only POST /tools/sync may claim code ownership. If any caller could, a
    // hand-rolled request could make the dashboard warn about a supersede that no
    // deploy will ever perform.
    const rejected = await request(app)
      .post(`/api/v1/tools/${toolId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ source: 'code', parametersSchema: paramsSchema, executor: clientExecutor })
      .expect(400);
    expect(rejected.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('warns when a version has a changelog but no description', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await createTool(apiKey);
    const res = await request(app)
      .post(`/api/v1/tools/${toolId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ changelog: 'v1 - initial import', parametersSchema: paramsSchema, executor: clientExecutor })
      .expect(201);
    expect(res.body.warnings).toEqual([
      'This version has a changelog but no description, so the model will read the tool-level description instead. `description` is what the model reads; `changelog` is a note for your team.',
    ]);

    const quiet = await request(app)
      .post(`/api/v1/tools/${toolId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ description: 'Weather.', changelog: 'v2', parametersSchema: paramsSchema, executor: clientExecutor })
      .expect(201);
    expect(quiet.body.warnings).toBeUndefined();
  });
});
