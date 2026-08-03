import { z } from 'zod';
import type { Budget, BudgetPeriod } from '../../shared/db/schema';

export type { Budget, BudgetPeriod };

/** Fields needed to insert a budget row (resets_at is computed by the service). */
export interface CreateBudgetInput {
  teamId: string;
  virtualKeyId: string | null;
  period: BudgetPeriod;
  limitUsd: number;
  resetsAt: Date | null;
  createdBy: string;
}

/** Mutable fields on PATCH. */
export interface UpdateBudgetInput {
  limitUsd?: number;
  period?: BudgetPeriod;
  resetsAt?: Date | null;
}

/** POST /gateway/budgets body. virtualKeyId null = team-wide. */
export const CreateBudgetSchema = z.object({
  virtualKeyId: z.string().uuid().nullable().default(null),
  period: z.enum(['day', 'week', 'month', 'total']),
  limitUsd: z.number().positive('limitUsd must be greater than 0'),
});
export type CreateBudgetDto = z.infer<typeof CreateBudgetSchema>;

/** PATCH /gateway/budgets/:id body — at least one field required. */
export const UpdateBudgetSchema = z
  .object({
    period: z.enum(['day', 'week', 'month', 'total']).optional(),
    limitUsd: z.number().positive('limitUsd must be greater than 0').optional(),
  })
  .refine((v) => v.period !== undefined || v.limitUsd !== undefined, {
    message: 'Provide at least one of period or limitUsd',
  });
export type UpdateBudgetDto = z.infer<typeof UpdateBudgetSchema>;

/** API shape returned by all budget endpoints. */
export interface BudgetResponse {
  id: string;
  virtualKeyId: string | null;
  period: BudgetPeriod;
  limitUsd: number;
  spendUsd: number;
  resetsAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
