import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Application } from 'express';
import { createApp } from '../../app';
import prisma from '../shared/db/client';
import { resetAuthTables } from '../test-utils';
import { resetAuth, resetAuthConfig } from '../shared/auth';
import { resetEmailConfig, resetTransport, getMemoryTransport } from '../email';
import { getEmailQueue } from '../email/email.queue';
import { mintResetLink } from './reset-link';

const PASSWORD = 'flow-password-not-a-real-one';
const NEW_PASSWORD = 'flow-new-password-not-real';

/**
 * Rebuilds the app with the current environment.
 *
 * Both the auth and email configs memoize on first read, and `createApp` captures
 * the Better Auth instance when it mounts the handler — so a test that changes an
 * env var must drop all three caches or it silently asserts against the previous
 * configuration.
 */
function rebuildApp(): Application {
  resetAuthConfig();
  resetEmailConfig();
  resetTransport();
  resetAuth();
  return createApp();
}

async function clean(): Promise<void> {
  // Purge the queue BEFORE truncating: a leftover job points at an `email_log`
  // row this delete is about to remove, and settling it later fails inside
  // `markSent`.
  await getEmailQueue().obliterate({ force: true });
  await resetAuthTables();
  getMemoryTransport().reset();
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(clean);

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterAll(() => {
  // Restore the environment only. Deliberately NO cleanup work here: the global
  // teardown in `test-utils/jest-teardown.ts` registers its `afterAll` first and
  // therefore runs first, closing Redis and Prisma — so anything here that
  // touched the queue would silently reopen the connection it had just closed
  // and leave Jest with a live handle it can never exit on. `beforeEach` already
  // leaves the database clean for the next suite.
  //
  // Config caches need no reset: each test file gets a fresh module registry, so
  // the next suite re-reads these restored values from scratch.
  process.env = { ...ORIGINAL_ENV };
});

describe('email verification gate (AUTH_REQUIRE_EMAIL_VERIFICATION=true)', () => {
  it('withholds the session at signup and enqueues a verification email', async () => {
    process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = 'true';
    const app = rebuildApp();
    const email = `gate-${randomUUID()}@example.com`;

    const res = await request(app)
      .post('/api/v1/auth/sign-up/email')
      .send({ email, password: PASSWORD, name: 'Gated' });

    // No session cookie: an unverified address must not be a way in, or the gate
    // would be trivially skippable.
    const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    expect(cookies.some((c) => c.includes('session_token'))).toBe(false);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerified).toBe(false);

    const log = await prisma.emailLog.findFirst({ where: { toEmail: email } });
    expect(log?.type).toBe('verify_email');
  });

  it('refuses sign-in until the address is verified', async () => {
    process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = 'true';
    const app = rebuildApp();
    const email = `gate2-${randomUUID()}@example.com`;

    await request(app)
      .post('/api/v1/auth/sign-up/email')
      .send({ email, password: PASSWORD, name: 'Gated' });

    await request(app)
      .post('/api/v1/auth/sign-in/email')
      .send({ email, password: PASSWORD })
      .expect(403);
  });

  it('the verification email links to our own domain, never a vendor', async () => {
    // The whole reason for leaving Supabase Auth: its links pointed at
    // <project>.supabase.co.
    process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = 'true';
    process.env.APP_URL = 'https://acruxcore.example';
    const app = rebuildApp();
    const email = `link-${randomUUID()}@example.com`;

    await request(app)
      .post('/api/v1/auth/sign-up/email')
      .send({ email, password: PASSWORD, name: 'Linked' });

    // Drain the queue through the real processor so the rendered body exists.
    const queue = getEmailQueue();
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.length).toBeGreaterThan(0);

    const { processEmail } = await import('../email/email.processor');
    for (const job of jobs) await processEmail(job.data);

    const sent = getMemoryTransport().sent();
    const verify = sent.find((m) => m.to === email);
    expect(verify).toBeDefined();
    expect(verify!.html).toContain('https://acruxcore.example');
    expect(verify!.html).not.toContain('supabase');
  });
});

