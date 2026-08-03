import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../db/client';
import { authedAgent, authHeaders, signInTestUser, signupTestUser } from '../../test-utils';

const app = createApp();

describe('requireAuth (Better Auth session cookie)', () => {
  it('a signed-in session resolves the user and their personal team', async () => {
    const email = `ra-${randomUUID()}@example.com`;
    const ctx = await signupTestUser(app, { email });
    const res = await request(app).get('/api/v1/auth/me').set(authHeaders(ctx)).expect(200);

    expect(res.body.user.email).toBe(email);
    expect(res.body.team.id).toBe(ctx.teamId);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it('repeated requests on one session create no duplicate user', async () => {
    const ctx = await signupTestUser(app);
    await request(app).get('/api/v1/auth/me').set(authHeaders(ctx)).expect(200);
    await request(app).get('/api/v1/auth/me').set(authHeaders(ctx)).expect(200);
    expect(await prisma.user.count({ where: { email: ctx.email } })).toBe(1);
  });

  it('rejects a request with no cookie with 401', async () => {
    await request(app).get('/api/v1/auth/me').expect(401);
  });

  it('rejects a forged session token with 401', async () => {
    // The cookie value must match an `auth_sessions` row, so a well-formed but
    // invented token is not merely unsigned — it refers to nothing.
    await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', `better-auth.session_token=${randomUUID()}.${randomUUID()}`)
      .expect(401);
  });

  it('rejects a garbage cookie with 401', async () => {
    await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', 'better-auth.session_token=not-a-token')
      .expect(401);
  });

  it('stops accepting a session once it is signed out', async () => {
    // The reason cookie sessions replaced JWTs: revocation is immediate, because
    // sign-out deletes the `auth_sessions` row rather than waiting for an expiry.
    const ctx = await signupTestUser(app);
    await request(app).get('/api/v1/auth/me').set(authHeaders(ctx)).expect(200);

    await request(app).post('/api/v1/auth/sign-out').set(authHeaders(ctx)).expect(200);

    await request(app).get('/api/v1/auth/me').set(authHeaders(ctx)).expect(401);
    expect(await prisma.authSession.count({ where: { userId: ctx.userId } })).toBe(0);
  });

  it('leaves a second session working when the first signs out', async () => {
    const ctx = await signupTestUser(app);
    const second = await signInTestUser(app, ctx.email);
    expect(await prisma.authSession.count({ where: { userId: ctx.userId } })).toBe(2);

    await request(app).post('/api/v1/auth/sign-out').set(authHeaders(ctx)).expect(200);

    await request(app).get('/api/v1/auth/me').set(authHeaders(ctx)).expect(401);
    await request(app).get('/api/v1/auth/me').set('Cookie', second).expect(200);
  });

  it('switch-team persists the choice, and the next request resolves to it', async () => {
    const ctx = await signupTestUser(app);

    const t2 = await prisma.team.create({ data: { name: 'second' } });
    await prisma.teamMember.create({
      data: { userId: ctx.userId, teamId: t2.id, role: 'owner' },
    });

    await request(app)
      .post('/api/v1/auth/switch-team')
      .set(authHeaders(ctx))
      .send({ teamId: t2.id })
      .expect(200);

    const u = await prisma.user.findUnique({ where: { id: ctx.userId } });
    expect(u?.defaultTeamId).toBe(t2.id);

    const me2 = await request(app).get('/api/v1/auth/me').set(authHeaders(ctx)).expect(200);
    expect(me2.body.team.id).toBe(t2.id);
  });

  it('re-resolves to the oldest remaining team when a removed member re-authenticates', async () => {
    // Owner invites user into team B; user accepts and switches to B, then owner
    // removes them. The next request must fall back to the user's own team (A),
    // not the stale default B — preserving the removed-member protection.
    const owner = await authedAgent(app, { email: `owner-${randomUUID()}@example.com` });
    const user = await authedAgent(app, { email: `user-${randomUUID()}@example.com` });
    const teamA = user.teamId;
    const teamB = owner.teamId;

    const inviteRes = await owner.agent
      .post(`/api/v1/teams/${teamB}/invites`)
      .send({ role: 'viewer' })
      .expect(201);
    await user.agent
      .post(`/api/v1/teams/invites/${inviteRes.body.token}/accept`)
      .expect(200);
    await user.agent.post('/api/v1/auth/switch-team').send({ teamId: teamB }).expect(200);

    const meBefore = await user.agent.get('/api/v1/auth/me').expect(200);
    expect(meBefore.body.team.id).toBe(teamB);

    await owner.agent.delete(`/api/v1/teams/${teamB}/members/${user.userId}`).expect(204);

    const meAfter = await user.agent.get('/api/v1/auth/me').expect(200);
    expect(meAfter.body.team.id).toBe(teamA);
  });

  it('heals an authenticated user who has lost every team membership', async () => {
    // Under the Supabase JWT this returned 404 forever. A signed-in person with
    // no team is a state the product has no screen for, and there was no way out
    // of it from the UI — so the middleware now provisions a personal team
    // instead of rejecting them.
    const ctx = await signupTestUser(app);
    await prisma.teamMember.deleteMany({ where: { userId: ctx.userId } });

    const res = await request(app).get('/api/v1/auth/me').set(authHeaders(ctx)).expect(200);

    expect(res.body.team.id).toBeDefined();
    expect(res.body.team.id).not.toBe(ctx.teamId);
    expect(res.body.role).toBe('owner');
  });
});
