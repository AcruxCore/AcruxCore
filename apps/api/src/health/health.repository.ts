import prisma from '../shared/db/client';

/**
 * Read-only checks against the database used by the health endpoint.
 * Kept separate from other domain repositories since it belongs to no
 * business entity — it only proves the connection is alive.
 */
export class HealthRepository {
  /**
   * Runs a trivial query against Postgres to confirm the connection pool can
   * reach the database.
   *
   * @throws Whatever error Prisma raises if the database is unreachable.
   */
  async pingDatabase(): Promise<void> {
    await prisma.$queryRaw`SELECT 1`;
  }
}
