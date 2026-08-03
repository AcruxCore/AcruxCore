import { Prisma } from '@prisma/client';
import prisma from '../../shared/db/client';
import { computeResetsAt } from './period';
import type { Budget, CreateBudgetInput, UpdateBudgetInput } from './budgets.types';

/**
 * Data access for the `budgets` table. The only budgets file that imports prisma.
 */
export class BudgetsRepository {
  /**
   * Loads every budget that applies to a call: the team-wide budget
   * (virtual_key_id IS NULL) plus, when a key is supplied, that key's budget.
   *
   * @param teamId - The calling team.
   * @param virtualKeyId - The calling virtual key, if any (session callers omit it).
   * @returns Matching budget rows (0–2 for a single period each).
   */
  async applicableBudgets(teamId: string, virtualKeyId?: string): Promise<Budget[]> {
    return prisma.budget.findMany({
      where: {
        teamId,
        OR: [
          { virtualKeyId: null },
          ...(virtualKeyId ? [{ virtualKeyId }] : []),
        ],
      },
    });
  }

  /**
   * Lazy period reset. If the budget's resets_at is in the past, zeroes spend_usd
   * and rolls resets_at forward one period; otherwise returns the row unchanged.
   * 'total' budgets (resets_at null) never reset.
   *
   * @param budget - The budget row to (possibly) reset.
   * @returns The current row after any reset (freshly persisted values).
   */
  async resetIfElapsed(budget: Budget): Promise<Budget> {
    if (budget.resetsAt === null || budget.resetsAt.getTime() > Date.now()) {
      return budget;
    }
    const nextResetsAt = computeResetsAt(budget.period, new Date());
    return prisma.budget.update({
      where: { id: budget.id },
      data: { spendUsd: new Prisma.Decimal(0), resetsAt: nextResetsAt },
    });
  }

  /**
   * Atomically reserves `estimatedCostUsd` against a budget: increments
   * `spend_usd` only if the result would stay at or under `limit_usd`, in one
   * conditional `UPDATE`. Returns `null` (zero rows updated) when the
   * reservation would exceed the cap — the caller must treat that as
   * over-budget and must not proceed with the paid call.
   *
   * This closes the check-then-act race `precheckBudgets` used to have:
   * reading spend, deciding, and incrementing later left a window where N
   * concurrent requests could all read "under budget" and all proceed. A
   * single atomic conditional increment means only as many concurrent callers
   * as actually fit under the cap can ever succeed, no matter how many race in
   * at once. The real cost is unknown until the provider responds, so the
   * caller reserves a conservative estimate here and reconciles the
   * difference afterward via `incrementSpend` (which accepts a negative delta
   * to credit back an overestimate).
   *
   * @param tx - The Prisma transaction client from the pipeline's $transaction.
   * @param budgetId - Budget to reserve against.
   * @param estimatedCostUsd - Conservative USD estimate to reserve (must be finite ≥ 0).
   * @returns The budget's spend after reservation and its cap, or `null` if the
   *   reservation would exceed `limit_usd` (nothing was written).
   */
  async reserveSpend(
    tx: Prisma.TransactionClient,
    budgetId: string,
    estimatedCostUsd: number,
  ): Promise<{ after: Prisma.Decimal; limit: Prisma.Decimal } | null> {
    const delta = new Prisma.Decimal(estimatedCostUsd);
    const rows = await tx.$queryRaw<{ spend_usd: Prisma.Decimal; limit_usd: Prisma.Decimal }[]>(
      Prisma.sql`
        UPDATE budgets
        SET spend_usd = spend_usd + ${delta}, updated_at = now()
        WHERE id = ${budgetId}::uuid AND spend_usd + ${delta} <= limit_usd
        RETURNING spend_usd, limit_usd
      `,
    );
    const row = rows[0];
    if (!row) return null;
    return { after: row.spend_usd, limit: row.limit_usd };
  }

