import { Client, escapeIdentifier } from 'pg';
import type { Config } from '@jest/types';
import { workerDatabaseName } from './worker-isolation';

/**
 * Jest `globalSetup`: clones the test database once per extra worker.
 *
 * A parallel run gives each worker its own database (see
 * `worker-isolation.ts`). Those databases must exist, with the current schema,
 * before the first suite connects. `CREATE DATABASE ... TEMPLATE` copies the
 * base test database file by file, which takes well under a second and needs
 * no migration run per copy — so the base database is the only one that
 * `prisma migrate deploy` ever touches, in CI and locally.
 *
 * Each copy is dropped and re-created on every run. A copy left over from an
 * older schema would otherwise make a worker test against stale tables.
 *
 * A serial run (`maxWorkers` 1, which `--runInBand` implies) does nothing here.
 *
 * @param globalConfig - Jest's resolved config; only `maxWorkers` is read.
 * @throws {Error} When `TEST_DATABASE_URL` is unset for a parallel run, or a
 *   copy cannot be created — for example because something is still connected
 *   to the base database, which Postgres refuses as a template.
 */
export default async function globalSetup(globalConfig: Config.GlobalConfig): Promise<void> {
  const workers = globalConfig.maxWorkers;
  if (workers <= 1) return;

  const baseUrl = process.env.TEST_DATABASE_URL;
  if (!baseUrl) {
    throw new Error('TEST_DATABASE_URL must be set for a parallel test run.');
  }

  const parsed = new URL(baseUrl);
  const baseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  // Connect to the maintenance database, never the template itself: Postgres
  // refuses to copy a database that has any open connection.
  parsed.pathname = '/postgres';

  const client = new Client({ connectionString: parsed.toString() });
  await client.connect();
  try {
    for (let workerId = 2; workerId <= workers; workerId++) {
      const name = escapeIdentifier(workerDatabaseName(baseName, workerId));
      await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await client.query(`CREATE DATABASE ${name} TEMPLATE ${escapeIdentifier(baseName)}`);
    }
  } finally {
    await client.end();
  }
}
