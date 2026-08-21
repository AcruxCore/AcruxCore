import request from 'supertest';
import { createApp } from '../../app';
import prisma from '../shared/db/client';
import { addUserToTeam, authHeaders, authedAgent, signupTestUser } from '../test-utils';
import { drainEmailQueue, getEmailQueue } from '../email/email.queue';
import { getMemoryTransport } from '../email/memory.transport';
import type { EmailMessage } from '../email/email.types';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';
import { notify, resolveAudience, unsubscribeLink } from './notify';

const app = createApp();
const service = new NotificationsService(new NotificationsRepository());

/** Sends everything queued and returns the messages the memory transport accepted. */
async function flush(): Promise<EmailMessage[]> {
  await drainEmailQueue();
  return getMemoryTransport().sent();
}

/** Recipients of the queued mail, sorted so assertions do not depend on fan-out order. */
async function flushRecipients(): Promise<string[]> {
  return (await flush()).map((m) => m.to).sort();
}

beforeEach(async () => {
  // Purge BEFORE truncating, and without processing: a leftover job from the
  // previous test points at an `email_log` row that TRUNCATE is about to delete,
  // so draining it would fail on `markSent` instead of being cleaned up.
  await getEmailQueue().obliterate({ force: true });

  await prisma.$executeRaw`TRUNCATE TABLE
    notification_preferences, email_log, team_invites, audit_log, api_keys,
    team_members, teams, users
  RESTART IDENTITY CASCADE`;
  getMemoryTransport().reset();
});

describe('notification preferences API', () => {
  it('defaults every category to enabled with no rows stored', async () => {
    const owner = await authedAgent(app, { email: 'prefs-default@notif.test' });

    const res = await owner.agent.get('/api/v1/notifications/preferences').expect(200);

    expect(res.body.preferences).toEqual({
      budget_alerts: true,
      eval_runs: true,
      eval_rules: true,
      membership: true,
      weekly_digest: true,
    });
    // The default is computed, not seeded — nothing is written at signup.
    expect(await prisma.notificationPreference.count()).toBe(0);
  });

  it('PATCH then GET round-trips, and a second PATCH updates rather than duplicating', async () => {
    const owner = await authedAgent(app, { email: 'prefs-patch@notif.test' });

    const off = await owner.agent
      .patch('/api/v1/notifications/preferences')
      .send({ category: 'budget_alerts', enabled: false })
      .expect(200);
    expect(off.body.preferences.budget_alerts).toBe(false);
    expect(off.body.preferences.eval_runs).toBe(true);

    const read = await owner.agent.get('/api/v1/notifications/preferences').expect(200);
    expect(read.body.preferences.budget_alerts).toBe(false);

    const backOn = await owner.agent
      .patch('/api/v1/notifications/preferences')
      .send({ category: 'budget_alerts', enabled: true })
      .expect(200);
    expect(backOn.body.preferences.budget_alerts).toBe(true);

    // The unique key means an update, not an insert.
    expect(
      await prisma.notificationPreference.count({
        where: { teamId: owner.teamId, userId: owner.userId, category: 'budget_alerts' },
      }),
    ).toBe(1);
  });

  it('rejects an unknown category', async () => {
    const owner = await authedAgent(app, { email: 'prefs-bad@notif.test' });

    await owner.agent
      .patch('/api/v1/notifications/preferences')
      .send({ category: 'not_a_category', enabled: false })
      .expect(400);
  });

  it('requires authentication', async () => {
    await request(app).get('/api/v1/notifications/preferences').expect(401);
  });

  it('scopes a preference to one team — opting out of team A leaves team B flowing', async () => {
    const teamA = await authedAgent(app, { email: 'multi-a@notif.test' });
    const teamB = await authedAgent(app, { email: 'multi-b@notif.test' });

    // One user, owner of A, also an admin of B.
    const inA = await prisma.teamMember.findFirstOrThrow({
      where: { userId: teamA.userId, teamId: teamA.teamId },
    });
    expect(inA).toBeTruthy();
    await prisma.teamMember.create({
      data: { userId: teamA.userId, teamId: teamB.teamId, role: 'admin' },
    });

    await service.update(teamA.teamId, teamA.userId, {
      category: 'budget_alerts',
      enabled: false,
    });

    const optedOutInA = await new NotificationsRepository().findOptedOutUserIds(
      teamA.teamId,
      'budget_alerts',
      [teamA.userId],
    );
    const optedOutInB = await new NotificationsRepository().findOptedOutUserIds(
      teamB.teamId,
      'budget_alerts',
      [teamA.userId],
    );

    expect([...optedOutInA]).toEqual([teamA.userId]);
    expect([...optedOutInB]).toEqual([]);
  });
});