  /**
   * Adds `costUsd` to a budget's spend_usd inside the caller's transaction.
   *
   * Returns the post-increment row so the caller can detect a threshold
   * crossing. The `before` value is derived as `after - costUsd` rather than
   * read separately: the UPDATE is atomic and its returned `spend_usd` already
   * accounts for any concurrent increment, so subtracting this call's own delta
   * gives the exact value this transaction saw. A separate SELECT could not — it
   * would race with another request's increment and make two concurrent callers
   * both believe they crossed, or neither.
   *
   * @param tx - The Prisma transaction client from the pipeline's $transaction.
   * @param budgetId - Budget to increment.
   * @param costUsd - USD to add (must be finite ≥ 0).
   * @returns The budget's spend before and after this increment, and its cap.
   */
  async incrementSpend(
    tx: Prisma.TransactionClient,
    budgetId: string,
    costUsd: number,
  ): Promise<{ before: Prisma.Decimal; after: Prisma.Decimal; limit: Prisma.Decimal }> {
    const delta = new Prisma.Decimal(costUsd);
    const updated = await tx.budget.update({
      where: { id: budgetId },
      data: { spendUsd: { increment: delta }, updatedAt: new Date() },
      select: { spendUsd: true, limitUsd: true },
    });
    return {
      before: updated.spendUsd.sub(delta),
      after: updated.spendUsd,
      limit: updated.limitUsd,
    };
  }

  /**
   * Reads a team's display name, for a budget alert's subject line.
   *
   * @param teamId - The team.
   * @returns The name, or null when the team is gone.
   */
  async findTeamName(teamId: string): Promise<string | null> {
    const row = await prisma.team.findUnique({
      where: { id: teamId },
      select: { name: true },
    });
    return row?.name ?? null;
  }

  /**
   * Reads a virtual key's display name, for a budget alert's scope label.
   *
   * @param virtualKeyId - The key a budget is scoped to.
   * @returns The name, or null when the key is gone.
   */
  async findVirtualKeyName(virtualKeyId: string): Promise<string | null> {
    const row = await prisma.virtualKey.findUnique({
      where: { id: virtualKeyId },
      select: { name: true },
    });
    return row?.name ?? null;
  }

  /**
   * Inserts a budget row.
   *
   * @param input - Team, scope, period, limit, computed resets_at, creator.
   * @returns The created row.
   */
  async create(input: CreateBudgetInput): Promise<Budget> {
    return prisma.budget.create({
      data: {
        teamId: input.teamId,
        virtualKeyId: input.virtualKeyId,
        period: input.period,
        limitUsd: new Prisma.Decimal(input.limitUsd),
        resetsAt: input.resetsAt,
        createdBy: input.createdBy,
      },
    });
  }

  /**
   * Lists all budgets for a team (team-wide and per-key), newest first.
   *
   * @param teamId - The team.
   * @returns Budget rows ordered by createdAt descending.
   */
  async listByTeam(teamId: string): Promise<Budget[]> {
    return prisma.budget.findMany({ where: { teamId }, orderBy: { createdAt: 'desc' } });
  }

  /**
   * Finds one budget by id, scoped to the team (isolation).
   *
   * @param id - Budget id.
   * @param teamId - The owning team.
   * @returns The row, or undefined if not found / wrong team.
   */
  async findByIdForTeam(id: string, teamId: string): Promise<Budget | undefined> {
    const row = await prisma.budget.findFirst({ where: { id, teamId } });
    return row ?? undefined;
  }

  /**
   * Finds an existing budget with the same scope + period (duplicate check for 409).
   *
   * @param teamId - The team.
   * @param virtualKeyId - null for team-wide.
   * @param period - The period to check.
   * @returns The conflicting row, or undefined.
   */
  async findDuplicate(teamId: string, virtualKeyId: string | null, period: string): Promise<Budget | undefined> {
    const row = await prisma.budget.findFirst({
      where: { teamId, virtualKeyId, period: period as Budget['period'] },
    });
    return row ?? undefined;
  }

  /**
   * Updates mutable fields (limit, period, recomputed resets_at) by id.
   *
   * @param id - Budget id (ownership already verified by the service).
   * @param patch - Fields to change.
   * @returns The updated row.
   */
  async update(id: string, patch: UpdateBudgetInput): Promise<Budget> {
    return prisma.budget.update({
      where: { id },
      data: {
        ...(patch.limitUsd !== undefined ? { limitUsd: new Prisma.Decimal(patch.limitUsd) } : {}),
        ...(patch.period !== undefined ? { period: patch.period } : {}),
        ...(patch.resetsAt !== undefined ? { resetsAt: patch.resetsAt } : {}),
      },
    });
  }

  /**
   * Hard-deletes a budget by id.
   *
   * @param id - Budget id (ownership verified by the service).
   */
  async delete(id: string): Promise<void> {
    await prisma.budget.delete({ where: { id } });
  }
}