describe('EMAIL_TRANSPORT=none (self-host, no mail)', () => {
  it('creates accounts already verified and signs them in immediately', async () => {
    process.env.EMAIL_TRANSPORT = 'none';
    delete process.env.AUTH_REQUIRE_EMAIL_VERIFICATION;
    const app = rebuildApp();
    const email = `none-${randomUUID()}@example.com`;

    const res = await request(app)
      .post('/api/v1/auth/sign-up/email')
      .send({ email, password: PASSWORD, name: 'No Mail' })
      .expect(200);

    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((c) => c.includes('session_token'))).toBe(true);

    const cookie = cookies.find((c) => c.includes('session_token'))!.split(';')[0];
    await request(app).get('/api/v1/auth/me').set('Cookie', cookie).expect(200);

    // Recorded as verified, not left false forever: no mail can ever arrive on
    // this deployment, so an operator who later configures SMTP and turns
    // verification on must not find every existing account locked out.
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerified).toBe(true);
  });

  it('writes no email_log row at all, rather than a failed one', async () => {
    // A self-hoster can do nothing about a `failed` row, so the send is skipped
    // before it is recorded.
    process.env.EMAIL_TRANSPORT = 'none';
    const app = rebuildApp();
    const email = `none2-${randomUUID()}@example.com`;

    await request(app)
      .post('/api/v1/auth/sign-up/email')
      .send({ email, password: PASSWORD, name: 'No Mail' });

    expect(await prisma.emailLog.count()).toBe(0);
  });
});

describe('GET /auth/capabilities', () => {
  it('reports Google as unavailable when it is not configured', async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    const app = rebuildApp();

    const res = await request(app).get('/api/v1/auth/capabilities').expect(200);

    // The signup page renders no Google button on this answer. Before this
    // endpoint existed it rendered one unconditionally, so every install without
    // Google credentials offered a button that failed when pressed.
    expect(res.body.google).toBe(false);
  });

  it('reports Google as available once both credentials are present', async () => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
    const app = rebuildApp();

    const res = await request(app).get('/api/v1/auth/capabilities').expect(200);

    expect(res.body.google).toBe(true);
  });

  it('reports Google as unavailable when only half the pair is set', async () => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
    delete process.env.GOOGLE_CLIENT_SECRET;
    const app = rebuildApp();

    const res = await request(app).get('/api/v1/auth/capabilities').expect(200);

    expect(res.body.google).toBe(false);
  });

  it('mirrors the verification requirement, which follows the mail transport', async () => {
    process.env.EMAIL_TRANSPORT = 'none';
    delete process.env.AUTH_REQUIRE_EMAIL_VERIFICATION;
    const withoutMail = await request(rebuildApp())
      .get('/api/v1/auth/capabilities')
      .expect(200);
    expect(withoutMail.body.email_verification_required).toBe(false);

    process.env.EMAIL_TRANSPORT = 'memory';
    const withMail = await request(rebuildApp()).get('/api/v1/auth/capabilities').expect(200);
    expect(withMail.body.email_verification_required).toBe(true);
  });

  it('answers without a session, since it is read before anyone can sign in', async () => {
    // No Cookie header, and no Origin either: this is a plain GET a browser makes
    // on first paint of the login page.
    await request(rebuildApp()).get('/api/v1/auth/capabilities').expect(200);
  });
});

