import IORedis from 'ioredis';

let redisConnection: IORedis | null = null;

/**
 * Get a memoized Redis connection for BullMQ queue operations.
 * Connects to the URL specified by REDIS_URL environment variable,
 * defaulting to localhost:6379 for local development.
 *
 * @returns A singleton IORedis instance with maxRetriesPerRequest set to null
 *          (required by BullMQ for blocking commands).
 */
export function getRedisConnection(): IORedis {
  if (!redisConnection) {
    const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
    const conn = new IORedis(redisUrl, {
      // BullMQ requires maxRetriesPerRequest: null for blocking commands
      maxRetriesPerRequest: null,
    });
    // Log the address actually dialled, not just the configured host name. A
    // host name can resolve to more than one container — on a Docker network
    // shared between stacks, two projects publishing the same service alias
    // make `redis` ambiguous, and the API and worker can silently end up on
    // different instances (jobs enqueued into a Redis nobody consumes: runs
    // stuck at `queued`, mail never sent, and no error on either side).
    // Printing the resolved peer in both processes turns that into a
    // one-glance comparison instead of an afternoon of guessing.
    conn.once('ready', () => {
      const { remoteAddress, remotePort } = conn.stream;
      console.log(`[queues] Redis connected: ${redactRedisUrl(redisUrl)} → ${remoteAddress}:${remotePort}`);
    });
    redisConnection = conn;
  }
  return redisConnection;
}

/** Strips any `user:password@` credentials so the URL is safe to log. */
function redactRedisUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    if (parsed.username) parsed.username = '***';
    return parsed.toString();
  } catch {
    // Not a parseable URL — never echo something we cannot redact.
    return '<unparseable REDIS_URL>';
  }
}

/**
 * Quits the shared connection if one was ever opened, and forgets it.
 *
 * Exists for test teardown. An open ioredis socket is a live handle, so a Jest
 * worker that touched *any* queue — including indirectly, via a `notify()` call
 * inside the operation under test — hangs after its assertions pass rather than
 * exiting. Doing nothing when no connection was created matters: opening one just
 * to close it would give every pure-logic suite a Redis dependency it does not
 * have.
 *
 * Idempotent and never throws: quitting an already-closed connection rejects with
 * `Connection is closed`, and several suites close it themselves before the global
 * teardown runs.
 */
export async function closeRedisConnection(): Promise<void> {
  if (!redisConnection) return;
  const conn = redisConnection;
  redisConnection = null;
  try {
    await conn.quit();
  } catch {
    // Already closed by a suite's own afterAll — nothing left to do.
  }
}
