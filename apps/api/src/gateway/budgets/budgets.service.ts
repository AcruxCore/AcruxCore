import { BudgetsRepository } from './budgets.repository';
import { computeResetsAt } from './period';
import { audit } from '../../shared/audit';
import prisma from '../../shared/db/client';
import { ConflictError, NotFoundError } from '../../shared/errors';
import type { Budget, BudgetResponse, CreateBudgetDto, UpdateBudgetDto } from './budgets.types';

/** Maps a Prisma Budget row to the API response shape. */
function toResponse(b: Budget): BudgetResponse {
  return {
    id: b.id,
    virtualKeyId: b.virtualKeyId,
    period: b.period,
    limitUsd: b.limitUsd.toNumber(),
    spendUsd: b.spendUsd.toNumber(),
    resetsAt: b.resetsAt ? b.resetsAt.toISOString() : null,
    createdBy: b.createdBy,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

/**
 * Business logic for spend caps: create (with duplicate guard + computed reset),
 * list (lazy-reset applied), update, delete. Never imports prisma except to pass
 * the shared client to the fire-and-forget audit helper.
 */
export class BudgetsService {
  constructor(private readonly repo: BudgetsRepository) {}

  /**
   * Creates a budget. Computes resets_at from the period, rejects a duplicate
   * (same team + scope + period) with 409 BUDGET_EXISTS, and emits budget_created.
   *
   * @param teamId - Owning team.
   * @param actorId - Creating user (createdBy + audit actor).
   * @param dto - Validated body (virtualKeyId, period, limitUsd).
   * @returns The created budget.
   * @throws {ConflictError} BUDGET_EXISTS when a budget for this scope+period exists.
   */
  async create(teamId: string, actorId: string, dto: CreateBudgetDto): Promise<BudgetResponse> {
    const existing = await this.repo.findDuplicate(teamId, dto.virtualKeyId, dto.period);
    if (existing) {
      throw new ConflictError('BUDGET_EXISTS', 'A budget for this scope and period already exists.');
    }

    const resetsAt = computeResetsAt(dto.period, new Date());
    const row = await this.repo.create({
      teamId,
      virtualKeyId: dto.virtualKeyId,
      period: dto.period,
      limitUsd: dto.limitUsd,
      resetsAt,
      createdBy: actorId,
    });

    void audit(prisma, {
      teamId,
      actorId,
      event: 'budget_created',
      metadata: {
        budgetId: row.id,
        scope: row.virtualKeyId ? 'key' : 'team',
        period: row.period,
        limitUsd: row.limitUsd.toNumber(),
      },
    });

    return toResponse(row);
  }

  /**
   * Lists a team's budgets with live spend/reset (lazy reset applied per row).
   *
   * @param teamId - The team.
   * @returns The team's budgets with any elapsed periods reset.
   */
  async list(teamId: string): Promise<BudgetResponse[]> {
    const rows = await this.repo.listByTeam(teamId);
    const fresh = await Promise.all(rows.map((r) => this.repo.resetIfElapsed(r)));
    return fresh.map(toResponse);
  }

  /**
   * Updates a budget's limit and/or period; recomputes resets_at when the period
   * changes. Emits budget_updated.
   *
   * @param teamId - Isolation boundary.
   * @param id - Budget id.
   * @param actorId - Acting user (audit).
   * @param dto - Validated patch.
   * @returns The updated budget.
   * @throws {NotFoundError} If the budget is not in this team.
   */
  async update(teamId: string, id: string, actorId: string, dto: UpdateBudgetDto): Promise<BudgetResponse> {
    const current = await this.repo.findByIdForTeam(id, teamId);
    if (!current) throw new NotFoundError('Budget not found.');

    const nextPeriod = dto.period ?? current.period;
    const row = await this.repo.update(id, {
      limitUsd: dto.limitUsd,
      period: dto.period,
      // Recompute the reset boundary only when the period actually changed.
      resetsAt: dto.period && dto.period !== current.period ? computeResetsAt(nextPeriod, new Date()) : undefined,
    });

    void audit(prisma, {
      teamId,
      actorId,
      event: 'budget_updated',
      metadata: { budgetId: row.id, limitUsd: row.limitUsd.toNumber() },
    });

    return toResponse(row);
  }

  /**
   * Deletes a budget (removes the cap).
   *
   * @param teamId - Isolation boundary.
   * @param id - Budget id.
   * @throws {NotFoundError} If the budget is not in this team.
   */
  async delete(teamId: string, id: string): Promise<void> {
    const current = await this.repo.findByIdForTeam(id, teamId);
    if (!current) throw new NotFoundError('Budget not found.');
    await this.repo.delete(id);
  }
}
