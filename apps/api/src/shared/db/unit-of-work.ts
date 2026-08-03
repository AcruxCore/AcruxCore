import type { Prisma } from '@prisma/client';
import prisma from './client';

/**
 * Runs `fn` inside a single Prisma transaction, without requiring a service
 * that coordinates multiple repositories to import the shared `prisma` client
 * directly (CLAUDE.md: "services must never import prisma directly — only
 * repositories do"). Repository methods already accept an optional `tx`
 * parameter for exactly this purpose; pass the callback's `tx` through to them.
 *
 * @param fn - Callback receiving the transaction client.
 * @returns Whatever `fn` returns.
 */
export function runInTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn);
}