describe('password reset', () => {
  it('completes end to end: request, follow the link, sign in with the new password', async () => {
    const app = rebuildApp();
    const email = `reset-${randomUUID()}@example.com`;
    await request(app)
      .post('/api/v1/auth/sign-up/email')
      .send({ email, password: PASSWORD, name: 'Resetter' })
      .expect(200);

    // `mintResetLink` intercepts the same URL an email would have carried.
    const url = await mintResetLink(email);
    expect(url).toBeTruthy();

    const token = new URL(url!).pathname.split('/').pop()!;
    await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ newPassword: NEW_PASSWORD, token })
      .expect(200);

    await request(app)
      .post('/api/v1/auth/sign-in/email')
      .send({ email, password: NEW_PASSWORD })
      .expect(200);
    await request(app)
      .post('/api/v1/auth/sign-in/email')
      .send({ email, password: PASSWORD })
      .expect(401);
  });

  it('a captured link is not also emailed', async () => {
    // Otherwise the operator-escape path would mail a live credential to an
    // address that may be unreachable, which is the situation it exists to avoid.
    const app = rebuildApp();
    const email = `reset2-${randomUUID()}@example.com`;
    await request(app)
      .post('/api/v1/auth/sign-up/email')
      .send({ email, password: PASSWORD, name: 'Resetter' })
      .expect(200);

    await mintResetLink(email);
    expect(await prisma.emailLog.count({ where: { type: 'password_reset' } })).toBe(0);
  });

  it('the reset link is single-use', async () => {
    const app = rebuildApp();
    const email = `reset3-${randomUUID()}@example.com`;
    await request(app)
      .post('/api/v1/auth/sign-up/email')
      .send({ email, password: PASSWORD, name: 'Resetter' })
      .expect(200);

    const url = await mintResetLink(email);
    const token = new URL(url!).pathname.split('/').pop()!;
    await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ newPassword: NEW_PASSWORD, token })
      .expect(200);
    await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ newPassword: 'another-password-entirely', token })
      .expect(400);
  });

  it('returns null for an address with no account', async () => {
    const app = rebuildApp();
    expect(await mintResetLink(`ghost-${randomUUID()}@example.com`)).toBeNull();
  });

  it('answers identically whether or not the address exists', async () => {
    // Enumeration safety: the reply must not reveal which addresses are
    // registered. Supabase enforced this for us; now we do.
    const app = rebuildApp();
    const known = `known-${randomUUID()}@example.com`;
    await request(app)
      .post('/api/v1/auth/sign-up/email')
      .send({ email: known, password: PASSWORD, name: 'Known' })
      .expect(200);

    const a = await request(app)
      .post('/api/v1/auth/request-password-reset')
      .send({ email: known, redirectTo: '/reset-password' });
    const b = await request(app)
      .post('/api/v1/auth/request-password-reset')
      .send({ email: `ghost-${randomUUID()}@example.com`, redirectTo: '/reset-password' });

    expect(a.status).toBe(b.status);
    expect(a.body).toEqual(b.body);
  });
});

