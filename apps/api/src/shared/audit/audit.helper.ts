import { PrismaClient, AuditEvent, Prisma } from '@prisma/client';

type AuditParams = {
  teamId: string;
  actorId: string;
  event: AuditEvent;
  promptId?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Writes one row to `audit_log`. Fire-and-forget: never throws.
 * If the insert fails (e.g. DB hiccup), the error is logged server-side
 * and the calling mutation is allowed to succeed — audit loss is preferable
 * to blocking a user write.
 *
 * @param prismaInstance - The Prisma client instance (or transaction client).
 * @param params - Event details: who, what team, which prompt (optional), extra metadata.
 */
export async function audit(
  prismaInstance: PrismaClient,
  params: AuditParams,
): Promise<void> {
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
