/**
 * Per-worker database and Redis isolation for a parallel Jest run.
 *
 * Every suite drives real Postgres and real Redis, and `resetAuthTables()`
 * truncates the whole tenancy root. Two workers sharing one database would
 * truncate each other's rows mid-test, and two workers sharing one Redis
 * database would drain each other's BullMQ queues. So each worker gets its own
 * copy of both.
 *
 * Worker 1 keeps the configured URLs unchanged. That makes the serial run
 * (`npm test`, which is `--runInBand` and therefore always worker 1) behave
 * exactly as it did before this file existed. Workers 2..N get:
 *
 *   - Postgres: the same server, database `<name>_w<N>`, cloned from the base
 *     test database by `jest-global-setup.ts` before any worker starts.
 *   - Redis: the same server, database index `<base> - (N - 1)`. Counting
 *     down rather than up keeps clear of 15 and 0, which local dev processes
 *     use (see the REDIS_URL note in CLAUDE.md).
 */

/** How far below the base index the Redis databases may reach. */
const MAX_REDIS_DB_INDEX = 15;

/**
 * Name of the Postgres database a given worker uses.
 *
 * @param baseName - The database name from `TEST_DATABASE_URL`.
 * @param workerId - Jest's 1-based `JEST_WORKER_ID`.
 * @returns `baseName` for worker 1, `<baseName>_w<N>` for every other worker.
 */
export function workerDatabaseName(baseName: string, workerId: number): string {
  return workerId <= 1 ? baseName : `${baseName}_w${workerId}`;
}

/**
 * Rewrites `TEST_DATABASE_URL` so it points at this worker's database.
 *
 * @param url - The base test database URL.
 * @param workerId - Jest's 1-based `JEST_WORKER_ID`.
 * @returns The URL with only the database path changed; credentials, host and
 *   query string are kept.
 */
export function workerDatabaseUrl(url: string, workerId: number): string {
  const parsed = new URL(url);
  const baseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  parsed.pathname = `/${workerDatabaseName(baseName, workerId)}`;
  return parsed.toString();
}

/**
 * Rewrites `REDIS_URL` so it points at this worker's Redis database index.
 *
 * @param url - The base Redis URL; a missing database path means index 0.
 * @param workerId - Jest's 1-based `JEST_WORKER_ID`.
 * @returns The URL with the database index lowered by `workerId - 1`.
 * @throws {Error} When the base index is too small for this many workers —
 *   wrapping round would hand two workers the same database, which is the
 *   exact collision this file exists to prevent.
 */
export function workerRedisUrl(url: string, workerId: number): string {
  if (workerId <= 1) return url;
  const parsed = new URL(url);
  const baseIndex = Number(parsed.pathname.replace(/^\//, '') || '0');
  const index = baseIndex - (workerId - 1);
  if (!Number.isInteger(index) || index < 0 || index > MAX_REDIS_DB_INDEX) {
    throw new Error(
      `REDIS_URL database ${baseIndex} leaves no free Redis database for Jest worker ${workerId}. ` +
        'Use a higher base index (13 is the convention) or fewer workers.',
    );
  }
  parsed.pathname = `/${index}`;
  return parsed.toString();
}

/**
 * A BullMQ key prefix unique to one test run.
 *
 * The parent Jest process's pid plus the start time, so two runs that start at
 * once still differ, and a pid the OS reuses later does not collide either.
 *
 * @returns A prefix such as `test-48213-1761811200000`; it holds no Redis glob
 *   characters, so `<prefix>:*` matches exactly this run's keys.
 */
export function testRunQueuePrefix(): string {
  return `test-${process.pid}-${Date.now()}`;
}

/**
 * Where `jest-global-setup.ts` leaves the prefix it generated for
 * `jest-global-teardown.ts`. Jest runs both hooks in the parent process and
 * shares `globalThis` between them, but not with the test workers.
 */
const RUN_QUEUE_PREFIX_GLOBAL = '__acruxTestRunQueuePrefix';

/**
 * Records that this run generated `prefix`, so the teardown may delete its keys.
 *
 * @param prefix - The prefix from {@link testRunQueuePrefix}.
 */
export function rememberRunQueuePrefix(prefix: string): void {
  (globalThis as Record<string, unknown>)[RUN_QUEUE_PREFIX_GLOBAL] = prefix;
}

/**
 * The prefix this run generated, if it generated one.
 *
 * A prefix the caller exported is never returned, whatever it looks like: two
 * processes (a local API, a worker and a Jest run, or two runs) may share one on
 * purpose, and deleting its keys would delete their live jobs.
 *
 * @returns The prefix recorded by {@link rememberRunQueuePrefix}, or `undefined`.
 */
export function ownedRunQueuePrefix(): string | undefined {
  const value = (globalThis as Record<string, unknown>)[RUN_QUEUE_PREFIX_GLOBAL];
  return typeof value === 'string' ? value : undefined;
}