describe('recipient resolution', () => {
  it('returns owners and admins but not editors or viewers', async () => {
    const owner = await authedAgent(app, { email: 'aud-owner@notif.test' });
    const admin = await addUserToTeam(app, owner.teamId, 'admin');
    const editor = await addUserToTeam(app, owner.teamId, 'editor');
    const viewer = await addUserToTeam(app, owner.teamId, 'viewer');

    const resolved = await resolveAudience(owner.teamId, { roles: ['owner', 'admin'] });
    const emails = resolved.map((r) => r.email).sort();

    expect(emails).toEqual([admin.email, owner.email].sort());
    expect(emails).not.toContain(editor.email);
    expect(emails).not.toContain(viewer.email);
  });

  it('falls back to the fallback roles only when the primary audience is empty', async () => {
    const owner = await authedAgent(app, { email: 'aud-fallback@notif.test' });

    const withNobody = await resolveAudience(owner.teamId, {
      userIds: [],
      fallbackRoles: ['owner'],
    });
    expect(withNobody.map((r) => r.email)).toEqual([owner.email]);

    // With a real primary audience the fallback must NOT be added on top.
    const explicit = await addUserToTeam(app, owner.teamId, 'editor');
    const withSomebody = await resolveAudience(owner.teamId, {
      userIds: [explicit.userId],
      fallbackRoles: ['owner'],
    });
    expect(withSomebody.map((r) => r.email)).toEqual([explicit.email]);
  });
});

describe('notify()', () => {
  it('skips a user who opted out, and still mails their teammates', async () => {
    const owner = await authedAgent(app, { email: 'optout-owner@notif.test' });
    const admin = await addUserToTeam(app, owner.teamId, 'admin');

    await service.update(owner.teamId, owner.userId, {
      category: 'budget_alerts',
      enabled: false,
    });

    const sent = await notify({
      teamId: owner.teamId,
      category: 'budget_alerts',
      audience: { roles: ['owner', 'admin'] },
      dedupeKey: 'budget:test-optout',
      payload: {
        type: 'budget_threshold',
        props: {
          teamName: 'T',
          scopeLabel: 'Team-wide',
          period: 'month',
          limitUsd: 10,
          spendUsd: 8,
          budgetsUrl: 'http://localhost:5173/gateway/budgets',
        },
      },
    });

    expect(sent).toBe(1);
    expect(await flushRecipients()).toEqual([admin.email]);
  });

  it('collapses a repeated event to one email per recipient', async () => {
    const owner = await authedAgent(app, { email: 'dedupe@notif.test' });

    const props = {
      teamName: 'T',
      scopeLabel: 'Team-wide',
      period: 'month',
      limitUsd: 10,
      spendUsd: 8,
      budgetsUrl: 'http://localhost:5173/gateway/budgets',
    };
    const input = {
      teamId: owner.teamId,
      category: 'budget_alerts' as const,
      audience: { roles: ['owner' as const] },
      dedupeKey: 'budget:same-key',
      payload: { type: 'budget_threshold' as const, props },
    };

    expect(await notify(input)).toBe(1);
    // Same dedupe key: BullMQ keeps the first job and the second enqueue is a no-op.
    expect(await notify(input)).toBe(0);

    expect(await flushRecipients()).toEqual([owner.email]);
  });

  it('never throws, and returns 0, when the transport is broken', async () => {
    const owner = await authedAgent(app, { email: 'throw@notif.test' });
    getMemoryTransport().failWith(new Error('SES is down'));

    // The enqueue itself still succeeds — delivery is what fails, in the worker.
    const sent = await notify({
      teamId: owner.teamId,
      category: 'membership',
      audience: { roles: ['owner'] },
      dedupeKey: 'membership:broken-transport',
      payload: {
        type: 'member_joined',
        props: {
          teamName: 'T',
          memberName: 'M',
          actorName: 'M',
          role: 'viewer',
          teamUrl: 'http://localhost:5173/team',
        },
      },
    });
    expect(sent).toBe(1);

    // Draining rethrows the delivery failure, which is what BullMQ would retry.
    await expect(drainEmailQueue()).rejects.toThrow('SES is down');

    const row = await prisma.emailLog.findFirstOrThrow({ where: { teamId: owner.teamId } });
    expect(row.status).toBe('failed');
    expect(row.error).toContain('SES is down');

    getMemoryTransport().failWith(null);
  });

  it('enqueues nothing when the audience is empty', async () => {
    const owner = await authedAgent(app, { email: 'empty-aud@notif.test' });

    const sent = await notify({
      teamId: owner.teamId,
      category: 'membership',
      // No owners/admins match because only editors are asked for, and there are none.
      audience: { roles: ['editor'] },
      dedupeKey: 'membership:nobody',
      payload: {
        type: 'member_joined',
        props: {
          teamName: 'T',
          memberName: 'M',
          actorName: 'M',
          role: 'viewer',
          teamUrl: 'http://localhost:5173/team',
        },
      },
    });

    expect(sent).toBe(0);
    expect(await flush()).toHaveLength(0);
  });

  it('gives each recipient their own unsubscribe token', async () => {
    const owner = await authedAgent(app, { email: 'unsub-per-user@notif.test' });
    const admin = await addUserToTeam(app, owner.teamId, 'admin');

    await notify({
      teamId: owner.teamId,
      category: 'membership',
      audience: { roles: ['owner', 'admin'] },
      dedupeKey: 'membership:tokens',
      payload: {
        type: 'member_joined',
        props: {
          teamName: 'T',
          memberName: 'M',
          actorName: 'M',
          role: 'viewer',
          teamUrl: 'http://localhost:5173/team',
        },
      },
    });

    const messages = await flush();
    expect(messages).toHaveLength(2);

    const tokenOf = (m: EmailMessage): string =>
      new URL(m.text.match(/https?:\/\/\S*unsubscribe\S*/)![0]).searchParams.get('token')!;
    const tokens = messages.map(tokenOf);

    expect(tokens[0]).not.toBe(tokens[1]);
    expect(new Set(tokens).size).toBe(2);
    // Each token is the one minted for that message's own recipient.
    for (const m of messages) {
      const userId = m.to === admin.email ? admin.userId : owner.userId;
      expect(tokenOf(m)).toBe(
        new URL(unsubscribeLink(userId, owner.teamId, 'membership')).searchParams.get('token'),
      );
    }
  });
});

