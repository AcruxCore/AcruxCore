import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../app';
import prisma from '../shared/db/client';
import { resetAuthTables } from '../test-utils';
import { resetAuth, resetAuthConfig } from '../shared/auth';
import { getMemoryTransport, resetEmailConfig, resetTransport } from '../email';
import { getEmailQueue } from './email.queue';
import { processEmail } from './email.processor';
import { mintResetLink } from '../auth/reset-link';
import { renderEmail } from './templates';

const PASSWORD = 'account-email-password-1';

/** Rebuilds the app so an env change is actually picked up. */
function rebuildApp() {
  resetAuthConfig();
  resetEmailConfig();
  resetTransport();
  resetAuth();
  return createApp();
}

async function clean(): Promise<void> {
  await getEmailQueue().obliterate({ force: true });
  await resetAuthTables();
  getMemoryTransport().reset();
}

/** Runs every queued job through the real processor so bodies exist. */
async function drain(): Promise<void> {
  const jobs = await getEmailQueue().getJobs(['waiting', 'delayed', 'active']);
  for (const job of jobs) await processEmail(job.data);
}

const ORIGINAL_ENV = { ...process.env };
beforeEach(clean);
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});
afterAll(() => {
  // No cleanup work here — the global teardown runs first and closes Redis.
  process.env = { ...ORIGINAL_ENV };
});

describe('welcome email', () => {
  it('is sent after verification, not at signup', async () => {
    process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = 'true';
    const app = rebuildApp();
    const email = `welcome-${randomUUID()}@example.com`;

    await request(app)
      .post('/api/v1/auth/sign-up/email')
      .send({ email, password: PASSWORD, name: 'Newcomer' });

    // Only the verification email so far. Welcoming an unconfirmed address means
    // welcoming someone who may never have asked to sign up.
    let types = (await prisma.emailLog.findMany({ where: { toEmail: email } })).map((r) => r.type);
    expect(types).toEqual(['verify_email']);

    const token = await verificationTokenFor(email);
    // No `callbackURL` here, so the endpoint answers with JSON rather than the
    // redirect a real click gets.
    await request(app).get(`/api/v1/auth/verify-email?token=${token}`).expect(200);

    types = (await prisma.emailLog.findMany({ where: { toEmail: email } })).map((r) => r.type);
    expect(types.sort()).toEqual(['verify_email', 'welcome']);
  });

  it('names the team the new owner actually landed in', async () => {
    process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = 'true';
    const app = rebuildApp();
    const email = `welcome2-${randomUUID()}@example.com`;
    await request(app)
      .post('/api/v1/auth/sign-up/email')
      .send({ email, password: PASSWORD, name: 'Newcomer' });
    const token = await verificationTokenFor(email);
    await request(app).get(`/api/v1/auth/verify-email?token=${token}`).expect(200);

    await drain();
    const welcome = getMemoryTransport()
      .sent()
      .find((m) => m.subject.includes('Welcome'));
    expect(welcome).toBeDefined();
    expect(welcome!.html).toContain(`${email}&#39;s team`);
  });
});

describe('password-changed email', () => {
  it('is sent after a completed reset and revokes every session', async () => {
    const app = rebuildApp();
    const email = `changed-${randomUUID()}@example.com`;
    const signUp = await request(app)
      .post('/api/v1/auth/sign-up/email')
      .send({ email, password: PASSWORD, name: 'Changer' })
      .expect(200);
    const cookie = (signUp.headers['set-cookie'] as unknown as string[])
      .find((c) => c.includes('session_token'))!
      .split(';')[0];
    expect(await prisma.authSession.count()).toBe(1);

    const url = await mintResetLink(email);
    const token = new URL(url!).pathname.split('/').pop()!;
    await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ newPassword: 'a-brand-new-password-9', token })
      .expect(200);

    // Revocation is the point: someone resetting because they were compromised
    // must not leave the intruder signed in.
    expect(await prisma.authSession.count()).toBe(0);
    await request(app).get('/api/v1/auth/me').set('Cookie', cookie).expect(401);

    const types = (await prisma.emailLog.findMany({ where: { toEmail: email } })).map((r) => r.type);
    expect(types).toContain('password_changed');
  });
});

