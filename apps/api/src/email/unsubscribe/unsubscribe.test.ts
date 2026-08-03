import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { addUserToTeam, authedAgent } from '../../test-utils';
import { getEmailQueue, drainEmailQueue } from '../email.queue';
import { getMemoryTransport } from '../memory.transport';
import { NotificationsRepository } from '../../notifications/notifications.repository';
import { notify } from '../../notifications/notify';
import { mintUnsubscribeToken, verifyUnsubscribeToken } from './unsubscribe.token';

const app = createApp();

/** A fixed 32-byte key, so tokens are reproducible within the suite. */
const SECRET = Buffer.alloc(32, 9).toString('base64');
const ORIGINAL_SECRET = process.env.EMAIL_UNSUBSCRIBE_SECRET;

beforeAll(() => {
  process.env.EMAIL_UNSUBSCRIBE_SECRET = SECRET;
});

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
  else process.env.EMAIL_UNSUBSCRIBE_SECRET = ORIGINAL_SECRET;
});

beforeEach(async () => {
  await getEmailQueue().obliterate({ force: true });
  await prisma.$executeRaw`TRUNCATE TABLE
    notification_preferences, email_log, audit_log, api_keys,
    team_members, teams, users
  RESTART IDENTITY CASCADE`;
  getMemoryTransport().reset();
});

describe('unsubscribe token', () => {
  it('round-trips the claims it was minted with', () => {
    const claims = {
      userId: '11111111-1111-1111-1111-111111111111',
      teamId: '22222222-2222-2222-2222-222222222222',
      category: 'weekly_digest',
    };

    expect(verifyUnsubscribeToken(mintUnsubscribeToken(claims))).toEqual(claims);
  });

  it('is deterministic for the same claims and distinct across them', () => {
    const base = { userId: 'u', teamId: 't', category: 'weekly_digest' };
    expect(mintUnsubscribeToken(base)).toBe(mintUnsubscribeToken({ ...base }));
    expect(mintUnsubscribeToken(base)).not.toBe(
      mintUnsubscribeToken({ ...base, category: 'budget_alerts' }),
    );
    expect(mintUnsubscribeToken(base)).not.toBe(
      mintUnsubscribeToken({ ...base, teamId: 'other' }),
    );
  });

  it('rejects a flipped byte in the signature', () => {
    const token = mintUnsubscribeToken({ userId: 'u', teamId: 't', category: 'membership' });
    const [payload, sig] = token.split('.');
    const bytes = Buffer.from(sig, 'base64url');
    bytes[0] = bytes[0] ^ 0xff;

    expect(verifyUnsubscribeToken(`${payload}.${bytes.toString('base64url')}`)).toBeNull();
  });

  it('rejects a tampered payload the signature no longer covers', () => {
    // The attack this blocks: swap in another user's id but keep a valid-looking HMAC.
    const token = mintUnsubscribeToken({ userId: 'victim', teamId: 't', category: 'membership' });
    const [, sig] = token.split('.');
    const forged = Buffer.from('attacker:t:membership', 'utf8').toString('base64url');

    expect(verifyUnsubscribeToken(`${forged}.${sig}`)).toBeNull();
  });

  it('rejects malformed shapes without throwing', () => {
    for (const bad of [
      undefined,
      '',
      'no-dot',
      '.',
      'payload.',
      '.signature',
      'a.b',
      `${Buffer.from('u:t:c').toString('base64url')}.${Buffer.alloc(16).toString('base64url')}`,
    ]) {
      expect(verifyUnsubscribeToken(bad as string | undefined)).toBeNull();
    }
  });

  it('rejects a token signed with a different secret', () => {
    const token = mintUnsubscribeToken({ userId: 'u', teamId: 't', category: 'membership' });
    process.env.EMAIL_UNSUBSCRIBE_SECRET = Buffer.alloc(32, 1).toString('base64');
    try {
      expect(verifyUnsubscribeToken(token)).toBeNull();
    } finally {
      process.env.EMAIL_UNSUBSCRIBE_SECRET = SECRET;
    }
  });
});

