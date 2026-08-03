import IORedis from 'ioredis';

/** What Better Auth stores per rate-limit key. */
interface RateLimitRecord {
  key: string;
  count: number;
  lastRequest: number;
}

/** Namespace so auth counters never collide with BullMQ's keys in a shared Redis. */
const PREFIX = 'auth:rl:';

/** How long a counter command may take before the request gives up on Redis. */
const COMMAND_TIMEOUT_MS = 1_000;

/**
 * Increment-and-expire in one round trip.
 *
 * `INCR` followed by a separate `EXPIRE` has a real failure mode: if the process
 * dies (or the connection drops) between the two, the key survives with no TTL
 * and that identity is rate-limited **forever**. Doing both inside one Lua script
 * makes the pair atomic, and setting the TTL only when the counter is fresh
 * (`== 1`) gives a fixed window rather than one a steady stream of requests can
 * push out indefinitely.
 */
const CONSUME_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return {count, ttl}
`;

let client: IORedis | null = null;

/**
 * The connection the auth counters use — deliberately **not** the shared BullMQ
 * one.
 *
 * BullMQ requires `maxRetriesPerRequest: null`, which tells ioredis to buffer
 * commands indefinitely while the connection is down. That is right for a job
 * queue and catastrophic here: the limiter runs in front of *every* auth
 * endpoint, so a Redis outage would leave every sign-in, sign-up and password
 * reset hanging with no timeout instead of failing. These settings do the
 * opposite — no offline buffering, a bounded retry, and a hard command timeout —
 * so a broken Redis surfaces as a fast error the caller below can absorb.
 */
function getClient(): IORedis {
  if (!client) {
    client = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: 1,
      commandTimeout: COMMAND_TIMEOUT_MS,
      enableOfflineQueue: false,
    });
    // ioredis emits `error` on every failed reconnect; with no listener Node
    // treats it as an unhandled error event and kills the process.
    client.on('error', (err) => {
      console.error('[auth] rate-limit Redis error:', err.message);
    });
  }
  return client;
}

/**
 * Closes the rate-limit connection if one was opened, and forgets it.
 *
 * Exists for test teardown, mirroring `closeRedisConnection()`: an open ioredis
 * socket is a live handle, so a Jest worker that exercised the limiter would
 * hang after its assertions pass. Doing nothing when no connection exists keeps
 * suites that never rate-limit free of a Redis dependency.
 */
export async function closeRateLimitRedis(): Promise<void> {
  if (!client) return;
  const conn = client;
  client = null;
  try {
    await conn.quit();
  } catch {
    // Already closed — nothing left to do.
  }
}

/**
 * Redis-backed rate-limit storage for Better Auth.
 *
 * Deliberately **not** wired through Better Auth's `secondaryStorage`, which
 * would also move sessions out of Postgres into Redis. Sessions must stay rows
 * in `auth_sessions` — that is what makes revoking one a row delete, and what
 * keeps a Redis flush from signing every user out. `rateLimit.customStorage`
 * scopes Redis to the counters alone.
 *
 * Every method fails **open**: a counter that cannot be read or written must not
 * take authentication down with it. Rate limiting is defence in depth against
 * password guessing, whereas an unreachable Redis that blocked logins would be a
 * complete outage — and one an attacker could cause. Each failure is logged so
 * the gap is visible rather than silent.
 */
export class RedisRateLimitStorage {
  /**
   * Atomically counts one request and reports whether it is permitted.
   *
   * Preferred over the `get`/`set` pair because it closes the concurrent-bypass
   * gap: N simultaneous logins can otherwise all read a stale count before any
   * increment lands, and all pass.
   *
   * @param key - Better Auth's per-identity, per-route key.
   * @param rule - `window` in seconds and the `max` requests allowed in it.
   * @returns Whether the request is allowed, plus seconds until the window frees
   *   up when it is not. Allows the request if Redis is unreachable.
   */
  async consume(
    key: string,
    rule: { window: number; max: number },
  ): Promise<{ allowed: boolean; retryAfter: number | null }> {
    let count: number;
    let ttl: number;
    try {
      [count, ttl] = (await getClient().eval(
        CONSUME_SCRIPT,
        1,
        `${PREFIX}${key}`,
        String(rule.window),
      )) as [number, number];
    } catch (err) {
      console.error(
        '[auth] rate limiting is not being enforced — Redis unavailable:',
        (err as Error).message,
      );
      return { allowed: true, retryAfter: null };
    }

    if (count > rule.max) {
      // A non-positive TTL means the key expired between INCR and TTL; fall back
      // to the full window rather than reporting a nonsensical retry time.
      return { allowed: false, retryAfter: ttl > 0 ? ttl : rule.window };
    }
    return { allowed: true, retryAfter: null };
  }

  /**
   * Reads a counter. Part of Better Auth's storage contract; the atomic
   * {@link consume} path is what actually enforces limits.
   *
   * @param key - Better Auth's rate-limit key.
   * @returns The stored record, or null when the window has expired or Redis is
   *   unreachable.
   */
  async get(key: string): Promise<RateLimitRecord | null> {
    let raw: string | null;
    try {
      raw = await getClient().get(`${PREFIX}${key}`);
    } catch (err) {
      console.error(
        '[auth] rate-limit counter could not be read — Redis unavailable:',
        (err as Error).message,
      );
      return null;
    }
    if (raw === null) return null;
    // `consume` stores a bare integer; the legacy path stores JSON. Tolerate both
    // so switching paths mid-window cannot throw.
    const count = Number(raw);
    if (Number.isFinite(count)) return { key, count, lastRequest: Date.now() };
    try {
      return JSON.parse(raw) as RateLimitRecord;
    } catch {
      return null;
    }
  }

  /**
   * Writes a counter, preserving any TTL already on the key.
   *
   * @param key - Better Auth's rate-limit key.
   * @param value - The record to store. Dropped if Redis is unreachable.
   */
  async set(key: string, value: RateLimitRecord): Promise<void> {
    try {
      await getClient().set(`${PREFIX}${key}`, JSON.stringify(value), 'KEEPTTL');
    } catch (err) {
      // Fail open, in step with `consume` — but say so, or the dropped counter is
      // invisible.
      console.error(
        '[auth] rate-limit counter could not be written — Redis unavailable:',
        (err as Error).message,
      );
    }
  }
}
