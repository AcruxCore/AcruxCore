import { PrismaClient } from '@prisma/client';

const connectionString =
  process.env.NODE_ENV === 'test'
    ? process.env.TEST_DATABASE_URL
    : process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    'DATABASE_URL (or TEST_DATABASE_URL in test env) must be set.',
  );
}

/**
 * The single Prisma Client instance for this process.
 * Import this in repository files only.
 * Never create a new PrismaClient inside a service or route handler.
 */
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: connectionString,
    },
  },
});

export default prisma;