describe('new sign-in alert', () => {
  it('stays silent for the first device but fires for a second', async () => {
    const app = rebuildApp();
    const email = `device-${randomUUID()}@example.com`;

    await request(app)
      .post('/api/v1/auth/sign-up/email')
      .set('User-Agent', 'FirstDevice/1.0')
      .send({ email, password: PASSWORD, name: 'Device Owner' })
      .expect(200);

    // The signup itself is the first device — verify/welcome already cover it, and
    // "you signed in" seconds after "welcome" reads like a bug.
    expect(await prisma.knownDevice.count()).toBe(1);
    expect(
      await prisma.emailLog.count({ where: { toEmail: email, type: 'new_sign_in' } }),
    ).toBe(0);

    await request(app)
      .post('/api/v1/auth/sign-in/email')
      .set('User-Agent', 'SecondDevice/2.0')
      .send({ email, password: PASSWORD })
      .expect(200);

    expect(await prisma.knownDevice.count()).toBe(2);
    expect(
      await prisma.emailLog.count({ where: { toEmail: email, type: 'new_sign_in' } }),
    ).toBe(1);
  });

  it('does not fire again for a device already seen', async () => {
    const app = rebuildApp();
    const email = `device2-${randomUUID()}@example.com`;
    await request(app)
      .post('/api/v1/auth/sign-up/email')
      .set('User-Agent', 'KnownDevice/1.0')
      .send({ email, password: PASSWORD, name: 'Device Owner' })
      .expect(200);

    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/api/v1/auth/sign-in/email')
        .set('User-Agent', 'KnownDevice/1.0')
        .send({ email, password: PASSWORD })
        .expect(200);
    }

    // An alert on every sign-in is an alert nobody reads by the second week.
    expect(await prisma.knownDevice.count()).toBe(1);
    expect(
      await prisma.emailLog.count({ where: { toEmail: email, type: 'new_sign_in' } }),
    ).toBe(0);
  });

  it('escapes a hostile user-agent instead of rendering it as markup', () => {
    // The user-agent is attacker-controlled and shown verbatim, so the escaping
    // is the only thing between it and the recipient's mail client.
    const rendered = renderEmail({
      type: 'new_sign_in',
      props: {
        signedInAt: '2026-07-26T10:00:00.000Z',
        ipAddress: '203.0.113.7',
        userAgent: '<img src=x onerror="alert(1)">',
        resetUrl: 'https://acruxcore.com/reset-password',
      },
    });
    expect(rendered.html).not.toContain('<img src=x');
    expect(rendered.html).toContain('&lt;img src=x');
    expect(rendered.html).toContain('203.0.113.7');
  });

  it('renders "Not reported" when the proxy supplied nothing', () => {
    const rendered = renderEmail({
      type: 'new_sign_in',
      props: {
        signedInAt: '2026-07-26T10:00:00.000Z',
        ipAddress: null,
        userAgent: null,
        resetUrl: 'https://acruxcore.com/reset-password',
      },
    });
    expect(rendered.html).toContain('Not reported');
    expect(rendered.text).toContain('Not reported');
  });
});

describe('account emails on a no-email deployment', () => {
  it('sends none of them', async () => {
    process.env.EMAIL_TRANSPORT = 'none';
    const app = rebuildApp();
    const email = `silent-${randomUUID()}@example.com`;
    await request(app)
      .post('/api/v1/auth/sign-up/email')
      .set('User-Agent', 'A/1.0')
      .send({ email, password: PASSWORD, name: 'Silent' })
      .expect(200);
    await request(app)
      .post('/api/v1/auth/sign-in/email')
      .set('User-Agent', 'B/2.0')
      .send({ email, password: PASSWORD })
      .expect(200);

    expect(await prisma.emailLog.count()).toBe(0);
    // The device is still recorded, so switching a transport on later does not
    // produce a burst of alerts for machines the user has been using all along.
    expect(await prisma.knownDevice.count()).toBe(2);
  });
});

/**
 * Pulls the verification token out of the email that was actually sent.
 *
 * Not read from `auth_verifications`, because email verification does not use
 * one: Better Auth signs a JWT carrying the address, so nothing is stored and
 * there is no row to query (password reset, by contrast, does store an opaque
 * token). Parsing the delivered message is also the more faithful test — it
 * proves the link a real recipient receives is the one that works.
 *
 * @param email - The address that was signed up.
 * @returns The `token` query parameter from the verification URL.
 * @throws {Error} If no verification email reached the transport.
 */
async function verificationTokenFor(email: string): Promise<string> {
  await drain();
  const message = getMemoryTransport()
    .sent()
    .find((m) => m.to === email && m.subject.includes('Confirm'));
  if (!message) throw new Error(`No verification email was sent to ${email}`);
  const url = /https?:\/\/[^\s"<]*verify-email\?token=[^\s"<&]+/.exec(message.text);
  if (!url) throw new Error(`No verification link in the email to ${email}`);
  return new URL(url[0]).searchParams.get('token')!;
}
