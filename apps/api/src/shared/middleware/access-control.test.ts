import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../db/client';
import { signupTestUser, signupTestUserWithApiKey, authHeaders, uniqueTestEmail } from '../../test-utils';

const app = createApp();
afterAll(async () => { await prisma.$disconnect(); });

/** Reads the rotated session cookie out of a response, falling back to the old one. */
function cookieFrom(res: request.Response, fallback: string): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const s = list.find((c: string) => c.includes('session_token'));
  return s ? s.split(';')[0] : fallback;
}

describe('malformed ids answer 400, not 500 (issue #476)', () => {
  it('rejects a non-UUID path param across every domain', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${apiKey}`);
    const cases: Array<[string, () => request.Test]> = [
      ['DELETE /api-keys/:id', () => auth(request(app).delete('/api/v1/api-keys/not-a-uuid'))],
      ['PUT /secrets/:id', () => auth(request(app).put('/api/v1/secrets/not-a-uuid').send({ value: 'abcd1234' }))],
      ['DELETE /secrets/:id', () => auth(request(app).delete('/api/v1/secrets/not-a-uuid'))],
      ['GET /gateway/models/:id', () => auth(request(app).get('/api/v1/gateway/models/not-a-uuid'))],
      ['GET /gateway/connections/:id', () => auth(request(app).get('/api/v1/gateway/connections/not-a-uuid'))],
      ['PATCH /gateway/budgets/:id', () => auth(request(app).patch('/api/v1/gateway/budgets/not-a-uuid').send({ limitUsd: 5 }))],
      ['PATCH /gateway/keys/:id', () => auth(request(app).patch('/api/v1/gateway/keys/not-a-uuid').send({ name: 'x' }))],
      ['GET /tools/:id', () => auth(request(app).get('/api/v1/tools/not-a-uuid'))],
      ['PATCH /trace-views/:id', () => auth(request(app).patch('/api/v1/trace-views/not-a-uuid').send({ name: 'x' }))],
    ];
    const statuses: Record<string, number> = {};
    for (const [label, run] of cases) statuses[label] = (await run()).status;
    // Not "is 400": any 4xx is a correct answer here (404 where the service
    // validates first). What must never happen is a 5xx.
    for (const [label, status] of Object.entries(statuses)) {
      expect({ label, serverError: status >= 500 }).toEqual({ label, serverError: false });
    }
  }, 60000);

  it('names the problem rather than returning a generic server error', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const res = await request(app)
      .get('/api/v1/gateway/models/not-a-uuid')
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    // Prisma's own message carries the failing query and a source path; neither
    // may reach the caller.
    expect(JSON.stringify(res.body)).not.toMatch(/prisma|invocation|\.ts:/i);
  }, 60000);
});

describe('removing a member revokes their API key (issue #477)', () => {
  it('cuts off a removed member’s personal key', async () => {
    const owner = await signupTestUser(app);
    const email = uniqueTestEmail();
    const member = await signupTestUser(app, { email });

    const invite = await request(app)
      .post(`/api/v1/teams/${owner.teamId}/invites`)
      .set(authHeaders(owner))
      .send({ email, role: 'admin' })
      .expect(201);
    const accepted = await request(app)
      .post(`/api/v1/teams/invites/${invite.body.token}/accept`)
      .set(authHeaders(member))
      .expect(200);
    const memberCookie = cookieFrom(accepted, member.cookie);

    const keyRes = await request(app)
      .post('/api/v1/api-keys')
      .set({ Cookie: memberCookie })
      .send({ name: 'member key' })
      .expect(201);
    const memberKey = keyRes.body.key;

    await request(app).get('/api/v1/prompts').set('Authorization', `Bearer ${memberKey}`).expect(200);

    await request(app)
      .delete(`/api/v1/teams/${owner.teamId}/members/${member.userId}`)
      .set(authHeaders(owner))
      .expect(204);

    // Every route the key could reach before must now refuse it — reads included,
    // since most read routes carry no role gate.
    for (const path of ['/api/v1/prompts', '/api/v1/secrets', '/api/v1/tools', '/api/v1/gateway/keys']) {
      const res = await request(app).get(path).set('Authorization', `Bearer ${memberKey}`);
      expect({ path, status: res.status }).toEqual({ path, status: 401 });
    }
  }, 60000);

  it('leaves a still-valid member’s key working', async () => {
    const owner = await signupTestUser(app);
    const email = uniqueTestEmail();
    const member = await signupTestUser(app, { email });
    const invite = await request(app).post(`/api/v1/teams/${owner.teamId}/invites`)
      .set(authHeaders(owner)).send({ email, role: 'admin' }).expect(201);
    const accepted = await request(app).post(`/api/v1/teams/invites/${invite.body.token}/accept`)
      .set(authHeaders(member)).expect(200);
    const key = (await request(app).post('/api/v1/api-keys')
      .set({ Cookie: cookieFrom(accepted, member.cookie) }).send({ name: 'k' }).expect(201)).body.key;

    await request(app).get('/api/v1/prompts').set('Authorization', `Bearer ${key}`).expect(200);
  }, 60000);
});

describe('an API key cannot manage another team (issue #478)', () => {
  it('refuses a key whose team is not the team in the URL', async () => {
    const user = await signupTestUser(app);
    const other = await signupTestUser(app);

    // Minted while the user's own team is active, so the key is scoped to it.
    const key = (await request(app).post('/api/v1/api-keys')
      .set(authHeaders(user)).send({ name: 'key for own team' }).expect(201)).body.key;

    const invite = await request(app).post(`/api/v1/teams/${other.teamId}/invites`)
      .set(authHeaders(other)).send({ email: user.email, role: 'admin' }).expect(201);
    await request(app).post(`/api/v1/teams/invites/${invite.body.token}/accept`)
      .set(authHeaders(user)).expect(200);

    // The user really is an admin of the other team — a session may manage it.
    await request(app).get(`/api/v1/teams/${other.teamId}/members`)
      .set(authHeaders(user)).expect(200);

    // The key may not, because the key belongs to a different team.
    const roster = await request(app).get(`/api/v1/teams/${other.teamId}/members`)
      .set('Authorization', `Bearer ${key}`);
    expect(roster.status).toBe(403);
    expect(roster.body.error.code).toBe('KEY_TEAM_MISMATCH');

    const invited = await request(app).post(`/api/v1/teams/${other.teamId}/invites`)
      .set('Authorization', `Bearer ${key}`)
      .send({ email: uniqueTestEmail(), role: 'admin' });
    expect(invited.status).toBe(403);
  }, 60000);

  it('still lets a key manage its own team', async () => {
    const user = await signupTestUserWithApiKey(app);
    await request(app).get(`/api/v1/teams/${user.teamId}/members`)
      .set('Authorization', `Bearer ${user.apiKey}`)
      .expect(200);
  }, 60000);
});
