import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { isEmailDisabled, loadEmailConfig } from '../../email/email.config';

const Schema = z.object({
  secret: z.string().min(16),
  claimSecret: z.string().min(16),
  appUrl: z.string().url(),
  googleClientId: z.string().min(1).optional(),
  googleClientSecret: z.string().min(1).optional(),
  sessionTtlDays: z.coerce.number().int().positive().max(365),
  requireEmailVerification: z.boolean(),
  allowFirstRunClaim: z.boolean(),
  rateLimitEnabled: z.boolean(),
  trustedProxies: z.array(z.string().min(1)),
  ipAddressHeaders: z.array(z.string().min(1)).min(1),
});

/** Validated auth configuration for this process. */
export type AuthConfig = z.infer<typeof Schema>;

/**
 * Development-only signing secret, used when `BETTER_AUTH_SECRET` is unset
 * outside production.
 *
 * A fixed value (rather than a random per-process one) so `npm run dev`
 * restarts do not sign every developer out on every file save. This is safe in
 * a way a fixed *unsubscribe* secret would not be: a session cookie is
 * `<token>.<signature>`, and `getSession` still looks the token up in
 * `auth_sessions`. Knowing this constant therefore lets nobody mint a session
 * for an arbitrary user — it only forges the tamper seal on a token that must
 * already exist in the database. `assertAuthConfig()` makes production refuse
 * to boot without a real secret, so this value can never ship.
 *
 * The reasoning above holds *only* for tokens checked against a database row.
 * Anything self-authenticating must not be signed with it — see `claimSecret`.
 */
const DEV_ONLY_SECRET = 'dev-only-insecure-better-auth-secret-do-not-deploy';

/** Session lifetime when `AUTH_SESSION_TTL_DAYS` is unset — Better Auth's own default. */
const DEFAULT_SESSION_TTL_DAYS = 7;

/**
 * Reverse-proxy addresses whose `X-Forwarded-For` entries are ours, not a client's.
 *
 * Better Auth walks the forwarded chain right to left and returns the first hop
 * it does not recognise as a proxy. With none of these configured it instead
 * refuses to read any multi-value header — and every request then shares one
 * rate-limit bucket, which turns the built-in "3 sign-ins per 10 seconds" rule
 * into a limit on the whole deployment that any stranger can hold at the cap.
 *
 * The defaults are the loopback, RFC 1918, CGNAT and unique-local ranges,
 * because in every deployment shape we ship — Compose, a host reverse proxy, a
 * Kubernetes ingress — the hops in front of the API sit on a private network
 * while real clients never do. Set `AUTH_TRUSTED_PROXIES` to override when a
 * proxy has a public address of its own.
 */
const DEFAULT_TRUSTED_PROXIES = [
  '127.0.0.0/8',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  'fc00::/7',
];

/**
 * Headers consulted, in order, for the client address.
 *
 * `cf-connecting-ip` comes first because Cloudflare overwrites it on every
 * request with the single true client address, which sidesteps chain-walking
 * entirely; installs not behind Cloudflare simply never see the header and fall
 * through. Trusting it does assume the origin is only reachable *through* the
 * CDN — an operator who exposes the origin directly should close that at the
 * firewall (it also bypasses the WAF), or narrow this list via `AUTH_IP_HEADERS`.
 */
const DEFAULT_IP_HEADERS = ['cf-connecting-ip', 'x-forwarded-for'];

/**
 * Splits a comma-separated environment variable, tolerating spaces and a
 * trailing comma. An unset or blank value yields `null`, meaning "use the
 * default" — never an empty list, which would silently disable the feature on a
 * Compose deployment that interpolates every variable it names.
 */
function csvEnv(raw: string | undefined): string[] | null {
  const parts = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : null;
}

let cached: AuthConfig | null = null;