describe('POST /api/v1/email/unsubscribe', () => {
  it('turns the category off with no authentication at all, and returns 204', async () => {
    const owner = await authedAgent(app);
    const token = mintUnsubscribeToken({
      userId: owner.userId,
      teamId: owner.teamId,
      category: 'weekly_digest',
    });

    await request(app)
      .post(`/api/v1/email/unsubscribe?token=${encodeURIComponent(token)}`)
      .expect(204);

    const row = await prisma.notificationPreference.findFirstOrThrow({
      where: { userId: owner.userId, teamId: owner.teamId, category: 'weekly_digest' },
    });
    expect(row.enabled).toBe(false);
  });

  it('is idempotent — posting twice leaves exactly one row', async () => {
    const owner = await authedAgent(app);
    const token = mintUnsubscribeToken({
      userId: owner.userId,
      teamId: owner.teamId,
      category: 'weekly_digest',
    });
    const url = `/api/v1/email/unsubscribe?token=${encodeURIComponent(token)}`;

    await request(app).post(url).expect(204);
    await request(app).post(url).expect(204);

    expect(
      await prisma.notificationPreference.count({
        where: { userId: owner.userId, teamId: owner.teamId, category: 'weekly_digest' },
      }),
    ).toBe(1);
  });

  it('answers a tampered token exactly as it answers a valid one', async () => {
    const owner = await authedAgent(app);
    const valid = mintUnsubscribeToken({
      userId: owner.userId,
      teamId: owner.teamId,
      category: 'weekly_digest',
    });
    const [payload, sig] = valid.split('.');
    const bytes = Buffer.from(sig, 'base64url');
    bytes[5] = bytes[5] ^ 0xff;
    const tampered = `${payload}.${bytes.toString('base64url')}`;

    const good = await request(app)
      .post(`/api/v1/email/unsubscribe?token=${encodeURIComponent(valid)}`)
      .expect(204);
    const bad = await request(app)
      .post(`/api/v1/email/unsubscribe?token=${encodeURIComponent(tampered)}`)
      .expect(204);

    // Same status and same body: the endpoint cannot be used to probe which
    // (user, team) pairs exist, or which tokens are genuine.
    expect(bad.status).toBe(good.status);
    expect(bad.text).toBe(good.text);
    // And the tampered one wrote nothing.
    expect(await prisma.notificationPreference.count()).toBe(1);
  });

  it('writes nothing when the token names a user who is no longer in that team', async () => {
    const owner = await authedAgent(app);
    const removed = await addUserToTeam(app, owner.teamId, 'editor');
    const token = mintUnsubscribeToken({
      userId: removed.userId,
      teamId: owner.teamId,
      category: 'weekly_digest',
    });

    await owner.agent.delete(`/api/v1/teams/${owner.teamId}/members/${removed.userId}`).expect(204);

    await request(app)
      .post(`/api/v1/email/unsubscribe?token=${encodeURIComponent(token)}`)
      .expect(204);

    expect(
      await prisma.notificationPreference.count({ where: { userId: removed.userId } }),
    ).toBe(0);
  });

  it('returns 204 for a missing token rather than an error a mail client would surface', async () => {
    await request(app).post('/api/v1/email/unsubscribe').expect(204);
  });
});

describe('GET /api/v1/email/unsubscribe', () => {
  it('performs the same opt-out and renders a confirmation page', async () => {
    const owner = await authedAgent(app);
    const token = mintUnsubscribeToken({
      userId: owner.userId,
      teamId: owner.teamId,
      category: 'budget_alerts',
    });

    const res = await request(app)
      .get(`/api/v1/email/unsubscribe?token=${encodeURIComponent(token)}`)
      .expect(200);

    expect(res.text).toContain('Unsubscribed');
    expect(res.text).toContain('budget alerts');
    const row = await prisma.notificationPreference.findFirstOrThrow({
      where: { userId: owner.userId, teamId: owner.teamId, category: 'budget_alerts' },
    });
    expect(row.enabled).toBe(false);
  });

  it('renders the same 200 page for an invalid token', async () => {
    const res = await request(app).get('/api/v1/email/unsubscribe?token=garbage.garbage').expect(200);

    expect(res.text).toContain('Unsubscribed');
    expect(await prisma.notificationPreference.count()).toBe(0);
  });
});

describe('unsubscribing actually stops the mail', () => {
  it('the link in a delivered email suppresses the next send to that recipient', async () => {
    const owner = await authedAgent(app);
    const admin = await addUserToTeam(app, owner.teamId, 'admin');

    const send = (key: string): Promise<number> =>
      notify({
        teamId: owner.teamId,
        category: 'budget_alerts',
        audience: { roles: ['owner', 'admin'] },
        dedupeKey: key,
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

    expect(await send('budget:first')).toBe(2);
    await drainEmailQueue();
    const first = getMemoryTransport().sent();
    expect(first).toHaveLength(2);

    // Take the owner's own link straight out of the email they received.
    const ownerMessage = first.find((m) => m.to === owner.email)!;
    const link = ownerMessage.text.match(/https?:\/\/\S*unsubscribe\S*/)![0];
    await request(app).post(new URL(link).pathname + new URL(link).search).expect(204);

    expect(
      [...(await new NotificationsRepository().findOptedOutUserIds(owner.teamId, 'budget_alerts', [
        owner.userId,
        admin.userId,
      ]))],
    ).toEqual([owner.userId]);

    // A later event now reaches only the admin.
    getMemoryTransport().reset();
    expect(await send('budget:second')).toBe(1);
    await drainEmailQueue();
    expect(getMemoryTransport().sent().map((m) => m.to)).toEqual([admin.email]);
  });
});
