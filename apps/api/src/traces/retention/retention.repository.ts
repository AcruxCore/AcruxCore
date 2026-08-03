import prisma from '../../shared/db/client';

/**
 * Data access for purging expired `span_payloads` rows (Finding #7). Global
 * (not per-team) — the retention window is an operator-set default, not a
 * per-tenant preference, so this deletes across every team in one pass.
 */
export class RetentionRepository {
  /**
   * Deletes every `span_payloads` row whose `created_at` is strictly before
   * `cutoff`. Only the payload row is removed — the owning `spans`/`traces`
   * rows (metadata, no message content) are untouched, so trace history and
   * analytics stay intact after a purge; only the raw input/output content
   * ages out.
   *
   * @param cutoff - Rows created before this instant are deleted.
   * @returns The number of rows deleted.
   */
  async purgeOlderThan(cutoff: Date): Promise<number> {
    const { count } = await prisma.spanPayload.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return count;
  }
}
