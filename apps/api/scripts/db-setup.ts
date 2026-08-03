import '../src/shared/env/load-root-env';
import { execSync } from 'node:child_process';
import { Client } from 'pg';

/**
 * Idempotent first-time database bootstrap.
 *
 * Creates the application database (if it does not already exist) and then
 * applies all Prisma migrations via `prisma migrate deploy`. Assumes a running
 * PostgreSQL server — e.g. the Docker `postgres:18-alpine` container described
 * in the README. It does NOT start Postgres for you.
 *
 * Phase 1 uses a single database; there is no separate test database.
 *
 * Environment variables:
 *   PG_ROOT_URL  — connection string to an existing maintenance database, used
 *                  only to issue `CREATE DATABASE`. Defaults to
 *                  `postgres://postgres:postgres@localhost:5432/postgres`.
 *   DATABASE_URL — connection string for the application database to create and
 *                  migrate (required; see `.env.example`).
 *
 * Run with: `npm run db:setup`
 */

const PG_ROOT_URL =
  process.env.PG_ROOT_URL ??
  'postgres://postgres:postgres@localhost:5432/postgres';

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * Extracts the database name from a PostgreSQL connection URL.
 *
 * @param url - A `postgres://…/<dbname>` connection string.
 * @returns The database name (the URL path without its leading slash).
 * @throws {Error} When the URL contains no database name.
 */
function dbNameFromUrl(url: string): string {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name) {
    throw new Error(`No database name found in connection URL: ${url}`);
  }
  return name;
}

/** Masks the password in a connection URL so it is safe to log. */
function maskUrl(url: string): string {
  return url.replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]*(@)/, '$1****$2');
}

/**
 * Creates the database if it does not already exist.
 *
 * Connects to the maintenance database at `rootUrl` because `CREATE DATABASE`
 * cannot run inside the target database itself.
 *
 * @param rootUrl - Connection string to a maintenance DB (e.g. `postgres`).
 * @param dbName - Name of the application database to create.
 * @returns `true` if the database was created, `false` if it already existed.
 * @throws {Error} When the maintenance connection or the CREATE statement fails.
 */
async function ensureDatabase(rootUrl: string, dbName: string): Promise<boolean> {
  const client = new Client({ connectionString: rootUrl });
  await client.connect();
  try {
    const { rowCount } = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [dbName],
    );
    if (rowCount && rowCount > 0) {
      console.log(`Database "${dbName}" already exists — skipping create.`);
      return false;
    }
    // A database name cannot be a bound parameter; quote-escape the identifier.
    const quoted = `"${dbName.replace(/"/g, '""')}"`;
    await client.query(`CREATE DATABASE ${quoted}`);
    console.log(`Created database "${dbName}".`);
    return true;
  } finally {
    await client.end();
  }
}

/** True if a connection URL points at a Supabase-hosted database. */
function isSupabaseUrl(url: string): boolean {
  return /supabase\.(co|com)/i.test(url);
}

/**
 * Entry point.
 *
 * - **Supabase:** the database is pre-provisioned and the role cannot
 *   `CREATE DATABASE`, so we skip creation and apply migrations against
 *   `DIRECT_URL` (the non-pooled :5432 connection Prisma Migrate requires).
 * - **Local Postgres:** create the app database (if missing) via `PG_ROOT_URL`,
 *   then apply migrations against `DATABASE_URL`.
 */
async function main(): Promise<void> {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL must be set (see .env.example).');
  }

  if (isSupabaseUrl(DATABASE_URL)) {
    const migrateUrl = process.env.DIRECT_URL ?? DATABASE_URL;
    console.log(
      `Supabase target detected — applying migrations to the pre-provisioned ` +
        `database via ${maskUrl(migrateUrl)} (no CREATE DATABASE).`,
    );
    execSync('npx prisma migrate deploy', {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: migrateUrl },
    });
    console.log('✓ Database setup complete (Supabase).');
    return;
  }

  const dbName = dbNameFromUrl(DATABASE_URL);
  console.log(
    `Bootstrapping local database "${dbName}" using root ${maskUrl(PG_ROOT_URL)}`,
  );
  await ensureDatabase(PG_ROOT_URL, dbName);

  console.log('Applying migrations (prisma migrate deploy)…');
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL },
  });

  console.log('✓ Database setup complete.');
}

main().catch((err: unknown) => {
  console.error('db-setup failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
