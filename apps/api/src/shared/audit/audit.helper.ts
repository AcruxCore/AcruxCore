import { PrismaClient, AuditEvent, Prisma } from '@prisma/client';

type AuditParams = {
  teamId: string;
  actorId: string;
  event: AuditEvent;
  promptId?: string;
  metadata?: Record<string, unknown>;
};

// Writes still in flight. Callers fire `audit()` without awaiting it, so this is
// the only handle left on a write once the request that started it has returned.
const pendingWrites = new Set<Promise<void>>();

/**
 * Writes one row to `audit_log`. Fire-and-forget: never throws.
 * If the insert fails (e.g. DB hiccup), the error is logged server-side
 * and the calling mutation is allowed to succeed — audit loss is preferable
 * to blocking a user write.
 *
 * @param prismaInstance - The Prisma client instance (or transaction client).
 * @param params - Event details: who, what team, which prompt (optional), extra metadata.
 */
export function audit(
  prismaInstance: PrismaClient,
  params: AuditParams,
): Promise<void> {
  const write = writeAuditRow(prismaInstance, params);
  pendingWrites.add(write);
  void write.finally(() => pendingWrites.delete(write));
  return write;
}

/**
 * Resolves once every audit write started so far has finished, including any
 * started while waiting.
 *
 * Exists for the test suite: a mutation's response can return before its audit
 * row lands, and a test's `TRUNCATE … CASCADE` racing that insert deadlocks in
 * Postgres (the insert locks `audit_log` then `teams`; the truncate takes them in
 * the opposite order). The global `afterEach` in `jest-teardown.ts` awaits this.
 *
 * @returns A promise that never rejects, since `audit()` itself never throws.
 */
export async function settleAuditWrites(): Promise<void> {
  while (pendingWrites.size > 0) await Promise.all([...pendingWrites]);
}

async function writeAuditRow(prismaInstance: PrismaClient, params: AuditParams): Promise<void> {
  try {
    await prismaInstance.auditLog.create({
      data: {
        teamId: params.teamId,
        actorId: params.actorId,
        event: params.event,
        promptId: params.promptId ?? null,
        metadata: params.metadata as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (err) {
    console.error('[audit] Failed to write audit event:', params.event, err);
  }
}