describe('login rate limiting', () => {
  it('throttles repeated sign-in attempts', async () => {
    // Supabase Auth gave us brute-force protection for free. The limiter is off
    // in tests (100 suites share one IP), so this case opts in explicitly rather
    // than trusting an unexercised code path.
    process.env.AUTH_RATE_LIMIT_IN_TEST = 'true';
    const app = rebuildApp();
    const email = `rl-${randomUUID()}@example.com`;
    await request(app)
      .post('/api/v1/auth/sign-up/email')
      .send({ email, password: PASSWORD, name: 'Limited' })
      .expect(200);

    let sawThrottle = false;
    for (let i = 0; i < 40; i++) {
      const res = await request(app)
        .post('/api/v1/auth/sign-in/email')
        .send({ email, password: 'wrong-password-entirely' });
      if (res.status === 429) {
        sawThrottle = true;
        break;
      }
    }
    expect(sawThrottle).toBe(true);
  }, 30_000);

  // Production puts two or three hops in front of the API (Cloudflare, a host
  // reverse proxy, the web container's nginx), and each appends to
  // X-Forwarded-For. Without trusted proxies configured, Better Auth reads a
  // chain that long as unresolvable and buckets *every* caller together — so
  // the built-in "3 sign-ins per 10 seconds" rule becomes a limit on the whole
  // deployment that any stranger can hold at the cap.
  it('gives each client its own bucket behind a multi-hop proxy chain', async () => {
    process.env.AUTH_RATE_LIMIT_IN_TEST = 'true';
    const app = rebuildApp();

    // Distinct public addresses per run, so a counter left in Redis by an
    // earlier run cannot decide this test.
    const octet = () => 1 + Math.floor(Math.random() * 250);
    const attacker = `203.0.113.${octet()}`;
    const bystander = `198.51.100.${octet()}`;
    const chain = (client: string) => `${client}, 172.18.0.4, 10.1.2.3`;

    const email = `rl-chain-${randomUUID()}@example.com`;
    await request(app)
      .post('/api/v1/auth/sign-up/email')
      .set('X-Forwarded-For', chain(attacker))
      .send({ email, password: PASSWORD, name: 'Chained' })
      .expect(200);

    let attackerThrottled = false;
    for (let i = 0; i < 40; i++) {
      const res = await request(app)
        .post('/api/v1/auth/sign-in/email')
        .set('X-Forwarded-For', chain(attacker))
        .send({ email, password: 'wrong-password-entirely' });
      if (res.status === 429) {
        attackerThrottled = true;
        break;
      }
    }
    expect(attackerThrottled).toBe(true);

    // The real user, one hop further out on the same proxies, is unaffected.
    const bystanderRes = await request(app)
      .post('/api/v1/auth/sign-in/email')
      .set('X-Forwarded-For', chain(bystander))
      .send({ email, password: PASSWORD });
    expect(bystanderRes.status).toBe(200);
  }, 30_000);

  it('records the client address on the session, not the proxy in front of it', async () => {
    const app = rebuildApp();
    const client = `203.0.113.${1 + Math.floor(Math.random() * 250)}`;
    const email = `ip-${randomUUID()}@example.com`;

    await request(app)
      .post('/api/v1/auth/sign-up/email')
      .set('X-Forwarded-For', `${client}, 172.18.0.4, 10.1.2.3`)
      .send({ email, password: PASSWORD, name: 'Forwarded' })
      .expect(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const session = await prisma.authSession.findFirstOrThrow({ where: { userId: user.id } });
    expect(session.ipAddress).toBe(client);
  });
});

describe('signup consent fields', () => {
  it('persists the real name and an explicit marketing opt-in', async () => {
    const app = rebuildApp();
    const email = `consent-${randomUUID()}@example.com`;

    await request(app)
      .post('/api/v1/auth/sign-up/email')
      .send({ email, password: PASSWORD, name: 'Ada Lovelace', marketingConsent: true });

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.displayName).toBe('Ada Lovelace');
    expect(user.marketingConsent).toBe(true);
  });

  it('defaults marketing consent to false when omitted', async () => {
    const app = rebuildApp();
    const email = `noconsent-${randomUUID()}@example.com`;

    await request(app)
      .post('/api/v1/auth/sign-up/email')
      .send({ email, password: PASSWORD, name: 'No Consent' });

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.marketingConsent).toBe(false);
  });

  it('stamps termsAcceptedAt on every new signup, close to now', async () => {
    const app = rebuildApp();
    const email = `terms-${randomUUID()}@example.com`;
    const before = Date.now();

    await request(app)
      .post('/api/v1/auth/sign-up/email')
      .send({ email, password: PASSWORD, name: 'Terms Agreed' });

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.termsAcceptedAt).not.toBeNull();
    expect(user.termsAcceptedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(user.termsAcceptedAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('rejects a client attempt to set termsAcceptedAt directly', async () => {
    const app = rebuildApp();
    const email = `spoof-${randomUUID()}@example.com`;
    const spoofed = new Date('2020-01-01').toISOString();

    // Attempting to send an `input: false` field is rejected (status 400)
    const res = await request(app)
      .post('/api/v1/auth/sign-up/email')
      .send({ email, password: PASSWORD, name: 'Spoofer', termsAcceptedAt: spoofed });

    expect(res.status).toBe(400);

    // Sign up without the spoofed field to verify the server-side behavior
    const goodRes = await request(app)
      .post('/api/v1/auth/sign-up/email')
      .send({ email, password: PASSWORD, name: 'Spoofer' });

    expect(goodRes.status).toBe(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    // The hook always overwrites with `new Date()` — a client-supplied value
    // for an `input: false` field is dropped before the hook even runs.
    expect(user.termsAcceptedAt!.getFullYear()).not.toBe(2020);
  });
});
