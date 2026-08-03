import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';
import { drainEmailQueue, getEmailQueue, getMemoryTransport, loadEmailConfig } from '../../email';
import { getRedisConnection } from '../../evaluations/queue/connection';
import { INVITE_EMAIL_CAP } from './invites.service';

const app = createApp();

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE
    email_log, team_invites, audit_log, prompt_aliases, prompt_versions, prompts,
    api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /api/v1/teams/:id/invites', () => {
  it('owner creates an invite and gets token back', async () => {
    const owner = await authedAgent(app, { email: 'owner@invites.test' });
    const res = await owner.agent
      .post(`/api/v1/teams/${owner.teamId}/invites`)
      .send({ role: 'editor' })
      .expect(201);

    expect(res.body.token).toBeDefined();
    expect(res.body.role).toBe('editor');
    expect(res.body.expiresAt).toBeDefined();
  });

  it('returns 400 for a missing role', async () => {
    const owner = await authedAgent(app, { email: 'owner@invites2.test' });
    await owner.agent
      .post(`/api/v1/teams/${owner.teamId}/invites`)
      .send({})
      .expect(400);
  });

  it('returns 400 for an ungrantable role', async () => {
    const owner = await authedAgent(app, { email: 'owner@invites2b.test' });
    await owner.agent
      .post(`/api/v1/teams/${owner.teamId}/invites`)
      .send({ role: 'owner' })
      .expect(400);
  });

  // A member holds exactly one role, so the old array body is rejected outright
  // rather than silently reduced to its first (or highest) element — a caller
  // still sending `roles` needs to see that it changed, not guess later.
  it('returns 400 for the old array body `{ roles: [...] }`', async () => {
    const owner = await authedAgent(app, { email: 'owner@invites2c.test' });
    await owner.agent
      .post(`/api/v1/teams/${owner.teamId}/invites`)
      .send({ roles: ['editor'] })
      .expect(400);

    // Nothing was written — the body never reached the repository.
    const invites = await prisma.teamInvite.findMany({ where: { teamId: owner.teamId } });
    expect(invites).toHaveLength(0);
  });

  it('returns 403 when viewer tries to create invite', async () => {
    const owner = await authedAgent(app, { email: 'owner@invites3.test' });
    const viewer = await authedAgent(app, { email: 'viewer@invites3.test' });

    await prisma.teamMember.create({
      data: { teamId: owner.teamId, userId: viewer.userId, role: 'viewer' },
    });

    await viewer.agent
      .post(`/api/v1/teams/${owner.teamId}/invites`)
      .send({ role: 'editor' })
      .expect(403);
  });

  it('returns 401 when unauthenticated', async () => {
    const owner = await authedAgent(app, { email: 'owner@invites4.test' });
    await request(app)
      .post(`/api/v1/teams/${owner.teamId}/invites`)
      .send({ role: 'editor' })
      .expect(401);
  });
});

