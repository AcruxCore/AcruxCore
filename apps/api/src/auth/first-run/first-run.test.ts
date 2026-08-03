import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Application } from 'express';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { resetAuthTables } from '../../test-utils';
import { resetAuth, resetAuthConfig } from '../../shared/auth';
import { resetEmailConfig, resetTransport } from '../../email';
import { CLAIM_TTL_MS, mintClaimToken, verifyClaimToken } from './first-run.token';

const app = createApp();
const CLAIM_PATH = '/api/v1/auth/first-run/claim';
const PASSWORD = 'first-run-password-not-real';

/**
 * Empties every table a user row depends on, so the instance looks unclaimed.
 * `users` cascades to auth_sessions/auth_accounts.
 */
async function emptyInstance(): Promise<void> {
  await resetAuthTables();
}

/**
 * Rebuilds the app with the current environment.
 *
 * The auth and email configs memoize on first read, and `createApp` captures the
 * Better Auth instance when it mounts the handler, so a test that changes an env
 * var must drop all four caches or it silently asserts against the previous
 * configuration.
 */
function rebuildApp(): Application {
  resetAuthConfig();
  resetEmailConfig();
  resetTransport();
  resetAuth();
  return createApp();
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(emptyInstance);

afterEach(() => {
  // Restore the environment *and* drop the caches, so a test that rebuilt the
  // app cannot leave the next one reading a configuration it never set.
  process.env = { ...ORIGINAL_ENV };
  resetAuthConfig();
  resetEmailConfig();
  resetTransport();
  resetAuth();
});

afterAll(emptyInstance);

describe('first-run claim token', () => {
  it('verifies a freshly minted token', () => {
    expect(verifyClaimToken(mintClaimToken())).toBe(true);
  });

  it('rejects a token past its expiry', () => {
    const now = 1_800_000_000_000;
    const token = mintClaimToken(now);
    expect(verifyClaimToken(token, now + CLAIM_TTL_MS - 1)).toBe(true);
    expect(verifyClaimToken(token, now + CLAIM_TTL_MS + 1)).toBe(false);
  });

  it('rejects a tampered expiry', () => {
    // The expiry is inside the signed message, so pushing it out invalidates it —
    // otherwise the payload would be a suggestion rather than a claim.
    const token = mintClaimToken();
    const [, sig] = token.split('.');
    const forged = `${Buffer.from(String(Date.now() + 10 * CLAIM_TTL_MS)).toString('base64url')}.${sig}`;
    expect(verifyClaimToken(forged)).toBe(false);
  });

  it('rejects malformed tokens without throwing', () => {
    // timingSafeEqual throws on length mismatch, which would surface as a 500.
    for (const bad of ['', 'nodot', 'a.b.c', '.', 'x.', '.y', 'short.sig']) {
      expect(verifyClaimToken(bad)).toBe(false);
    }
  });
});

describe('POST /api/v1/auth/first-run/claim', () => {
  it('creates the first owner, verified, and signs them in', async () => {
    const email = `owner-${randomUUID()}@example.com`;
    const res = await request(app)
      .post(CLAIM_PATH)
      .send({ token: mintClaimToken(), email, password: PASSWORD, name: 'First Owner' })
      .expect(201);

    // Signed in straight away: the owner lands in the app, not on a login form.
    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((c) => c.includes('session_token'))).toBe(true);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.id).toBe(res.body.user_id);
    // Verified without an email round-trip — this path exists for installs that
    // cannot send mail, and requiring verification would lock the owner out.
    expect(user.emailVerified).toBe(true);
    expect(user.displayName).toBe('First Owner');

    const member = await prisma.teamMember.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(member.role).toBe('owner');
  });

  it('the created account can sign in with the chosen password', async () => {
    const email = `owner-${randomUUID()}@example.com`;
    await request(app)
      .post(CLAIM_PATH)
      .send({ token: mintClaimToken(), email, password: PASSWORD })
      .expect(201);

    // Proves the password went through Better Auth's hasher, not a direct insert.
    await request(app)
      .post('/api/v1/auth/sign-in/email')
      .send({ email, password: PASSWORD })
      .expect(200);
  });

  it('refuses a second claim once the instance has an account', async () => {
    // This is what makes the printed token single-use: nothing is stored, and a
    // successful claim destroys the condition the token depends on.
    await request(app)
      .post(CLAIM_PATH)
      .send({ token: mintClaimToken(), email: `a-${randomUUID()}@example.com`, password: PASSWORD })
      .expect(201);

    await request(app)
      .post(CLAIM_PATH)
      .send({ token: mintClaimToken(), email: `b-${randomUUID()}@example.com`, password: PASSWORD })
      .expect(403);

    expect(await prisma.user.count()).toBe(1);
  });

  it('serializes concurrent claims so only one account is created', async () => {
    const [first, second] = await Promise.all([
      request(app)
        .post(CLAIM_PATH)
        .send({ token: mintClaimToken(), email: `c1-${randomUUID()}@example.com`, password: PASSWORD }),
      request(app)
        .post(CLAIM_PATH)
        .send({ token: mintClaimToken(), email: `c2-${randomUUID()}@example.com`, password: PASSWORD }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 403]);
    expect(await prisma.user.count()).toBe(1);
  });

  it('records the claiming browser as the first device, not a phantom one', async () => {
    const email = `owner-${randomUUID()}@example.com`;
    const UA = 'ClaimingBrowser/1.0';

    await request(app)
      .post(CLAIM_PATH)
      .set('User-Agent', UA)
      .send({ token: mintClaimToken(), email, password: PASSWORD, name: 'Owner' })
      .expect(201);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const session = await prisma.authSession.findFirstOrThrow({ where: { userId: user.id } });
    expect(session.userAgent).toBe(UA);

    // The claim runs server-side but on the claimer's behalf. Without their
    // headers the session would record null, `known_devices` would hold a device
    // nobody used, and this next sign-in — the same browser — would look new and
    // fire an unrecognised-device alert.
    await request(app)
      .post('/api/v1/auth/sign-in/email')
      .set('User-Agent', UA)
      .send({ email, password: PASSWORD })
      .expect(200);

    expect(await prisma.knownDevice.count({ where: { userId: user.id } })).toBe(1);
    expect(
      await prisma.emailLog.count({ where: { toEmail: email, type: 'new_sign_in' } }),
    ).toBe(0);
  });

  it('rejects an invalid token with 403 and creates nothing', async () => {
    await request(app)
      .post(CLAIM_PATH)
      .send({ token: 'not-a-token', email: `x-${randomUUID()}@example.com`, password: PASSWORD })
      .expect(403);
    expect(await prisma.user.count()).toBe(0);
  });

  it('accepts a mixed-case email and stores it the way every later lookup reads it', async () => {
    // Better Auth lowercases the address on sign-up. Anything that then looked
    // the row up by the string the owner typed would miss it — and by that point
    // the account exists, so the instance is claimed and the token is spent: the
    // owner is left with a 500 and a link that will never work again.
    const typed = `Owner-${randomUUID().toUpperCase()}@Example.COM`;
    const res = await request(app)
      .post(CLAIM_PATH)
      .send({ token: mintClaimToken(), email: typed, password: PASSWORD, name: 'Owner' })
      .expect(201);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: typed.toLowerCase() } });
    expect(user.id).toBe(res.body.user_id);
    expect(user.emailVerified).toBe(true);

    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((c) => c.includes('session_token'))).toBe(true);

    // The same address, however it is typed, signs in.
    await request(app)
      .post('/api/v1/auth/sign-in/email')
      .send({ email: typed, password: PASSWORD })
      .expect(200);
  });

  it('still signs the owner in on an install that requires email verification', async () => {
    // Better Auth withholds the session whenever verification is required, which
    // would hand the claim page a 201 carrying no cookie and bounce the owner
    // straight back to a login form on the instance they just set up. Nor should
    // a confirmation email go out: the claim token already proved access to the
    // server's own log, and the account is created verified.
    process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = 'true';
    process.env.EMAIL_TRANSPORT = 'memory';
    const verifyingApp = rebuildApp();

    const email = `owner-${randomUUID()}@example.com`;
    const res = await request(verifyingApp)
      .post(CLAIM_PATH)
      .send({ token: mintClaimToken(), email, password: PASSWORD, name: 'Owner' })
      .expect(201);

    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((c) => c.includes('session_token'))).toBe(true);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerified).toBe(true);
    expect(
      await prisma.emailLog.count({ where: { toEmail: email, type: 'verify_email' } }),
    ).toBe(0);
  });

  it('rejects a short password with 400 before touching the token', async () => {
    await request(app)
      .post(CLAIM_PATH)
      .send({ token: mintClaimToken(), email: `x-${randomUUID()}@example.com`, password: 'short' })
      .expect(400);
    expect(await prisma.user.count()).toBe(0);
  });
});
