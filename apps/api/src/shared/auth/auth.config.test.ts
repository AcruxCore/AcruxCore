import { loadAuthConfig, resetAuthConfig } from './auth.config';
import { resetEmailConfig } from '../../email';

/**
 * Reads the config fresh under a given environment.
 *
 * Both configs memoize on first read, and the auth config derives
 * `requireEmailVerification` from the email one, so both caches must be dropped
 * or the assertion silently describes the previous environment.
 */
function loadUnder(env: Record<string, string | undefined>): ReturnType<typeof loadAuthConfig> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetAuthConfig();
  resetEmailConfig();
  try {
    return loadAuthConfig();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetAuthConfig();
    resetEmailConfig();
  }
}

describe('loadAuthConfig — email verification', () => {
  it('requires verification when a transport can send and nothing overrides it', () => {
    const config = loadUnder({
      AUTH_REQUIRE_EMAIL_VERIFICATION: undefined,
      EMAIL_TRANSPORT: 'memory',
    });
    expect(config.requireEmailVerification).toBe(true);
  });

  it('drops the requirement when no transport can send', () => {
    const config = loadUnder({
      AUTH_REQUIRE_EMAIL_VERIFICATION: undefined,
      EMAIL_TRANSPORT: 'none',
    });
    expect(config.requireEmailVerification).toBe(false);
  });

  it('honours an explicit false even though a transport could send', () => {
    const config = loadUnder({
      AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
      EMAIL_TRANSPORT: 'memory',
    });
    expect(config.requireEmailVerification).toBe(false);
  });

  it('honours an explicit true even though no transport can send', () => {
    const config = loadUnder({
      AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
      EMAIL_TRANSPORT: 'none',
    });
    expect(config.requireEmailVerification).toBe(true);
  });

  // `docker-compose.yml` interpolates every variable it lists, so a value absent
  // from the operator's `.env` arrives as the empty string rather than as unset.
  // Read as an explicit "not true", that would silently switch verification off
  // on a deployment whose operator never mentioned the variable at all.
  it('treats an empty value as unset, not as an explicit false', () => {
    const config = loadUnder({
      AUTH_REQUIRE_EMAIL_VERIFICATION: '',
      EMAIL_TRANSPORT: 'memory',
    });
    expect(config.requireEmailVerification).toBe(true);
  });

  it('treats an empty session TTL as unset and falls back to the default', () => {
    const config = loadUnder({ AUTH_SESSION_TTL_DAYS: '', EMAIL_TRANSPORT: 'memory' });
    expect(config.sessionTtlDays).toBe(7);
  });

  it('treats an empty first-run flag as unset and keeps the claim available', () => {
    const config = loadUnder({ AUTH_ALLOW_FIRST_RUN_CLAIM: '', EMAIL_TRANSPORT: 'memory' });
    expect(config.allowFirstRunClaim).toBe(true);
  });
});

describe('loadAuthConfig — client address resolution', () => {
  // With no trusted proxies Better Auth refuses to read a forwarded chain of
  // more than one hop, and every caller then shares a single rate-limit bucket.
  // A default that covers the private ranges is what keeps the shipped Compose
  // stack — nginx reaching the API over the Compose network — counting real
  // clients instead of counting nginx.
  it('trusts the private ranges by default so a proxied chain still resolves', () => {
    const config = loadUnder({ AUTH_TRUSTED_PROXIES: undefined, EMAIL_TRANSPORT: 'memory' });
    expect(config.trustedProxies).toContain('10.0.0.0/8');
    expect(config.trustedProxies).toContain('172.16.0.0/12');
    expect(config.trustedProxies).toContain('127.0.0.0/8');
  });

  it('checks cf-connecting-ip before x-forwarded-for by default', () => {
    const config = loadUnder({ AUTH_IP_HEADERS: undefined, EMAIL_TRANSPORT: 'memory' });
    expect(config.ipAddressHeaders).toEqual(['cf-connecting-ip', 'x-forwarded-for']);
  });

  it('replaces the defaults with an explicit list, tolerating spaces', () => {
    const config = loadUnder({
      AUTH_TRUSTED_PROXIES: '203.0.113.7, 198.51.100.0/24',
      AUTH_IP_HEADERS: 'x-real-ip',
      EMAIL_TRANSPORT: 'memory',
    });
    expect(config.trustedProxies).toEqual(['203.0.113.7', '198.51.100.0/24']);
    expect(config.ipAddressHeaders).toEqual(['x-real-ip']);
  });

  // Compose interpolates every variable it names, so one the operator left out
  // of `.env` arrives as the empty string. Read as an explicit empty list, that
  // would disable proxy trust on a deployment nobody asked to change.
  it('treats an empty value as unset rather than as "trust nothing"', () => {
    const config = loadUnder({
      AUTH_TRUSTED_PROXIES: '',
      AUTH_IP_HEADERS: '',
      EMAIL_TRANSPORT: 'memory',
    });
    expect(config.trustedProxies.length).toBeGreaterThan(0);
    expect(config.ipAddressHeaders).toEqual(['cf-connecting-ip', 'x-forwarded-for']);
  });
});

describe('loadAuthConfig — claim secret', () => {
  // A session cookie signed by the known development secret is still worthless
  // without a matching `auth_sessions` row. A first-run claim token is checked
  // against nothing but its own signature, so signing it with a constant anyone
  // can read from the source would let a stranger claim an unclaimed instance.
  it('never signs claim tokens with the development fallback secret', () => {
    const config = loadUnder({
      BETTER_AUTH_SECRET: undefined,
      NODE_ENV: 'development',
      EMAIL_TRANSPORT: 'memory',
    });
    expect(config.secret).toContain('dev-only-insecure');
    expect(config.claimSecret).not.toBe(config.secret);
    expect(config.claimSecret.length).toBeGreaterThanOrEqual(16);
  });

  it('uses the real secret for both once one is configured', () => {
    const config = loadUnder({
      BETTER_AUTH_SECRET: 'a-real-configured-secret-value',
      EMAIL_TRANSPORT: 'memory',
    });
    expect(config.claimSecret).toBe('a-real-configured-secret-value');
  });
});
