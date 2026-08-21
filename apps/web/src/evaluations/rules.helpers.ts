/**
 * Formats a rule's mean judge score for display: whole numbers, matching the
 * scale the judge grades on (0–100). Null when nothing has been scored today
 * yet — a `0` would read as "scoring badly" rather than "nothing to show".
 *
 * @param score - The rule's mean score for today (0–100), or null when unscored.
 * @returns The score text, or `'—'`.
 */
export function formatMeanScore(score: number | null): string {
  return score === null ? '—' : `${Math.round(score)}`;
}

/**
 * Formats a rule's sample rate as a whole percentage, e.g. `"10%"`.
 *
 * @param rate - The fraction of matching spans the rule judges (0.01–1).
 * @returns The percentage text.
 */
export function formatSampleRate(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/**
 * Formats a rule's daily judge-call ceiling, e.g. `"500/day"`. Null means the
 * rule has no ceiling — worth spelling out as `"unlimited"` rather than a
 * blank cell, since an unbounded rule is a real (and costly) choice.
 *
 * @param limit - The rule's daily limit, or null when uncapped.
 * @returns The limit text.
 */
export function formatDailyLimit(limit: number | null): string {
  return limit === null ? 'unlimited' : `${limit}/day`;
}
