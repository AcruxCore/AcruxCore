import type { Application } from 'express';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import prisma from '../shared/db/client';

/**
 * Auth context for a test user.
 *
 * Carries the raw session `cookie`; call sites read it only through
 * {@link authHeaders}, which is what let the entire suite move from Bearer JWTs
 * to cookie sessions without touching a single assertion. Keep that seam intact:
 * a test that builds its own auth header hard-codes a mechanism that has now
 * changed twice.
 */
export interface TestAuthContext {
  /** `<name>=<value>` pair, ready for a `Cookie` header. */
  cookie: string;
  userId: string;
  teamId: string;
  email: string;
}

/** Password used for every test account. Never leaves the test process. */
const TEST_PASSWORD = 'test-password-not-a-real-one-1234';

/** Better Auth's sign-up endpoint, under our versioned prefix. */
const SIGN_UP_PATH = '/api/v1/auth/sign-up/email';

/**
 * Globally-unique test email. Uses a UUID rather than a per-file counter so
 * emails never collide across test files (each file gets a fresh module
 * registry, which would reset a counter and clash on the `email` unique index).
 *
 * @returns A fresh `test-user-<uuid>@example.com` address.
 */
export function uniqueTestEmail(): string {
  return `test-user-${randomUUID()}@example.com`;
}

/**
 * Header map to authorize a supertest request for the given context.
 *
 * @param ctx - A context from {@link signupTestUser} et al.
 * @returns A `Cookie` header carrying the session.
 */
export function authHeaders(ctx: TestAuthContext): Record<string, string> {
  return { Cookie: ctx.cookie };
}

/**
 * Extracts the session cookie from a `set-cookie` response header.
 *
 * Only the `name=value` pair is kept: the attributes (`HttpOnly`, `SameSite`,
 * `Path`) are instructions to a browser and are not valid in a request's
 * `Cookie` header.
 *
 * @param res - A supertest response from a Better Auth endpoint.
 * @returns The cookie pair.
 * @throws {Error} If the response set no cookie — which means the request did not
 *   actually authenticate, and failing here beats a confusing 401 later.
 */
function sessionCookie(res: request.Response): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const session = list.find((c) => c.includes('session_token'));
  if (!session) {
    throw new Error(
      `No session cookie in response (status ${res.status}): ${JSON.stringify(res.body)}`,
    );
  }
  return session.split(';')[0];
}

/**
 * Creates a real user through Better Auth's own sign-up endpoint, then reads
 * `GET /auth/me` to obtain the ids.
 *
 * Genuinely exercises the real signup path — password hashing, the
 * `user.create.after` hook that provisions the personal team, session issuance —
 * rather than inserting rows directly. A fixture that wrote its own `users` row
 * would pass while real signup was broken.
 *
 * @param app - The Express app under test.
 * @param opts - Optional `email` override. (`sub` and `password` are accepted and
 *   ignored, for compatibility with call sites written against the Supabase
 *   helper.)
 * @returns A {@link TestAuthContext} carrying the session cookie and new ids.
 * @throws {Error} If signup does not return a session.
 */
export async function signupTestUser(
  app: Application,
  opts: { email?: string; sub?: string; password?: string } = {},
): Promise<TestAuthContext> {
  const email = opts.email ?? uniqueTestEmail();
  const res = await request(app)
    .post(SIGN_UP_PATH)
    .send({ email, password: TEST_PASSWORD, name: 'Test User' })
    .expect(200);

  const cookie = sessionCookie(res);
  const me = await request(app).get('/api/v1/auth/me').set('Cookie', cookie).expect(200);
  return { cookie, userId: me.body.user.id, teamId: me.body.team.id, email };
}

/**
 * Like {@link signupTestUser} but also mints a personal API key for the user.
 *
 * @param app - The Express app under test.
 * @param opts - Optional `email` override.
 * @returns The context plus the raw `apiKey` string (shown once).
 */
export async function signupTestUserWithApiKey(
  app: Application,
  opts: { email?: string; sub?: string; password?: string } = {},
): Promise<TestAuthContext & { apiKey: string }> {
  const ctx = await signupTestUser(app, opts);
  const keyRes = await request(app)
    .post('/api/v1/api-keys')
    .set(authHeaders(ctx))
    .send({ name: 'test key' })
    .expect(201);
  return { ...ctx, apiKey: keyRes.body.key };
}

/**
 * A pre-authenticated supertest agent plus the created user's ids. The agent
 * carries the session cookie as a default header, so call sites use
 * `agent.post(...)` without setting auth per request.
 */
export interface AuthedAgent {
  agent: ReturnType<typeof request.agent>;
  userId: string;
  teamId: string;
  email: string;
}

/**
 * Creates a real user and returns a pre-authenticated agent.
 *
 * The cookie is set as an explicit default header rather than relying on the
 * agent's own cookie jar: the jar only retains cookies from requests made
 * *through that agent*, and signup happens before the agent exists.
 *
 * @param app - The Express app under test.
 * @param opts - Optional `email` override.
 * @returns An {@link AuthedAgent} whose `agent` is already authenticated.
 */
export async function authedAgent(
  app: Application,
  opts: { email?: string; sub?: string; password?: string } = {},
): Promise<AuthedAgent> {
  const ctx = await signupTestUser(app, opts);
  const agent = request.agent(app);
  agent.set('Cookie', ctx.cookie);
  return { agent, userId: ctx.userId, teamId: ctx.teamId, email: ctx.email };
}

/**
 * Signs in an existing account, for tests that need a second session for the
 * same user (session revocation, "signed in elsewhere" behaviour).
 *
 * @param app - The Express app under test.
 * @param email - The account's address.
 * @returns The new session's cookie pair.
 * @throws {Error} If the credentials are rejected.
 */
export async function signInTestUser(app: Application, email: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/auth/sign-in/email')
    .send({ email, password: TEST_PASSWORD })
    .expect(200);
  return sessionCookie(res);
}

/**
 * Signs up a second user and adds them to an existing team with a given role.
 * The returned context's active team is `teamId`.
 *
 * @param app - The Express app under test.
 * @param teamId - The team to add the new user to.
 * @param role - Role to grant in that team.
 * @returns A context whose active team is `teamId`.
 */
export async function addUserToTeam(
  app: Application,
  teamId: string,
  role: 'owner' | 'admin' | 'editor' | 'viewer',
): Promise<TestAuthContext> {
  const ctx = await signupTestUser(app);
  await prisma.teamMember.create({
    data: { userId: ctx.userId, teamId, role },
  });
  // Make the target team the active/default team for this context.
  await request(app)
    .post('/api/v1/auth/switch-team')
    .set(authHeaders(ctx))
    .send({ teamId })
    .expect(200);
  return { ...ctx, teamId };
}

/** The shared password, for tests that must sign in by hand. */
export { TEST_PASSWORD };
