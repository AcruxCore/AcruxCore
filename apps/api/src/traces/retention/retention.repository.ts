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
   * The tool lists those payloads pointed at (`trace_tool_sets`) are payload content
   * too, so a list no remaining payload points at is deleted in the same pass. A list
   * that a newer round of the same trace still uses stays.
   *
   * @param cutoff - Rows created before this instant are deleted.
   * @returns The number of `span_payloads` rows deleted.
   */
  async purgeOlderThan(cutoff: Date): Promise<number> {
    const { count } = await prisma.spanPayload.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    await prisma.traceToolSet.deleteMany({
      // No age test: a set is shared by its trace's rounds, so it can be newer than the
      // oldest payload that used it. A set is only written in the same transaction as the
      // payload that points at it, so an unreferenced committed set is always an orphan.
      where: { payloads: { none: {} } },
    });
    return count;
  }
}
