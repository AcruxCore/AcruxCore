import request from 'supertest';
import { createApp } from '../../app';
import prisma from '../shared/db/client';
import {
  addUserToTeam,
  authHeaders,
  resetAuthTables,
  signupTestUser,
  type TestAuthContext,
} from '../test-utils';

const app = createApp();

beforeEach(async () => {
  await resetAuthTables();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Reads the onboarding status as the given user. */
async function status(ctx: TestAuthContext) {
  const res = await request(app).get('/api/v1/onboarding').set(authHeaders(ctx)).expect(200);
  return res.body;
}

/** Saves a credential and a model that points at it, as the given owner/admin. */
async function addCredentialAndModel(ctx: TestAuthContext): Promise<void> {
  const cred = await request(app)
    .post('/api/v1/gateway/connections')
    .set(authHeaders(ctx))
    .send({ provider: 'openai', label: 'onboarding', apiKey: 'sk-onboarding-not-real' })
    .expect(201);
  await request(app)
    .post('/api/v1/gateway/models')
    .set(authHeaders(ctx))
    .send({ publicName: 'support-model', upstreamModel: 'gpt-4o-mini', credentialId: cred.body.id })
    .expect(201);
}

/** Reports one trace through the ingest endpoint, as the given user. */
async function sendTrace(ctx: TestAuthContext): Promise<void> {
  await request(app)
    .post('/api/v1/traces')
    .set(authHeaders(ctx))
    .send({
      traces: [{
        name: 'onboarding',
        spans: [{
          spanId: 's1', name: 'call', kind: 'llm', status: 'ok',
          startTime: '2026-11-10T12:00:00Z', endTime: '2026-11-10T12:00:01Z',
        }],
      }],
    })
    .expect(200);
}

describe('GET /api/v1/onboarding', () => {
  it('reports every step as not done for a new team', async () => {
    const owner = await signupTestUser(app);
    expect(await status(owner)).toEqual({
      credential: false, model: false, apiKey: false, firstRequest: false,
    });
  });

  it('owner finishes setup → an editor and a viewer of the same team see every step done', async () => {
    const owner = await signupTestUser(app);
    await addCredentialAndModel(owner);
    await request(app).post('/api/v1/api-keys').set(authHeaders(owner)).send({ name: 'owner key' }).expect(201);
    await sendTrace(owner);

    const editor = await addUserToTeam(app, owner.teamId, 'editor');
    const viewer = await addUserToTeam(app, owner.teamId, 'viewer');

    const allDone = { credential: true, model: true, apiKey: true, firstRequest: true };
    expect(await status(owner)).toEqual(allDone);
    // The editor and viewer own no key and cannot create one (POST /api-keys is
    // owner/admin only), yet the team has one, so the step is done for them too.
    expect(await status(editor)).toEqual(allDone);
    expect(await status(viewer)).toEqual(allDone);
    expect(await prisma.apiKey.count({ where: { userId: editor.userId } })).toBe(0);
  });

  it('counts a team-scoped key and a gateway virtual key, but not a revoked key', async () => {
    const owner = await signupTestUser(app);

    const personal = await request(app)
      .post('/api/v1/api-keys').set(authHeaders(owner)).send({ name: 'temp' }).expect(201);
    await request(app).delete(`/api/v1/api-keys/${personal.body.id}`).set(authHeaders(owner)).expect(204);
    expect((await status(owner)).apiKey).toBe(false);

    await request(app)
      .post(`/api/v1/teams/${owner.teamId}/api-keys`).set(authHeaders(owner)).send({ name: 'ci' }).expect(201);
    expect((await status(owner)).apiKey).toBe(true);

    const other = await signupTestUser(app);
    await request(app)
      .post('/api/v1/gateway/keys').set(authHeaders(other)).send({ name: 'vk' }).expect(201);
    expect((await status(other)).apiKey).toBe(true);
  });

  it("never reports another team's setup", async () => {
    const busy = await signupTestUser(app);
    await addCredentialAndModel(busy);
    await request(app).post('/api/v1/api-keys').set(authHeaders(busy)).send({ name: 'k' }).expect(201);
    await sendTrace(busy);

    const empty = await signupTestUser(app);
    expect(await status(empty)).toEqual({
      credential: false, model: false, apiKey: false, firstRequest: false,
    });
  });

  it('rejects an unauthenticated caller', async () => {
    await request(app).get('/api/v1/onboarding').expect(401);
  });
});