/**
 * Reads and validates the auth environment once per process.
 *
 * `requireEmailVerification` is **derived from the email transport** rather than
 * guessed: with `EMAIL_TRANSPORT=none` a verification email can never arrive, so
 * demanding verification would lock every self-hoster out of their own install.
 * An explicit `AUTH_REQUIRE_EMAIL_VERIFICATION` always wins, including the
 * deliberately odd combination of "no transport, but verification required"
 * (which someone verifying accounts by hand may actually want).
 *
 * @returns The memoized, validated config.
 * @throws {Error} When a value is missing or malformed — at boot, via
 *   {@link assertAuthConfig}, rather than as a broken login hours later.
 */
export function loadAuthConfig(): AuthConfig {
  if (cached) return cached;

  const isProduction = process.env.NODE_ENV === 'production';
  // `|| undefined` collapses an empty value into "unset". Compose interpolates
  // every variable it lists, so one the operator never mentioned arrives as the
  // empty string — read as an explicit "not true", that would switch
  // verification off on a deployment nobody asked to weaken.
  const explicitVerify = process.env.AUTH_REQUIRE_EMAIL_VERIFICATION || undefined;

  const parsed = Schema.safeParse({
    secret:
      process.env.BETTER_AUTH_SECRET || (isProduction ? '' : DEV_ONLY_SECRET),
    // Never the development fallback. A session cookie signed by a known secret
    // is still worthless without a matching `auth_sessions` row, but a first-run
    // claim token is checked against nothing but its own signature — anyone who
    // knows the constant could mint one and take ownership of an unclaimed
    // instance over the network. A per-process random value costs nothing here,
    // because a printed claim link is already documented as dying with the
    // process that printed it.
    claimSecret:
      process.env.BETTER_AUTH_SECRET || randomBytes(32).toString('base64url'),
    // Reuse the email layer's APP_URL so a link in an email and an OAuth
    // callback can never disagree about which host this install lives on.
    appUrl: loadEmailConfig().appUrl,
    googleClientId: process.env.GOOGLE_CLIENT_ID || undefined,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || undefined,
    sessionTtlDays: process.env.AUTH_SESSION_TTL_DAYS || DEFAULT_SESSION_TTL_DAYS,
    requireEmailVerification:
      explicitVerify !== undefined ? explicitVerify === 'true' : !isEmailDisabled(),
    allowFirstRunClaim: process.env.AUTH_ALLOW_FIRST_RUN_CLAIM !== 'false',
    // On everywhere except the test suite, which drives every request from
    // 127.0.0.1 and would throttle itself after ~20 signups — the limiter cannot
    // tell a hundred fixtures apart from one attacker. `AUTH_RATE_LIMIT_IN_TEST`
    // exists so the limiter is still proven by a test that opts in deliberately,
    // rather than being switched off and trusted.
    rateLimitEnabled:
      process.env.NODE_ENV !== 'test' || process.env.AUTH_RATE_LIMIT_IN_TEST === 'true',
    trustedProxies: csvEnv(process.env.AUTH_TRUSTED_PROXIES) ?? DEFAULT_TRUSTED_PROXIES,
    ipAddressHeaders: csvEnv(process.env.AUTH_IP_HEADERS) ?? DEFAULT_IP_HEADERS,
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `Invalid auth configuration (${issue.path.join('.') || 'root'}): ${issue.message}. ` +
        'BETTER_AUTH_SECRET is required in production — generate one with `openssl rand -base64 32`.',
    );
  }

  cached = parsed.data;
  return cached;
}

/**
 * True when both Google credentials are present.
 *
 * Both-or-neither, so a half-configured install shows no Google button instead
 * of one that fails at the provider.
 *
 * @returns Whether Google sign-in should be offered.
 */
export function isGoogleEnabled(): boolean {
  const c = loadAuthConfig();
  return !!c.googleClientId && !!c.googleClientSecret;
}

/**
 * Validates the auth environment at startup so a misconfiguration crashes the
 * process immediately, the same contract `assertEmailConfig()` has.
 *
 * @throws {Error} When the configuration is invalid.
 */
export function assertAuthConfig(): void {
  loadAuthConfig();
}

/**
 * Drops the memoized config so a test can change `process.env` and reload.
 * Never called by production code.
 */
export function resetAuthConfig(): void {
  cached = null;
}
