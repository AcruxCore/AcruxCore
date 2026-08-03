import { z } from 'zod';

/**
 * Zod schema for a LLM-as-judge verdict.
 * Validates the shape and types only (is `score` a number at all). The score is
 * intentionally NOT constrained to an integer or to the [0,100] range here:
 * LLMs occasionally emit a fractional score (e.g. 85.5), and `parseVerdict`
 * rounds to the nearest integer and clamps both bounds after validation — so a
 * non-integer must pass validation and be rounded, not be rejected as malformed.
 */
export const VerdictSchema = z.object({
  score: z.number(),
  passed: z.boolean(),
  reason: z.string().min(1),
});

/**
 * A LLM-as-judge verdict: score (0–100), pass/fail boolean, and explanation.
 */
export type Verdict = z.infer<typeof VerdictSchema>;
