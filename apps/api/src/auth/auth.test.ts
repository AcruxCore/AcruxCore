import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../app';
import prisma from '../shared/db/client';
import { authedAgent, authHeaders, resetAuthTables, signInTestUser, signupTestUser } from '../test-utils';

const app = createApp();

async function truncateTables(): Promise<void> {
  // Delegates to the shared reset rather than keeping a local delete chain: every
  // such chain omitted a table that references `users` or `teams` (`audit_log`,
  // `tools`, ...), which passed alone and FK-violated in a full run the moment an
  // earlier suite left a row behind. `TRUNCATE ... CASCADE` reaches the
  // dependants automatically, so it needs no edit when a new domain lands.
  await resetAuthTables();
}

beforeEach(async () => {
  await truncateTables();
});

afterAll(async () => {
  await truncateTables();
  await prisma.$disconnect();
});

describe('GET /api/v1/auth/me', () => {
  it('returns user, team, and role for an authenticated token', async () => {
    const email = `alice-${randomUUID()}@example.com`;
    const { agent } = await authedAgent(app, { email });
    const res = await agent.get('/api/v1/auth/me').expect(200);
    expect(res.body.user.email).toBe(email);
    expect(res.body.team.name).toBe(`${email}'s team`);
    expect(res.body.role).toBe('owner');
  });

  it('returns 401 without a token', async () => {
    await request(app).get('/api/v1/auth/me').expect(401);
  });

  it('first authenticated call provisions user + team + owner role in the DB', async () => {
    const { userId, teamId } = await authedAgent(app);
    const member = await prisma.teamMember.findFirst({
      where: { userId, teamId },
    });
    expect(member).toBeTruthy();
    expect(member!.role).toBe('owner');
    const user = await prisma.user.findUnique({ where: { id: userId } });
    // The credential lives on the account row, never on the identity row.
    expect(user).toBeTruthy();
    const credential = await prisma.authAccount.findFirst({
      where: { userId, providerId: 'credential' },
    });
    expect(credential?.password).toBeTruthy();
  });
});

describe('GET /api/v1/auth/teams', () => {
  it('lists exactly one team with owner role right after first auth', async () => {
    const alice = await authedAgent(app, { email: `alice-${randomUUID()}@example.com` });
    const res = await alice.agent.get('/api/v1/auth/teams').expect(200);
    expect(res.body.teams).toHaveLength(1);
    expect(res.body.teams[0].id).toBe(alice.teamId);
    expect(res.body.teams[0].role).toBe('owner');
  });

  it('lists two teams after accepting a viewer invite into a second team', async () => {
    const owner = await authedAgent(app, { email: `owner-${randomUUID()}@example.com` });
    const alice = await authedAgent(app, { email: `alice-${randomUUID()}@example.com` });

    const inviteRes = await owner.agent
      .post(`/api/v1/teams/${owner.teamId}/invites`)
      .send({ role: 'viewer' })
      .expect(201);
    await alice.agent
      .post(`/api/v1/teams/invites/${inviteRes.body.token}/accept`)
      .expect(200);

    const res = await alice.agent.get('/api/v1/auth/teams').expect(200);
    expect(res.body.teams).toHaveLength(2);
    const joined = res.body.teams.find((t: { id: string }) => t.id === owner.teamId);
    expect(joined.role).toBe('viewer');
  });
});

describe('POST /api/v1/auth/switch-team', () => {
  it('switches to a team the user is a member of and updates the active team', async () => {
    const owner = await authedAgent(app, { email: `owner-${randomUUID()}@example.com` });
    const alice = await authedAgent(app, { email: `alice-${randomUUID()}@example.com` });

    const inviteRes = await owner.agent
      .post(`/api/v1/teams/${owner.teamId}/invites`)
      .send({ role: 'viewer' })
      .expect(201);
    await alice.agent
      .post(`/api/v1/teams/invites/${inviteRes.body.token}/accept`)
      .expect(200);

    const switchRes = await alice.agent
      .post('/api/v1/auth/switch-team')
      .send({ teamId: owner.teamId })
      .expect(200);
    expect(switchRes.body.team.id).toBe(owner.teamId);
    expect(switchRes.body.role).toBe('viewer');

    const meRes = await alice.agent.get('/api/v1/auth/me').expect(200);
    expect(meRes.body.team.id).toBe(owner.teamId);
  });

  it('returns 404 when switching to a team the user is not a member of', async () => {
    const alice = await authedAgent(app, { email: `alice-${randomUUID()}@example.com` });
    const stranger = await authedAgent(app, { email: `stranger-${randomUUID()}@example.com` });

    const res = await alice.agent
      .post('/api/v1/auth/switch-team')
      .send({ teamId: stranger.teamId })
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('default-team persistence across re-authentication', () => {
  it('prefers the last-active team recorded via switch-team when the same user signs in again', async () => {
    const email = `alice-${randomUUID()}@example.com`;
    const ctx = await signupTestUser(app, { email });

    // Owner invites the user into team B; user accepts and switches to B.
    const owner = await authedAgent(app, { email: `owner-${randomUUID()}@example.com` });
    const teamB = owner.teamId;
    const inviteRes = await owner.agent
      .post(`/api/v1/teams/${teamB}/invites`)
      .send({ role: 'viewer' })
      .expect(201);
    await request(app)
      .post(`/api/v1/teams/invites/${inviteRes.body.token}/accept`)
      .set(authHeaders(ctx))
      .expect(200);
    await request(app)
      .post('/api/v1/auth/switch-team')
      .set(authHeaders(ctx))
      .send({ teamId: teamB })
      .expect(200);

    // A brand-new session for the SAME account resolves to team B: the choice is
    // recorded on the user row, not carried in the session.
    const fresh = await signInTestUser(app, email);
    const me = await request(app).get('/api/v1/auth/me').set('Cookie', fresh).expect(200);
    expect(me.body.team.id).toBe(teamB);
  });

  it('falls back to the oldest membership when the default team membership is removed', async () => {
    const email = `alice-${randomUUID()}@example.com`;
    const ctx = await signupTestUser(app, { email });
    const teamA = ctx.teamId;

    const owner = await authedAgent(app, { email: `owner-${randomUUID()}@example.com` });
    const teamB = owner.teamId;
    const inviteRes = await owner.agent
      .post(`/api/v1/teams/${teamB}/invites`)
      .send({ role: 'viewer' })
      .expect(201);
    await request(app)
      .post(`/api/v1/teams/invites/${inviteRes.body.token}/accept`)
      .set(authHeaders(ctx))
      .expect(200);
    await request(app)
      .post('/api/v1/auth/switch-team')
      .set(authHeaders(ctx))
      .send({ teamId: teamB })
      .expect(200);
    await owner.agent.delete(`/api/v1/teams/${teamB}/members/${ctx.userId}`).expect(204);

    const fresh = await signInTestUser(app, email);
    const me = await request(app).get('/api/v1/auth/me').set('Cookie', fresh).expect(200);
    expect(me.body.team.id).toBe(teamA);
  });
});
