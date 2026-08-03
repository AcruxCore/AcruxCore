import prisma from '../shared/db/client';
import type { EmailLogRow, EmailType } from './email.types';

/** Longest `error` string persisted on an `email_log` row. */
const MAX_ERROR_LENGTH = 1000;

/**
 * All database access for the `email_log` table.
 *
 * Deliberately has no method that writes a rendered body — there is no column
 * for one. See the model's own comment in `schema.prisma`.
 */
export class EmailRepository {
  /**
   * Records a queued send attempt.
   *
   * @param input - Team the email belongs to, its type, recipient, and the
   *   already-rendered subject line.
   * @returns The new row's id, which travels on the queue job so the worker can
   *   settle this exact attempt.
   */
  async create(input: {
    teamId: string;
    type: EmailType;
    toEmail: string;
    subject: string;
  }): Promise<{ id: string }> {
    const row = await prisma.emailLog.create({
      data: { ...input, status: 'queued' },
      select: { id: true },
    });
    return row;
  }

  /**
   * Marks an attempt delivered.
   *
   * `updateMany` rather than `update` so a row that no longer exists is a no-op
   * instead of a P2025 throw. A queue job outlives the row it points at more
   * easily than it looks: Redis and Postgres are settled separately, so a
   * restored database snapshot, a truncated test database sharing the dev Redis,
   * or a manually replayed job all produce a job whose `email_log` id is gone.
   * Throwing here would be actively harmful — the message has already been
   * accepted by the transport, and the throw propagates into BullMQ's retry,
   * which sends it **again**.
   *
   * @param id - `email_log` row id.
   * @param providerMessageId - SES's message id, for correlating with SES logs.
   * @returns Whether a row was actually settled. False means the row is gone;
   *   the caller decides how loudly to say so.
   */
  async markSent(id: string, providerMessageId: string): Promise<boolean> {
    const { count } = await prisma.emailLog.updateMany({
      where: { id },
      data: { status: 'sent', providerMessageId, sentAt: new Date(), error: null },
    });
    return count > 0;
  }

  /**
   * Marks an attempt failed. A later retry that succeeds overwrites this row
   * via {@link markSent}, so a `failed` row means "the most recent attempt
   * failed", not "this email will never arrive".
   *
   * A vanished row is a no-op here for the same reason as in {@link markSent},
   * with one extra edge: this runs inside the failure handler, so a throw
   * produced a full Prisma stack trace for *every* retry of a stale job — five
   * of them per job, each describing the missing row rather than the transport
   * error that actually caused the failure.
   *
   * @param id - `email_log` row id.
   * @param error - Failure reason; truncated to 1000 chars so a giant AWS
   *   stack trace cannot bloat the table.
   * @returns Whether a row was actually settled.
   */
  async markFailed(id: string, error: string): Promise<boolean> {
    const { count } = await prisma.emailLog.updateMany({
      where: { id },
      data: { status: 'failed', error: error.slice(0, MAX_ERROR_LENGTH) },
    });
    return count > 0;
  }

  /**
   * Counts send attempts of one type for a team inside a trailing window.
   * Backs the invite abuse cap; uses `idx_email_log_team_type_time`.
   *
   * @param teamId - Team context.
   * @param type - Email type to count.
   * @param windowMs - How far back to look, in milliseconds.
   * @returns The number of matching rows.
   */
  async countRecent(teamId: string, type: EmailType, windowMs: number): Promise<number> {
    return prisma.emailLog.count({
      where: { teamId, type, createdAt: { gte: new Date(Date.now() - windowMs) } },
    });
  }

  /**
   * Reads one row back, for tests and future admin surfaces.
   *
   * @param id - `email_log` row id.
   * @returns The row, or null when it does not exist.
   */
  async findById(id: string): Promise<EmailLogRow | null> {
    return prisma.emailLog.findUnique({ where: { id } });
  }

  /**
   * Deletes one `email_log` row outright.
   *
   * Exists for exactly one caller: `EmailService.enqueue()`'s dedupe-race
   * cleanup, when this attempt lost a concurrent `queue.add()` race for the
   * same `jobId` and must remove the `queued` row it just wrote (no job will
   * ever reference it, so it would otherwise sit `queued` forever). This is
   * NOT a general-purpose delete — nothing else in this domain should call it.
   *
   * @param id - `email_log` row id.
   */
  async deleteById(id: string): Promise<void> {
    await prisma.emailLog.delete({ where: { id } });
  }
}
