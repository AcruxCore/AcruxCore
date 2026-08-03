import type { RunReportDelta } from '@/api/types';

/** A cell's score bucket, used to pick both the background tint and the text label. */
export type ScoreGrade = 'unscored' | 'low' | 'mid' | 'high';

/** A regression-delta chip's color intent (paired with a text label — never color alone). */
export type DeltaTone = 'up' | 'down' | 'flat' | 'unknown';

export interface DeltaChip {
  /** Human-readable text, e.g. "+12 improved", "-12 regressed", "Baseline". */
  label: string;
  tone: DeltaTone;
}

/**
 * Buckets a cell's average judge score into a grade for color-grading the
 * matrix. Thresholds (chosen deliberately, not derived from data):
 * - `null` → `'unscored'` (no scored examples in the cell yet)
 * - `< 50` → `'low'`
 * - `50–79` → `'mid'`
 * - `>= 80` → `'high'`
 *
 * These mirror a common "F/D–C/B–A" school-grade split, which reviewers
 * intuitively read without needing a legend.
 *
 * @param score - The cell's average judge score (0–100 scale), or `null` if unscored.
 * @returns The grade bucket driving the cell's color + text label.
 */
export function scoreToGrade(score: number | null): ScoreGrade {
  if (score === null) return 'unscored';
  if (score >= 80) return 'high';
  if (score >= 50) return 'mid';
  return 'low';
}

/**
 * Maps a cell's regression delta (vs. its same-model production baseline)
 * to a display chip: a tone for the color accent and a label that always
 * includes the numeric delta when one is computable, so the chip never
 * relies on color alone.
 *
 * - `null` (the baseline cell itself) → `{ label: 'Baseline', tone: 'flat' }`
 * - `label: 'improved'` → tone `'up'`, e.g. `"+12.0 improved"`
 * - `label: 'regressed'` → tone `'down'`, e.g. `"-12.0 regressed"`
 * - `label: 'flat'` → tone `'flat'`, e.g. `"±0.0 flat"`
 * - `label: 'unknown'` → tone `'unknown'`, `"Not comparable"` (score not computable)
 *
 * The delta is rendered to one decimal place, matching how the cell's own
 * score is printed. `avgScore` is a mean, so a 2-of-3 pass rate arrives as
 * 66.66666666666667 — unrounded, that spilled the full float into the chip
 * right below a score reading `66.7`.
 *
 * @param delta - The cell's `RunReportDelta`, or `null` on the baseline cell.
 * @returns A `{ label, tone }` pair ready to render as a text+color chip.
 */
export function deltaToChip(delta: RunReportDelta | null): DeltaChip {
  if (delta === null) {
    return { label: 'Baseline', tone: 'flat' };
  }
  const { score, label } = delta;
  const signed =
    score === null ? null : `${score > 0 ? '+' : score < 0 ? '-' : '±'}${Math.abs(score).toFixed(1)}`;

  switch (label) {
    case 'improved':
      return { label: `${signed ?? ''} improved`.trim(), tone: 'up' };
    case 'regressed':
      return { label: `${signed ?? ''} regressed`.trim(), tone: 'down' };
    case 'flat':
      return { label: `${signed ?? '±0'} flat`.trim(), tone: 'flat' };
    case 'unknown':
    default:
      return { label: 'Not comparable', tone: 'unknown' };
  }
}
