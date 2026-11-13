import request from 'supertest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { allowLoopbackForTests, resetSsrfAllowlist } from '../execute/safe-fetch';
import { addUserToTeam, authHeaders, signupTestUser } from '../../test-utils';
import type { TestAuthContext } from '../../test-utils';

/**
 * Binding a team secret into an http executor decides where that secret is sent.
 * Secrets are managed by owners and admins and never shown to anyone, so an editor
 * must not be able to commit an executor that sends one to a URL of their choosing.
 * Running a version an owner or admin committed stays open to editors, and so does
 * saving a new version that sends the same secrets to the same URL as the last one.
 */

const app = createApp();
let server: http.Server;
let baseUrl: string;
/** Every `x-api-key` header value the upstream received, newest last. */
const receivedKeys: string[] = [];

const SECRET_VALUE = 'sk_live_binding_test_4c2b1a';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    receivedKeys.push(String(req.headers['x-api-key'] ?? ''));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ echoed: req.headers['x-api-key'] ?? null }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  allowLoopbackForTests(); // in-process test-only seam; production never opens it
});

afterAll(async () => {
  resetSsrfAllowlist();
  await new Promise<void>((r) => server.close(() => r()));
  await prisma.$disconnect();
});

beforeEach(async () => {
  receivedKeys.length = 0;
  await prisma.$executeRaw`TRUNCATE TABLE secrets, span_payloads, spans, traces, tool_aliases, tool_versions, tools, audit_log, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
});

/** An executor that sends the team secret STRIPE_KEY as a header to the local upstream. */
function secretExecutor(path = '/collect') {
  return {
    type: 'http' as const,
    url: `${baseUrl}${path}`,
    method: 'GET' as const,
    headers: [{ name: 'X-Api-Key', value: '{{secret.STRIPE_KEY}}' }],
  };
}

/** Owner with a secret, plus an admin and an editor in the same team (active team set). */
async function teamWithSecret(): Promise<{
  owner: TestAuthContext;
  admin: TestAuthContext;
  editor: TestAuthContext;
}> {
  const owner = await signupTestUser(app);
  await request(app)
    .post('/api/v1/secrets')
    .set(authHeaders(owner))
    .send({ name: 'STRIPE_KEY', value: SECRET_VALUE })
    .expect(201);
  const admin = await addUserToTeam(app, owner.teamId, 'admin');
  const editor = await addUserToTeam(app, owner.teamId, 'editor');
  return { owner, admin, editor };
}

/** Creates an empty tool shell as `who` and returns its id. */
async function createTool(who: TestAuthContext, name: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/tools')
    .set(authHeaders(who))
    .send({ name })
    .expect(201);
  return res.body.id as string;
}

/**
 * Mints a personal API key for `who` in their active team. Only owners and admins
 * may mint keys, so an editor cannot hold one; the key path is covered for owners.
 */
async function personalKey(who: TestAuthContext): Promise<string> {
  const res = await request(app)
    .post('/api/v1/api-keys')
    .set(authHeaders(who))
    .send({ name: 'ci key' })
    .expect(201);
  return res.body.key as string;
}

describe('binding a team secret into a tool executor', () => {
  it('refuses an editor who commits a version that sends a secret, and stores nothing', async () => {
    const { editor } = await teamWithSecret();
    const toolId = await createTool(editor, 'leak_tool');

    const res = await request(app)
      .post(`/api/v1/tools/${toolId}/versions`)
      .set(authHeaders(editor))
      .send({ parametersSchema: { type: 'object' }, executor: secretExecutor() });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SECRET_BINDING_NOT_PERMITTED');
    expect(await prisma.toolVersion.count({ where: { toolId } })).toBe(0);
  });

  it('refuses an editor who syncs a secret-sending executor, and creates no tool', async () => {
    const { editor } = await teamWithSecret();

    const res = await request(app)
      .post('/api/v1/tools/sync')
      .set(authHeaders(editor))
      .send({
        name: 'leak_sync',
        parametersSchema: { type: 'object' },
        executor: secretExecutor(),
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SECRET_BINDING_NOT_PERMITTED');
    expect(await prisma.tool.count({ where: { name: 'leak_sync' } })).toBe(0);
    expect(await prisma.toolVersion.count()).toBe(0);
  });

  it('refuses an editor who re-points an admin-authored secret-using tool', async () => {
    const { admin, editor } = await teamWithSecret();
    const toolId = await createTool(admin, 'billing');
    await request(app)
      .post(`/api/v1/tools/${toolId}/versions`)
      .set(authHeaders(admin))
      .send({ parametersSchema: { type: 'object' }, executor: secretExecutor('/billing') })
      .expect(201);

    await request(app)
      .post(`/api/v1/tools/${toolId}/versions`)
      .set(authHeaders(editor))
      .send({ parametersSchema: { type: 'object' }, executor: secretExecutor('/elsewhere') })
      .expect(403);
    expect(await prisma.toolVersion.count({ where: { toolId } })).toBe(1);
  });

  it('lets owners and admins bind a secret, and editors run what they committed', async () => {
    const { owner, admin, editor } = await teamWithSecret();

    // Admin commits through the versions route.
    const toolId = await createTool(admin, 'billing');
    await request(app)
      .post(`/api/v1/tools/${toolId}/versions`)
      .set(authHeaders(admin))
      .send({ parametersSchema: { type: 'object' }, executor: secretExecutor() })
      .expect(201);

    // Owner syncs through the code route with a personal API key, which carries the
    // owner's role.
    const ownerKey = await personalKey(owner);
    const synced = await request(app)
      .post('/api/v1/tools/sync')
      .set('Authorization', `Bearer ${ownerKey}`)
      .send({ name: 'billing_sync', parametersSchema: { type: 'object' }, executor: secretExecutor() })
      .expect(200);
    expect(synced.body.committed).toBe(true);

    // The editor executes the admin's version: the secret reaches the admin's URL.
    const run = await request(app)
      .post(`/api/v1/tools/${toolId}/execute`)
      .set(authHeaders(editor))
      .send({ arguments: {}, versionNumber: 1 })
      .expect(200);
    expect(run.body.status).toBe(200);
    expect(receivedKeys).toContain(SECRET_VALUE);

    // An editor re-syncing the owner's unchanged spec commits nothing, so nothing new
    // is bound and the call stays a no-op rather than an error. This is the path an
    // editor's deploy takes on every start.
    const noop = await request(app)
      .post('/api/v1/tools/sync')
      .set(authHeaders(editor))
      .send({ name: 'billing_sync', parametersSchema: { type: 'object' }, executor: secretExecutor() })
      .expect(200);
    expect(noop.body.committed).toBe(false);
  });

  it('leaves editors free to commit and sync executors that use no secret', async () => {
    const { editor } = await teamWithSecret();
    const toolId = await createTool(editor, 'plain');
    await request(app)
      .post(`/api/v1/tools/${toolId}/versions`)
      .set(authHeaders(editor))
      .send({
        parametersSchema: { type: 'object' },
        executor: { type: 'http', url: `${baseUrl}/plain`, method: 'GET', headers: [{ name: 'X-Api-Key', value: 'public' }] },
      })
      .expect(201);
    await request(app)
      .post('/api/v1/tools/sync')
      .set(authHeaders(editor))
      .send({ name: 'plain_sync', parametersSchema: { type: 'object' }, executor: { type: 'client' } })
      .expect(200);
  });

  it('lets an editor save a new version that sends the same secrets to the same URL', async () => {
    const { admin, editor } = await teamWithSecret();
    const toolId = await createTool(admin, 'billing');
    await request(app)
      .post(`/api/v1/tools/${toolId}/versions`)
      .set(authHeaders(admin))
      .send({ description: 'Bills a customer.', parametersSchema: { type: 'object' }, executor: secretExecutor('/billing') })
      .expect(201);

    // A description-only change.
    await request(app)
      .post(`/api/v1/tools/${toolId}/versions`)
      .set(authHeaders(editor))
      .send({ description: 'Bills a customer once.', parametersSchema: { type: 'object' }, executor: secretExecutor('/billing') })
      .expect(201);

    // Changes that do not touch where the secret goes: method and a non-secret header.
    const moved = secretExecutor('/billing');
    await request(app)
      .post(`/api/v1/tools/${toolId}/versions`)
      .set(authHeaders(editor))
      .send({
        parametersSchema: { type: 'object', properties: { id: { type: 'string' } } },
        executor: { ...moved, method: 'POST', headers: [...moved.headers, { name: 'X-Trace', value: 'on' }] },
      })
      .expect(201);
    expect(await prisma.toolVersion.count({ where: { toolId } })).toBe(3);
  });

  it('still refuses an editor who sends a different secret, or the secret in a new place', async () => {
    const { owner, admin, editor } = await teamWithSecret();
    await request(app)
      .post('/api/v1/secrets')
      .set(authHeaders(owner))
      .send({ name: 'OTHER_KEY', value: 'sk_other_9f8e' })
      .expect(201);
    const toolId = await createTool(admin, 'billing');
    await request(app)
      .post(`/api/v1/tools/${toolId}/versions`)
      .set(authHeaders(admin))
      .send({ parametersSchema: { type: 'object' }, executor: secretExecutor('/billing') })
      .expect(201);

    const base = secretExecutor('/billing');
    for (const executor of [
      { ...base, headers: [{ name: 'X-Api-Key', value: '{{secret.OTHER_KEY}}' }] },
      { ...base, headers: [{ name: 'X-Other', value: '{{secret.STRIPE_KEY}}' }] },
      { ...base, headers: [], query: [{ name: 'key', value: '{{secret.STRIPE_KEY}}' }] },
      { ...base, url: `${baseUrl}/billing?to=elsewhere` },
    ]) {
      const res = await request(app)
        .post(`/api/v1/tools/${toolId}/versions`)
        .set(authHeaders(editor))
        .send({ parametersSchema: { type: 'object' }, executor });
      expect(res.status).toBe(403);
    }
    expect(await prisma.toolVersion.count({ where: { toolId } })).toBe(1);
  });

  it('lets an editor sync a description change to a secret-using tool an admin set up', async () => {
    const { owner, editor } = await teamWithSecret();
    const ownerKey = await personalKey(owner);
    await request(app)
      .post('/api/v1/tools/sync')
      .set('Authorization', `Bearer ${ownerKey}`)
      .send({ name: 'billing_sync', description: 'Bills.', parametersSchema: { type: 'object' }, executor: secretExecutor() })
      .expect(200);

    const changed = await request(app)
      .post('/api/v1/tools/sync')
      .set(authHeaders(editor))
      .send({ name: 'billing_sync', description: 'Bills once.', parametersSchema: { type: 'object' }, executor: secretExecutor() })
      .expect(200);
    expect(changed.body.committed).toBe(true);

    await request(app)
      .post('/api/v1/tools/sync')
      .set(authHeaders(editor))
      .send({ name: 'billing_sync', description: 'Bills once.', parametersSchema: { type: 'object' }, executor: secretExecutor('/elsewhere') })
      .expect(403);
  });
});
