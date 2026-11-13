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
   * @returns The row as the database now holds it — re-read after the write, so every
   *   column is current rather than only the two this reset touches.
   */
  async resetIfElapsed(budget: Budget): Promise<Budget> {
    if (budget.resetsAt === null || budget.resetsAt.getTime() > Date.now()) {
      return budget;
    }
    const nextResetsAt = computeResetsAt(budget.period, new Date());
    // Conditional on `resets_at` still holding the value this caller read.
    // `applicableBudgets` reads outside any transaction, so just after a period
    // boundary two calls can both hold the stale row; an unconditional write let
    // the second one zero `spend_usd` again *after* the first had already
    // reserved against the new period, erasing a committed reservation and
    // letting the team spend past its cap. Zero rows means another request reset
    // it first, so the freshly persisted row is re-read instead of overwritten.
    await prisma.budget.updateMany({
      where: { id: budget.id, resetsAt: budget.resetsAt },
      data: { spendUsd: new Prisma.Decimal(0), resetsAt: nextResetsAt },
    });
    // Re-read either way, rather than returning `{ ...budget, spendUsd: 0 }` on the
    // winning branch. `applicableBudgets` read this row outside any transaction, so
    // spreading it carries every *other* column forward at whatever value that read
    // saw — including `limit_usd`, which `notifyBudgetCrossings` quotes in the alert
    // email. A cap raised from $10 to $100 between the two would be announced as $10.
    // This path runs at most once per budget per period, so the extra SELECT is free.
    return prisma.budget.findUniqueOrThrow({ where: { id: budget.id } });
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
   * caller reserves a conservative estimate here and settles the
   * difference afterward via `settleReservation`, which credits back an
   * overestimate only while the reservation's period is still current.
   *
   * @param tx - The Prisma transaction client from the pipeline's $transaction.
   * @param budgetId - Budget to reserve against.
   * @param estimatedCostUsd - Conservative USD estimate to reserve (must be finite ≥ 0).
   * @returns The budget's spend before and after the reservation plus its cap, or
   *   `null` if the reservation would exceed `limit_usd` (nothing was written).
   *   The before/after pair is what alert-threshold detection must run on: this is
   *   the only transition that raises spend, so a caller that only inspected the
   *   later reconciliation (normally a credit back) could never see a crossing.
   *   `resetsAt` is the period the reservation landed in, read in the same UPDATE;
   *   `settleReservation` needs it to tell whether that period is still current.
   */
  async reserveSpend(
    tx: Prisma.TransactionClient,
    budgetId: string,
    estimatedCostUsd: number,
  ): Promise<{ before: Prisma.Decimal; after: Prisma.Decimal; limit: Prisma.Decimal; resetsAt: Date | null } | null> {
    const delta = new Prisma.Decimal(estimatedCostUsd);
    const rows = await tx.$queryRaw<{ spend_usd: Prisma.Decimal; limit_usd: Prisma.Decimal; resets_at: Date | null }[]>(
      Prisma.sql`
        UPDATE budgets
        SET spend_usd = spend_usd + ${delta}, updated_at = now()
        WHERE id = ${budgetId}::uuid AND spend_usd + ${delta} <= limit_usd
        RETURNING spend_usd, limit_usd, resets_at
      `,
    );
    const row = rows[0];
    if (!row) return null;
    // `before` is derived as `after - delta` for the same reason `settleReservation`
    // derives its own: the UPDATE is atomic, so subtracting this call's delta from
    // the value it returned gives exactly the spend this transaction saw, with no
    // second SELECT that could race a concurrent reservation.
    return {
      before: row.spend_usd.minus(delta),
      after: row.spend_usd,
      limit: row.limit_usd,
      resetsAt: row.resets_at,
    };
  }

  /**
   * Settles a reservation once the call's real cost is known, against the period the
   * reservation was taken in.
   *
   * While the row still holds the reservation it applies `realCostUsd - estimatedCostUsd`
   * — normally a credit back of the unused estimate. Once the period has rolled,
   * `resetIfElapsed` has already zeroed spend, reservation included, so crediting the
   * estimate back would push spend below zero and give the new period that much extra
   * headroom. Then only the real cost is added, to the current period, where the money
   * was actually spent.
   *
   * A roll is `resets_at` having moved on from a period that has ended. `resets_at`
   * moving alone is not enough: an owner changing the budget's period (`update`) also
   * moves it, without zeroing spend, and the row then still holds the reservation.
   * Both branches are one conditional UPDATE, so a reset racing this settle cannot
   * slip between a read and the write.
   *
   * `resets_at` is compared at millisecond precision, the precision a JS `Date`
   * carries back from `reserveSpend`. A 'total' budget (`resets_at` null) never rolls.
   *
   * The `before` value is derived as `after - delta` rather than read separately: the
   * UPDATE is atomic and its returned `spend_usd` already accounts for any concurrent
   * write, so subtracting this call's own delta gives the exact value this transaction
   * saw. A separate SELECT would race another request's write and make two concurrent
   * callers both believe they crossed an alert line, or neither.
   *
   * @param tx - The Prisma transaction client from the pipeline's $transaction.
   * @param budgetId - Budget the reservation was taken against.
   * @param reservedResetsAt - The budget's `resets_at` as `reserveSpend` returned it.
   * @param realCostUsd - The call's real cost (finite, >= 0; 0 for a failed call).
   * @param estimatedCostUsd - The amount `reserveSpend` reserved (finite, >= 0).
   * @returns The budget's spend before and after this settle, and its cap; `null` when
   *   the budget was deleted while the call was in flight, leaving nothing to settle.
   */
  async settleReservation(
    tx: Prisma.TransactionClient,
    budgetId: string,
    reservedResetsAt: Date | null,
    realCostUsd: number,
    estimatedCostUsd: number,
  ): Promise<{ before: Prisma.Decimal; after: Prisma.Decimal; limit: Prisma.Decimal } | null> {
    const samePeriod = new Prisma.Decimal(realCostUsd - estimatedCostUsd);
    const rolled = new Prisma.Decimal(realCostUsd);
    const delta = Prisma.sql`
      CASE WHEN date_trunc('milliseconds', resets_at) IS DISTINCT FROM ${reservedResetsAt}::timestamptz
             AND ${reservedResetsAt}::timestamptz <= now()
        THEN ${rolled}::numeric ELSE ${samePeriod}::numeric END`;
    const rows = await tx.$queryRaw<{ spend_usd: Prisma.Decimal; limit_usd: Prisma.Decimal; delta: Prisma.Decimal }[]>(
      Prisma.sql`
        UPDATE budgets
        SET spend_usd = spend_usd + ${delta}, updated_at = now()
        WHERE id = ${budgetId}::uuid
        RETURNING spend_usd, limit_usd, ${delta} AS delta
      `,
    );
    const row = rows[0];
    if (!row) return null;
    return { before: row.spend_usd.minus(row.delta), after: row.spend_usd, limit: row.limit_usd };
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
   * Scoped to the team rather than looked up by id alone: this name is rendered
   * into an email, so an id that did not belong to the team would put another
   * team's key name in front of this one's owners.
   *
   * @param virtualKeyId - The key a budget is scoped to.
   * @param teamId - The team the alert is being sent to.
   * @returns The name, or null when the key is gone or belongs elsewhere.
   */
  async findVirtualKeyName(virtualKeyId: string, teamId: string): Promise<string | null> {
    const row = await prisma.virtualKey.findFirst({
      where: { id: virtualKeyId, teamId },
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
