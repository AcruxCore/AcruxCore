import { z } from 'zod';

/** Match conditions for an online-eval rule, all ANDed. Empty matches every `llm` span. */
export const EvalRuleFilterSchema = z
  .object({
    promptId: z.string().uuid().optional(),
    promptAlias: z.string().min(1).max(200).optional(),
    model: z.string().min(1).max(200).optional(),
    tags: z.array(z.string().min(1).max(100)).max(20).optional(),
    sessionOnly: z.boolean().optional(),
  })
  .strict();
export type EvalRuleFilter = z.infer<typeof EvalRuleFilterSchema>;

export const CreateEvalRuleSchema = z.object({
  name: z.string().min(1).max(200),
  criteria: z.string().min(1, 'criteria must not be empty').max(5000),
  /** A registered `GatewayModel.publicName` for the team — validated in the service, not here. */
  judgeModel: z.string().min(1, 'judgeModel is required').max(200),
  /** A team Prompt to use as the judge template instead of the built-in one. Null/omitted = built-in judge. */
  judgePromptId: z.string().uuid().nullable().optional(),
  sampleRate: z.number().min(0.01).max(1).default(0.1),
  dailyLimit: z.number().int().positive().nullable().optional().default(500),
  alertBelow: z.number().int().min(0).max(100).nullable().optional(),
  filter: EvalRuleFilterSchema.default({}),
  enabled: z.boolean().default(true),
});
export type CreateEvalRuleDto = z.infer<typeof CreateEvalRuleSchema>;

export const UpdateEvalRuleSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  criteria: z.string().min(1).max(5000).optional(),
  judgeModel: z.string().min(1).max(200).optional(),
  judgePromptId: z.string().uuid().nullable().optional(),
  sampleRate: z.number().min(0.01).max(1).optional(),
  dailyLimit: z.number().int().positive().nullable().optional(),
  alertBelow: z.number().int().min(0).max(100).nullable().optional(),
  filter: EvalRuleFilterSchema.optional(),
});
export type UpdateEvalRuleDto = z.infer<typeof UpdateEvalRuleSchema>;

/** API response shape for one rule, with today's aggregate stats attached. */
export interface EvalRuleResponse {
  id: string;
  name: string;
  enabled: boolean;
  kind: 'llm_judge';
  criteria: string;
  judgeModel: string | null;
  judgePromptId: string | null;
  sampleRate: number;
  dailyLimit: number | null;
  alertBelow: number | null;
  filter: EvalRuleFilter;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  todayCount: number;
  todayMeanScore: number | null;
}

export const RuleScoreListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  maxScore: z.coerce.number().int().min(0).max(100).optional(),
});
export type RuleScoreListQuery = z.infer<typeof RuleScoreListQuerySchema>;

export interface EvalRuleScoreResponse {
  id: string;
  ruleId: string;
  traceId: string;
  spanId: string;
  score: number | null;
  passed: boolean | null;
  reason: string | null;
  judgeTraceId: string | null;
  costUsd: number | null;
  createdAt: string;
}

export const ToDatasetSchema = z.object({
  datasetName: z.string().min(1).max(200),
  threshold: z.number().int().min(0).max(100),
  limit: z.number().int().min(1).max(500).default(100),
});
export type ToDatasetDto = z.infer<typeof ToDatasetSchema>;

/** One dry-run verdict returned by `POST /eval-rules/:id/preview`. Never persisted. */
export interface PreviewVerdict {
  spanId: string;
  traceId: string;
  score: number | null;
  passed: boolean | null;
  reason: string | null;
}