describe('GET /api/v1/teams/:id/invites', () => {
  it('owner can list pending invites', async () => {
    const owner = await authedAgent(app, { email: 'owner@listinvites.test' });

    await owner.agent
      .post(`/api/v1/teams/${owner.teamId}/invites`)
      .send({ role: 'viewer' })
      .expect(201);

    const res = await owner.agent
      .get(`/api/v1/teams/${owner.teamId}/invites`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
    expect(res.body[0].role).toBe('viewer');
  });
});

describe('POST /api/v1/teams/invites/:token/accept', () => {
  it('new user accepts invite and joins team with the correct role', async () => {
    const owner = await authedAgent(app, { email: 'owner@accept.test' });
    const newUser = await authedAgent(app, { email: 'newuser@accept.test' });

    const inviteRes = await owner.agent
      .post(`/api/v1/teams/${owner.teamId}/invites`)
      .send({ role: 'editor' })
      .expect(201);

    const token = inviteRes.body.token as string;

    const acceptRes = await newUser.agent
      .post(`/api/v1/teams/invites/${token}/accept`)
      .expect(200);

    expect(acceptRes.body.team.id).toBe(owner.teamId);

    // Verify new user is now in member list
    const memberListRes = await owner.agent
      .get(`/api/v1/teams/${owner.teamId}/members`)
      .expect(200);

    const emails = (memberListRes.body as Array<{ email: string; role: string }>).map(
      (m) => m.email,
    );
    expect(emails).toContain('newuser@accept.test');

    const newMember = (memberListRes.body as Array<{ email: string; role: string }>).find(
      (m) => m.email === 'newuser@accept.test',
    );
    expect(newMember?.role).toBe('editor');
  });

  it('accepting an invite switches the joining user\'s active team', async () => {
    const owner = await authedAgent(app, { email: 'owner@switch.test' });
    const newUser = await authedAgent(app, { email: 'newuser@switch.test' });

    // Before accepting, the new user's active team is their own personal team.
    const meBefore = await newUser.agent.get('/api/v1/auth/me').expect(200);
    expect(meBefore.body.team.id).not.toBe(owner.teamId);

    const inviteRes = await owner.agent
      .post(`/api/v1/teams/${owner.teamId}/invites`)
      .send({ role: 'viewer' })
      .expect(201);

    await newUser.agent
      .post(`/api/v1/teams/invites/${inviteRes.body.token}/accept`)
      .expect(200);

    // After accepting, both the live session and the persisted default team
    // must reflect the newly-joined team — not the user's own personal team.
    const meAfter = await newUser.agent.get('/api/v1/auth/me').expect(200);
    expect(meAfter.body.team.id).toBe(owner.teamId);
  });

  it('returns 410 when invite already used', async () => {
    const owner = await authedAgent(app, { email: 'owner@used.test' });
    const userA = await authedAgent(app, { email: 'usera@used.test' });
    const userB = await authedAgent(app, { email: 'userb@used.test' });

    const inviteRes = await owner.agent
      .post(`/api/v1/teams/${owner.teamId}/invites`)
      .send({ role: 'viewer' })
      .expect(201);

    const token = inviteRes.body.token as string;

    await userA.agent
      .post(`/api/v1/teams/invites/${token}/accept`)
      .expect(200);

    const res = await userB.agent
      .post(`/api/v1/teams/invites/${token}/accept`)
      .expect(410);

    expect(res.body.error.code).toBe('INVITE_USED');
  });

  it('returns 409 when user is already a member', async () => {
    const owner = await authedAgent(app, { email: 'owner@alreadymember.test' });
    const member = await authedAgent(app, { email: 'member@alreadymember.test' });

    await prisma.teamMember.create({
      data: { teamId: owner.teamId, userId: member.userId, role: 'viewer' },
    });

    const inviteRes = await owner.agent
      .post(`/api/v1/teams/${owner.teamId}/invites`)
      .send({ role: 'editor' })
      .expect(201);

    const res = await member.agent
      .post(`/api/v1/teams/invites/${inviteRes.body.token}/accept`)
      .expect(409);

    expect(res.body.error.code).toBe('ALREADY_MEMBER');
  });

  it('returns 404 for an unknown token', async () => {
    const user = await authedAgent(app, { email: 'user@badtoken.test' });
    await user.agent
      .post('/api/v1/teams/invites/notarealtoken/accept')
      .expect(404);
  });
});

describe('DELETE /api/v1/teams/:id/invites/:inviteId', () => {
  it('owner revokes a pending invite', async () => {
    const owner = await authedAgent(app, { email: 'owner@revoke.test' });

    const inviteRes = await owner.agent
      .post(`/api/v1/teams/${owner.teamId}/invites`)
      .send({ role: 'editor' })
      .expect(201);

    await owner.agent
      .delete(`/api/v1/teams/${owner.teamId}/invites/${inviteRes.body.id}`)
      .expect(204);

    const listRes = await owner.agent
      .get(`/api/v1/teams/${owner.teamId}/invites`)
      .expect(200);

    expect(listRes.body.length).toBe(0);
  });

  it('returns 404 for unknown invite id', async () => {
    const owner = await authedAgent(app, { email: 'owner@revoke2.test' });
    await owner.agent
      .delete(`/api/v1/teams/${owner.teamId}/invites/00000000-0000-0000-0000-000000000000`)
      .expect(404);
  });
});

describe('invite email', () => {
  const transport = getMemoryTransport();

  beforeEach(async () => {
    transport.reset();
    await getEmailQueue().obliterate({ force: true });
  });

  afterAll(async () => {
    await getEmailQueue().close();
    // `getEmailQueue()` is built on the SHARED `getRedisConnection()` ioredis
    // instance, not one of its own — closing the Queue does not quit it, and
    // the open socket keeps Jest's process alive after this file's tests
    // finish (see `email.test.ts`'s identical afterAll for the same reason).
    await getRedisConnection().quit();
  });

  it('emails the recipient and records one email_log row', async () => {
    const owner = await authedAgent(app, { email: 'owner@inviteemail.test' });

    const res = await owner.agent
      .post(`/api/v1/teams/${owner.teamId}/invites`)
      .send({ role: 'editor', email: 'newbie@example.com' })
      .expect(201);

    expect(res.body.email).toBe('newbie@example.com');

    const invite = await prisma.teamInvite.findUnique({ where: { id: res.body.id } });
    expect(invite?.email).toBe('newbie@example.com');

    await drainEmailQueue();

    const logs = await prisma.emailLog.findMany({ where: { teamId: owner.teamId } });
    expect(logs).toHaveLength(1);
    expect(logs[0].type).toBe('team_invite');
    expect(logs[0].status).toBe('sent');
    expect(logs[0].toEmail).toBe('newbie@example.com');
  });

  it('sends nothing when no email is supplied', async () => {
    const owner = await authedAgent(app, { email: 'owner@nolink.test' });

    const res = await owner.agent
      .post(`/api/v1/teams/${owner.teamId}/invites`)
      .send({ role: 'viewer' })
      .expect(201);

    expect(res.body.email).toBeNull();
    expect(res.body.token).toBeDefined();
    await drainEmailQueue();
    expect(await prisma.emailLog.count({ where: { teamId: owner.teamId } })).toBe(0);
    expect(transport.sent()).toHaveLength(0);
  });

  it('renders the absolute invite URL, team name, and role in both parts', async () => {
    const owner = await authedAgent(app, { email: 'owner@rendered.test' });
    const res = await owner.agent
      .post(`/api/v1/teams/${owner.teamId}/invites`)
      .send({ role: 'admin', email: 'newbie2@example.com' })
      .expect(201);
    await drainEmailQueue();

    const [message] = transport.sent();
    const expectedUrl = `${loadEmailConfig().appUrl.replace(/\/+$/, '')}/invite/${res.body.token}`;
    expect(expectedUrl).toMatch(/^https?:\/\//);
    for (const body of [message.html, message.text]) {
      expect(body).toContain(expectedUrl);
      expect(body).toContain('admin');
    }
    // The HTML part escapes the team name for XSS safety (layout.ts's
    // escapeHtml), so the apostrophe is an entity there but literal in text.
    expect(message.text).toContain("owner@rendered.test's team");
    expect(message.html).toContain('owner@rendered.test&#39;s team');
  });

  it('never writes the invite token into email_log', async () => {
    const owner = await authedAgent(app, { email: 'owner@tokenleak.test' });
    const res = await owner.agent
      .post(`/api/v1/teams/${owner.teamId}/invites`)
      .send({ role: 'viewer', email: 'newbie3@example.com' })
      .expect(201);
    await drainEmailQueue();

    const logs = await prisma.emailLog.findMany({ where: { teamId: owner.teamId } });
    expect(JSON.stringify(logs)).not.toContain(res.body.token);
  });

  it('normalises a mixed-case, space-padded address in both team_invites and email_log', async () => {
    const owner = await authedAgent(app, { email: 'owner@normalize.test' });

    const res = await owner.agent
      .post(`/api/v1/teams/${owner.teamId}/invites`)
      .send({ role: 'viewer', email: '  Foo@Example.COM  ' })
      .expect(201);

    expect(res.body.email).toBe('foo@example.com');

    const invite = await prisma.teamInvite.findUnique({ where: { id: res.body.id } });
    expect(invite?.email).toBe('foo@example.com');

    await drainEmailQueue();
    const [log] = await prisma.emailLog.findMany({ where: { teamId: owner.teamId } });
    expect(log.toEmail).toBe('foo@example.com');
  });

  it('rejects a malformed email with 400', async () => {
    const owner = await authedAgent(app, { email: 'owner@badaddr.test' });
    await owner.agent
      .post(`/api/v1/teams/${owner.teamId}/invites`)
      .send({ role: 'viewer', email: 'not-an-email' })
      .expect(400);
    expect(await prisma.teamInvite.count({ where: { teamId: owner.teamId } })).toBe(0);
  });

  it(`returns 429 EMAIL_RATE_LIMITED past ${INVITE_EMAIL_CAP} emails in an hour`, async () => {
    const owner = await authedAgent(app, { email: 'owner@cap.test' });

    for (let i = 0; i < INVITE_EMAIL_CAP; i++) {
      await owner.agent
        .post(`/api/v1/teams/${owner.teamId}/invites`)
        .send({ role: 'viewer', email: `spam${i}@example.com` })
        .expect(201);
    }

    const res = await owner.agent
      .post(`/api/v1/teams/${owner.teamId}/invites`)
      .send({ role: 'viewer', email: 'spam-over@example.com' })
      .expect(429);
    expect(res.body.error.code).toBe('EMAIL_RATE_LIMITED');

    // The rejected request wrote nothing.
    expect(await prisma.teamInvite.count({ where: { teamId: owner.teamId } })).toBe(
      INVITE_EMAIL_CAP,
    );

    // A copy-link invite is still allowed past the cap.
    await owner.agent
      .post(`/api/v1/teams/${owner.teamId}/invites`)
      .send({ role: 'viewer' })
      .expect(201);
  });

  it('still returns 201 with a usable token when the email enqueue path throws', async () => {
    const owner = await authedAgent(app, { email: 'owner@enqueuefail.test' });

    // Simulates a Redis outage on the `queue.add()` leg of `EmailService.enqueue()`
    // — the class doc's "creating an invite must not fail because SES hiccuped"
    // promise only ever covered SES; this proves it now also holds for the
    // queue path, which the invite row and audit event do not depend on.
    const addSpy = jest
      .spyOn(getEmailQueue(), 'add')
      .mockRejectedValueOnce(new Error('simulated redis outage'));

    try {
      const res = await owner.agent
        .post(`/api/v1/teams/${owner.teamId}/invites`)
        .send({ role: 'viewer', email: 'newbie4@example.com' })
        .expect(201);

      expect(res.body.token).toBeDefined();
      expect(res.body.email).toBe('newbie4@example.com');

      const invite = await prisma.teamInvite.findUnique({ where: { id: res.body.id } });
      expect(invite?.token).toBe(res.body.token);
      expect(invite?.email).toBe('newbie4@example.com');
    } finally {
      addSpy.mockRestore();
    }
  });

  it('lists the recipient address on pending invites', async () => {
    const owner = await authedAgent(app, { email: 'owner@listemail.test' });
    await owner.agent
      .post(`/api/v1/teams/${owner.teamId}/invites`)
      .send({ role: 'viewer', email: 'listed@example.com' })
      .expect(201);
    await owner.agent
      .post(`/api/v1/teams/${owner.teamId}/invites`)
      .send({ role: 'viewer' })
      .expect(201);

    const res = await owner.agent
      .get(`/api/v1/teams/${owner.teamId}/invites`)
      .expect(200);

    // Array.prototype.sort()'s default comparator coerces every element to a
    // string, so the lone `null` becomes "null" and sorts after any string
    // starting with a letter earlier than 'n' — hence the string first here.
    const emails = res.body.map((i: { email: string | null }) => i.email).sort();
    expect(emails).toEqual(['listed@example.com', null]);
  });
});