describe('membership notifications', () => {
  it('emails the affected member and the owners when the role changes', async () => {
    const owner = await authedAgent(app, { email: 'roles-owner@notif.test' });
    const target = await addUserToTeam(app, owner.teamId, 'viewer');

    await owner.agent
      .patch(`/api/v1/teams/${owner.teamId}/members/${target.userId}/roles`)
      .send({ role: 'editor' })
      .expect(200);

    const messages = await flush();
    expect(messages.map((m) => m.to).sort()).toEqual([owner.email, target.email].sort());
    expect(messages[0].text).toContain('editor');
    expect(messages[0].subject).toContain('role');
  });

  it('emails a removed member even when they disabled membership notifications', async () => {
    const owner = await authedAgent(app, { email: 'rm-owner@notif.test' });
    const target = await addUserToTeam(app, owner.teamId, 'editor');

    await service.update(owner.teamId, target.userId, {
      category: 'membership',
      enabled: false,
    });

    await owner.agent
      .delete(`/api/v1/teams/${owner.teamId}/members/${target.userId}`)
      .expect(204);

    // Gone from the team...
    expect(
      await prisma.teamMember.findFirst({ where: { teamId: owner.teamId, userId: target.userId } }),
    ).toBeNull();

    // ...and still told about it, preference notwithstanding.
    const recipients = await flushRecipients();
    expect(recipients).toContain(target.email);
    expect(recipients).toContain(owner.email);
  });

  it('a removal still succeeds when notification delivery is broken', async () => {
    const owner = await authedAgent(app, { email: 'rm-broken@notif.test' });
    const target = await addUserToTeam(app, owner.teamId, 'editor');
    getMemoryTransport().failWith(new Error('mail server on fire'));

    await owner.agent
      .delete(`/api/v1/teams/${owner.teamId}/members/${target.userId}`)
      .expect(204);

    expect(
      await prisma.teamMember.findFirst({ where: { teamId: owner.teamId, userId: target.userId } }),
    ).toBeNull();

    getMemoryTransport().failWith(null);
  });

  it('emails owners and admins when an invite is accepted', async () => {
    const owner = await authedAgent(app, { email: 'joined-owner@notif.test' });
    const admin = await addUserToTeam(app, owner.teamId, 'admin');
    const editor = await addUserToTeam(app, owner.teamId, 'editor');

    const invite = await owner.agent
      .post(`/api/v1/teams/${owner.teamId}/invites`)
      .send({ role: 'viewer' })
      .expect(201);

    const joiner = await signupTestUser(app, { email: 'joiner@notif.test' });
    await request(app)
      .post(`/api/v1/teams/invites/${invite.body.token}/accept`)
      .set(authHeaders(joiner))
      .expect(200);

    const recipients = await flushRecipients();
    expect(recipients).toEqual([admin.email, owner.email].sort());
    // Membership is the owners' and admins' business, not every member's.
    expect(recipients).not.toContain(editor.email);
    expect(recipients).not.toContain(joiner.email);
  });
});
