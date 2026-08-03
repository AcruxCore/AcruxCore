import { z } from 'zod';

/**
 * Zod schema for a single optimizer-proposed candidate rewrite.
 * Validates shape/types only: `messages` must be a non-empty array of
 * `{ role, content }` objects; `rationale` defaults to `''` if omitted.
 * Template validity (does the content still parse as nunjucks, does it
 * preserve the same `{{ variables }}`) is NOT checked here — that is
 * enforced separately via `extractVariables` in `optimize.parse.ts`.
 */
export const CandidateSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.string(),
        content: z.string(),
      }),
    )
    .min(1),
  rationale: z.string().default(''),
});

/**
 * Zod schema for the full optimizer LLM response: a list of candidate
 * rewrites.
 */
export const OptimizeResultSchema = z.object({
  candidates: z.array(CandidateSchema),
});

/**
 * An optimizer LLM response: a list of proposed candidate prompt rewrites,
 * each with its rewritten `messages` and a `rationale` explaining the change.
 */
export type OptimizeResult = z.infer<typeof OptimizeResultSchema>;

/**
 * Validated body for `POST /api/v1/prompts/:promptId/optimize`. `draft_count`
 * is intentionally NOT capped here via `.max()` — the cap (6) is enforced in
 * `OptimizeService.startOptimize` as a semantic 422 (`UnprocessableError`),
 * distinct from a 400 shape-validation failure, mirroring how
 * `CreateExperimentSchema` only validates shape and services enforce business
 * rules. Absent, it defaults to 3 in the service, not here, so the DTO type
 * below reflects "optional at the wire" honestly.
 */
export const StartOptimizeSchema = z.object({
  dataset_id: z.string().uuid(),
  models: z.array(z.string().min(1)).min(1),
  draft_count: z.number().int().positive().optional(),
});

/** Validated start-optimize payload. */
export type StartOptimizeDto = z.infer<typeof StartOptimizeSchema>;

/**
 * Validated body for `POST /api/v1/runs/:id/promote` (E6 Task 5) — the
 * human-in-the-loop action that turns one optimizer-drafted
 * `PromptCandidate` into a real `PromptVersion` and moves an alias to it.
 * `alias` defaults to `'production'` in the service, not here, so the DTO
 * type reflects "optional at the wire" honestly (same pattern as
 * `draft_count` above).
 */
export const PromoteCandidateSchema = z.object({
  prompt_candidate_id: z.string().uuid(),
  alias: z.string().min(1).optional(),
});

/** Validated promote-candidate payload. */
export type PromoteCandidateDto = z.infer<typeof PromoteCandidateSchema>;

/**
 * Response DTO for `GET /api/v1/runs/:id/candidates/:candidateId` (E7 Task 5).
 * Carries just enough of a `PromptCandidate` row for a promote-review UI to
 * render a template diff (`messages`) and the optimizer's own justification
 * (`rationale`) before a human confirms the irreversible promote action —
 * deliberately omits `teamId`/`experimentRunId`, which are request-scoping
 * concerns the client already knows from the URL, not view data.
 */
export interface CandidateDetail {
  id: string;
  promptId: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  rationale: string | null;
  label: string;
  createdAt: Date;
}
