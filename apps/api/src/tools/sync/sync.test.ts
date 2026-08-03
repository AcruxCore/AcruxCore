import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { addUserToTeam, authHeaders, signupTestUserWithApiKey } from '../../test-utils';

const app = createApp();

const paramsSchema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
const clientExecutor = { type: 'client' as const };

/** The canonical sync body used by most tests; spread it and override one field. */
function syncBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parametersSchema: paramsSchema,
    executor: clientExecutor,
    alias: 'production',
    source: 'code',
    ...overrides,
  };
}

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE tool_aliases, tool_versions, tools, prompt_aliases, prompt_versions, audit_log, prompts, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /tools/sync', () => {
  it('creates the tool, v1 and both aliases when the name does not exist', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const res = await request(app)
      .post('/api/v1/tools/sync')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(syncBody())
      .expect(200);

    expect(res.body.committed).toBe(true);
    expect(res.body.versionNumber).toBe(1);
    expect(res.body.alias).toBe('production');
    expect(res.body.supersededSource).toBeUndefined();

    const tool = await prisma.tool.findFirst({ where: { name: 'get_weather' } });
    expect(tool?.id).toBe(res.body.toolId);
    expect(tool?.description).toBe('Get the current weather for a city.');
    const version = await prisma.toolVersion.findFirst({ where: { toolId: tool!.id } });
    expect(version?.source).toBe('code');
    const aliases = await prisma.toolAlias.findMany({ where: { toolId: tool!.id } });
    expect(aliases.map((a) => a.alias).sort()).toEqual(['production', 'staging']);
  });

  it('commits nothing when the spec is unchanged', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const first = await request(app)
      .post('/api/v1/tools/sync')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(syncBody())
      .expect(200);
    const second = await request(app)
      .post('/api/v1/tools/sync')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(syncBody())
      .expect(200);

    expect(second.body.committed).toBe(false);
    expect(second.body.versionNumber).toBe(first.body.versionNumber);
    expect(await prisma.toolVersion.count({ where: { toolId: first.body.toolId } })).toBe(1);
  });

  it('commits a new version when only the description changed', async () => {
    // The case the old hand-rolled registry helper's spec comparison missed — it checked
    // only the schema and the executor, which is why a wrong model-facing description
    // once survived a re-run.
    const { apiKey } = await signupTestUserWithApiKey(app);
    await request(app).post('/api/v1/tools/sync').set('Authorization', `Bearer ${apiKey}`).send(syncBody()).expect(200);
    const res = await request(app)
      .post('/api/v1/tools/sync')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(syncBody({ description: 'Get the current weather, in Celsius, for a city.' }))
      .expect(200);

    expect(res.body.committed).toBe(true);
    expect(res.body.versionNumber).toBe(2);
    const alias = await prisma.toolAlias.findFirst({
      where: { toolId: res.body.toolId, alias: 'production' },
      include: { version: true },
    });
    expect(alias?.version.versionNumber).toBe(2);
    expect(alias?.version.description).toBe('Get the current weather, in Celsius, for a city.');
  });

  it('commits nothing when only the key order of parametersSchema differs', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const first = await request(app)
      .post('/api/v1/tools/sync')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(syncBody())
      .expect(200);
    const reordered = { required: ['city'], properties: { city: { type: 'string' } }, type: 'object' };
    const second = await request(app)
      .post('/api/v1/tools/sync')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(syncBody({ parametersSchema: reordered }))
      .expect(200);

    expect(second.body.committed).toBe(false);
    expect(await prisma.toolVersion.count({ where: { toolId: first.body.toolId } })).toBe(1);
  });

  it('commits a new version when the executor changed', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    await request(app).post('/api/v1/tools/sync').set('Authorization', `Bearer ${apiKey}`).send(syncBody()).expect(200);
    // A literal public IP keeps the commit-time SSRF guard deterministic (no DNS).
    const res = await request(app)
      .post('/api/v1/tools/sync')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(syncBody({ executor: { type: 'http', url: 'https://1.1.1.1/w', method: 'GET' }, source: 'api' }))
      .expect(200);
    expect(res.body.committed).toBe(true);
    expect(res.body.versionNumber).toBe(2);
  });

  it('reports supersededSource when it overwrites a dashboard version, and writes an audit row', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const created = await request(app)
      .post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'get_weather' })
      .expect(201);
    await request(app)
      .post(`/api/v1/tools/${created.body.id}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        description: 'Hand-edited in the dashboard.',
        source: 'dashboard',
        parametersSchema: paramsSchema,
        executor: clientExecutor,
      })
      .expect(201);

    const res = await request(app)
      .post('/api/v1/tools/sync')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(syncBody())
      .expect(200);

    expect(res.body.committed).toBe(true);
    expect(res.body.supersededSource).toBe('dashboard');
    const audits = await prisma.auditLog.findMany({ where: { event: 'tool_version_superseded' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({
      toolId: created.body.id,
      supersededVersionNumber: 1,
      newVersionNumber: 2,
      supersededSource: 'dashboard',
    });
  });

  it('does NOT report supersededSource when it overwrites a code version', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    await request(app).post('/api/v1/tools/sync').set('Authorization', `Bearer ${apiKey}`).send(syncBody()).expect(200);
    const res = await request(app)
      .post('/api/v1/tools/sync')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(syncBody({ description: 'Changed.' }))
      .expect(200);
    expect(res.body.committed).toBe(true);
    expect(res.body.supersededSource).toBeUndefined();
    expect(await prisma.auditLog.count({ where: { event: 'tool_version_superseded' } })).toBe(0);
  });

  it('moves only the requested alias, leaving the other one behind', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const first = await request(app)
      .post('/api/v1/tools/sync')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(syncBody())
      .expect(200);
    await request(app)
      .post('/api/v1/tools/sync')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(syncBody({ alias: 'staging', description: 'Staging-only change.' }))
      .expect(200);

    const rows = await prisma.toolAlias.findMany({
      where: { toolId: first.body.toolId },
      include: { version: true },
    });
    const byName = Object.fromEntries(rows.map((r) => [r.alias, r.version.versionNumber]));
    expect(byName['staging']).toBe(2);
    expect(byName['production']).toBe(1);
  });

  it("scopes by team — one team cannot sync over another team's tool", async () => {
    const a = await signupTestUserWithApiKey(app);
    const b = await signupTestUserWithApiKey(app);
    const first = await request(app)
      .post('/api/v1/tools/sync')
      .set('Authorization', `Bearer ${a.apiKey}`)
      .send(syncBody())
      .expect(200);
    const second = await request(app)
      .post('/api/v1/tools/sync')
      .set('Authorization', `Bearer ${b.apiKey}`)
      .send(syncBody())
      .expect(200);

    expect(second.body.toolId).not.toBe(first.body.toolId);
    expect(await prisma.tool.count({ where: { name: 'get_weather' } })).toBe(2);
  });

  // The shell description (tools.description) is NOT versioned, so unlike a version
  // description it cannot be recovered after an overwrite. sync therefore fills it only
  // when it is empty — otherwise a code sync would silently destroy a human-written
  // label, which is exactly what the ownership design promises it never does.
  it('never overwrites a hand-written tool-level description', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const created = await request(app)
      .post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'get_weather', description: 'Written by a human in the dashboard.' })
      .expect(201);

    await request(app)
      .post('/api/v1/tools/sync')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(syncBody({ description: 'Derived from the docstring.' }))
      .expect(200);

    const tool = await prisma.tool.findUnique({ where: { id: created.body.id } });
    expect(tool?.description).toBe('Written by a human in the dashboard.');
    // The model still reads the code's text, because the VERSION description wins.
    const resolved = await request(app)
      .post('/api/v1/tools/resolve')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ refs: [{ name: 'get_weather' }] })
      .expect(200);
    expect(resolved.body.data[0].function.description).toBe('Derived from the docstring.');
  });

  it('fills an empty tool-level description from the code, and never blanks one out', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const created = await request(app)
      .post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'get_weather' })
      .expect(201);
    expect(created.body.description).toBeNull();

    await request(app)
      .post('/api/v1/tools/sync')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(syncBody({ description: 'Derived from the docstring.' }))
      .expect(200);
    const filled = await prisma.tool.findUnique({ where: { id: created.body.id } });
    expect(filled?.description).toBe('Derived from the docstring.');

    // A decorated function with no docstring sends no description. That must not clear
    // the label that is now there.
    const body = syncBody({ parametersSchema: { type: 'object', properties: {} } });
    delete (body as { description?: string }).description;
    await request(app).post('/api/v1/tools/sync').set('Authorization', `Bearer ${apiKey}`).send(body).expect(200);
    const stillThere = await prisma.tool.findUnique({ where: { id: created.body.id } });
    expect(stillThere?.description).toBe('Derived from the docstring.');
  });

  // The rule: the code owns `description` only when the code supplies one. A decorated
  // function with no docstring must defer to whatever the dashboard wrote, not blank it
  // out — and must not churn a new version on every deploy either.
  it("a docstring-less function carries the dashboard's version description forward", async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const created = await request(app)
      .post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'get_weather' })
      .expect(201);
    await request(app)
      .post(`/api/v1/tools/${created.body.id}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        description: 'Written in the dashboard, and the model should keep reading it.',
        source: 'dashboard',
        parametersSchema: paramsSchema,
        executor: clientExecutor,
      })
      .expect(201);

    // Same schema and executor, but the function has no docstring, so no description.
    const body = syncBody();
    delete (body as { description?: string }).description;
    const res = await request(app)
      .post('/api/v1/tools/sync')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(body)
      .expect(200);

    // Nothing to change: the description is inherited, so the spec matches.
    expect(res.body.committed).toBe(false);
    expect(res.body.versionNumber).toBe(1);
    expect(await prisma.toolVersion.count({ where: { toolId: created.body.id } })).toBe(1);

    const resolved = await request(app)
      .post('/api/v1/tools/resolve')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ refs: [{ name: 'get_weather' }] })
      .expect(200);
    expect(resolved.body.data[0].function.description).toBe(
      'Written in the dashboard, and the model should keep reading it.',
    );
  });

  it("a docstring-less function still commits a schema change, keeping the dashboard's description", async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const created = await request(app)
      .post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'get_weather' })
      .expect(201);
    await request(app)
      .post(`/api/v1/tools/${created.body.id}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        description: 'Dashboard text.',
        source: 'dashboard',
        parametersSchema: paramsSchema,
        executor: clientExecutor,
      })
      .expect(201);

    const body = syncBody({
      parametersSchema: { type: 'object', properties: { city: { type: 'string' }, units: { type: 'string' } }, required: ['city'] },
    });
    delete (body as { description?: string }).description;
    const res = await request(app)
      .post('/api/v1/tools/sync')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(body)
      .expect(200);

    expect(res.body.committed).toBe(true);
    expect(res.body.versionNumber).toBe(2);
    // The new version took the code's schema but kept the dashboard's description.
    const v2 = await prisma.toolVersion.findFirst({ where: { toolId: created.body.id, versionNumber: 2 } });
    expect(v2?.description).toBe('Dashboard text.');
  });

  // The full loop for a docstring-less tool: the dashboard owns the description, every
  // dashboard commit makes a new version and moves the alias, and a deploy in between
  // never reverts it. This is the case where the portal must stay fully effective.
  it('lets the dashboard own the description across repeated edits, with syncs in between', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const created = await request(app)
      .post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'get_weather' })
      .expect(201);
    const toolId: string = created.body.id;

    /** What the model currently reads for this tool. */
    async function liveDescription(): Promise<string> {
      const r = await request(app)
        .post('/api/v1/tools/resolve')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ refs: [{ name: 'get_weather' }] })
        .expect(200);
      return r.body.data[0].function.description;
    }

    /** A dashboard commit + promote, exactly as the New-version dialog does it. */
    async function dashboardCommit(description: string): Promise<number> {
      const v = await request(app)
        .post(`/api/v1/tools/${toolId}/versions`)
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ description, source: 'dashboard', parametersSchema: paramsSchema, executor: clientExecutor })
        .expect(201);
      await request(app)
        .post(`/api/v1/tools/${toolId}/aliases/production/promote`)
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ version_number: v.body.versionNumber })
        .expect(200);
      return v.body.versionNumber;
    }

    /** A deploy: the code has no docstring, so it sends no description. */
    async function deploy() {
      const body = syncBody();
      delete (body as { description?: string }).description;
      return request(app).post('/api/v1/tools/sync').set('Authorization', `Bearer ${apiKey}`).send(body).expect(200);
    }

    expect(await dashboardCommit('First wording.')).toBe(1);
    expect(await liveDescription()).toBe('First wording.');

    const afterFirstDeploy = await deploy();
    expect(afterFirstDeploy.body.committed).toBe(false);
    expect(await liveDescription()).toBe('First wording.');

    expect(await dashboardCommit('Second, better wording.')).toBe(2);
    expect(await liveDescription()).toBe('Second, better wording.');

    const afterSecondDeploy = await deploy();
    expect(afterSecondDeploy.body.committed).toBe(false);
    expect(await liveDescription()).toBe('Second, better wording.');

    // Two dashboard versions, and no version churn from either deploy.
    expect(await prisma.toolVersion.count({ where: { toolId } })).toBe(2);
  });

  it('rejects a bad name and an unknown executor type', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    await request(app)
      .post('/api/v1/tools/sync')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(syncBody({ name: 'not a valid name!' }))
      .expect(400)
      .then((r) => expect(r.body.error.code).toBe('VALIDATION_ERROR'));
    await request(app)
      .post('/api/v1/tools/sync')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(syncBody({ executor: { type: 'grpc' } }))
      .expect(400);
  });

  it('rejects a viewer', async () => {
    const owner = await signupTestUserWithApiKey(app);
    const viewer = await addUserToTeam(app, owner.teamId, 'viewer');
    await request(app).post('/api/v1/tools/sync').set(authHeaders(viewer)).send(syncBody()).expect(403);
  });

  // The whole point of the endpoint in one test: a tool that exists only in code ends up
  // usable everywhere a dashboard-authored one is — attachable to a prompt, returned by
  // render, and resolvable by name for the model.
  it('the full chain: sync a client tool, attach it to a prompt, and resolve it for the model', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);

    const synced = await request(app)
      .post('/api/v1/tools/sync')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(syncBody())
      .expect(200);

    const prompt = await request(app)
      .post('/api/v1/prompts')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'support-reply' })
      .expect(201);
    await request(app)
      .post(`/api/v1/prompts/${prompt.body.id}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        messages: [{ role: 'system', content: 'Help the user.' }],
        tools: [{ toolId: synced.body.toolId }],
      })
      .expect(201);

    const rendered = await request(app)
      .post('/api/v1/prompts/support-reply/production/render')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ variables: {} })
      .expect(200);
    expect(rendered.body.tools.map((t: { function: { name: string } }) => t.function.name)).toContain(
      'get_weather',
    );

    const resolved = await request(app)
      .post('/api/v1/tools/resolve')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ refs: [{ name: 'get_weather' }] })
      .expect(200);
    expect(resolved.body.data[0].executorType).toBe('client');
    expect(resolved.body.data[0].versionNumber).toBe(synced.body.versionNumber);
    // The description the model reads is the one the code sent, not a changelog note.
    expect(resolved.body.data[0].function.description).toBe('Get the current weather for a city.');
  });

  // ── Alias targeting on the FIRST version ──────────────────────────────────────
  // `autoCreateAliases` only ever makes `production` and `staging`. A first sync
  // aimed at any other alias used to report `alias: 'canary'` and `committed: true`
  // while creating no such alias, so the very next resolve 404'd.
  it('creates the requested alias on the first version, not only production and staging', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const first = await request(app)
      .post('/api/v1/tools/sync')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(syncBody({ alias: 'canary' }))
      .expect(200);
    expect(first.body).toMatchObject({ versionNumber: 1, committed: true, alias: 'canary' });

    const rows = await prisma.toolAlias.findMany({
      where: { toolId: first.body.toolId },
      include: { version: true },
    });
    const byName = Object.fromEntries(rows.map((r) => [r.alias, r.version.versionNumber]));
    expect(byName).toEqual({ production: 1, staging: 1, canary: 1 });

    // The alias the response claims must actually resolve.
    const resolved = await request(app)
      .post('/api/v1/tools/resolve')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ refs: [{ name: 'get_weather', alias: 'canary' }] })
      .expect(200);
    expect(resolved.body.data[0].versionNumber).toBe(1);

    // ...and re-running the same deploy must still be a no-op.
    const second = await request(app)
      .post('/api/v1/tools/sync')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(syncBody({ alias: 'canary' }))
      .expect(200);
    expect(second.body).toMatchObject({ versionNumber: 1, committed: false });
    expect(await prisma.toolVersion.count()).toBe(1);
  });

  // ── Concurrency ───────────────────────────────────────────────────────────────
  // Sync is machine-driven: `runToolLoop` calls it before the first model call, so
  // N replicas rolling out the same change hit it simultaneously. Both races below
  // used to surface to the caller — one as a 500, one as silent duplicate tools.
  it('does not 500 when two syncs of the same changed spec race', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    await request(app)
      .post('/api/v1/tools/sync')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(syncBody())
      .expect(200);

    const changed = syncBody({ description: 'Get the weather, now with units.' });
    const [a, b] = await Promise.all([
      request(app).post('/api/v1/tools/sync').set('Authorization', `Bearer ${apiKey}`).send(changed),
      request(app).post('/api/v1/tools/sync').set('Authorization', `Bearer ${apiKey}`).send(changed),
    ]);

    expect([a!.status, b!.status]).toEqual([200, 200]);
    // Exactly one call did the work; the loser re-read and saw its spec already live.
    expect([a!.body.committed, b!.body.committed].filter(Boolean)).toHaveLength(1);
    expect(a!.body.versionNumber).toBe(2);
    expect(b!.body.versionNumber).toBe(2);
    expect(await prisma.toolVersion.count()).toBe(2);
  });

  it('creates exactly one tool when two syncs race on a name that does not exist yet', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const [a, b] = await Promise.all([
      request(app).post('/api/v1/tools/sync').set('Authorization', `Bearer ${apiKey}`).send(syncBody()),
      request(app).post('/api/v1/tools/sync').set('Authorization', `Bearer ${apiKey}`).send(syncBody()),
    ]);

    expect([a!.status, b!.status]).toEqual([200, 200]);
    expect(a!.body.toolId).toBe(b!.body.toolId);
    expect(await prisma.tool.count({ where: { name: 'get_weather' } })).toBe(1);
    expect(await prisma.toolVersion.count()).toBe(1);
  });
});
