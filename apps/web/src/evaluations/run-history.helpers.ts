import type { RunListItem, RunStatus } from '@/api/types';

/** A run status rendered as a dot colour + text label, so meaning never rests on hue alone. */
export interface RunStatusChip {
  label: string;
  /** Tailwind token classes for the dot and the label text. */
  dot: string;
  text: string;
  /** Whether the run is still in flight (the row shows a spinner instead of a duration). */
  inFlight: boolean;
}

const STATUS_CHIPS: Record<RunStatus, RunStatusChip> = {
  queued: { label: 'Queued', dot: 'bg-faint', text: 'text-faint', inFlight: true },
  running: { label: 'Running', dot: 'bg-warn', text: 'text-warn', inFlight: true },
  succeeded: { label: 'Succeeded', dot: 'bg-ok', text: 'text-ok', inFlight: false },
  failed: { label: 'Failed', dot: 'bg-danger', text: 'text-danger', inFlight: false },
};

/**
 * Maps a run's lifecycle status to its display chip. Separate from the trace
 * list's `StatusDot` because a run's four states are not a span's three, and
 * two of them mean "still working" rather than an outcome.
 *
 * @param status - The run's status.
 * @returns The chip's label, colour tokens, and whether the run is in flight.
 */
export function runStatusChip(status: RunStatus): RunStatusChip {
  return STATUS_CHIPS[status] ?? STATUS_CHIPS.queued;
}

/**
 * The name every optimize run's experiment carries. The optimize flow creates
 * its experiment with this fixed placeholder rather than a chosen title, so it
 * is not worth showing as one — the prompt being rewritten is.
 */
const OPTIMIZE_PLACEHOLDER_NAME = 'optimize';

/**
 * The title a history row leads with: the experiment's name when someone
 * actually chose one, else the prompt under test, else the dataset. Never an id
 * — a row identified by a UUID tells a reader nothing about which run it is.
 *
 * @param run - The history row.
 * @returns A human title for the run.
 */
export function runTitle(run: RunListItem): string {
  const name = run.experimentName?.trim();
  if (name && name !== OPTIMIZE_PLACEHOLDER_NAME) return name;
  return run.promptName?.trim() || run.datasetName;
}

/**
 * Describes the frozen grid under a row's title, e.g.
 * `"2 variants × 1 model · 12 examples"`. An optimize run whose candidates are
 * not drafted yet has an empty grid, which reads as `"Resolving grid…"` rather
 * than "0 variants × 0 models".
 *
 * @param run - The history row.
 * @returns One line describing what the run swept.
 */
export function runShapeLine(run: RunListItem): string {
  if (run.variantCount === 0 || run.modelCount === 0) return 'Resolving grid…';

  const variants = `${run.variantCount} variant${run.variantCount === 1 ? '' : 's'}`;
  const models = `${run.modelCount} model${run.modelCount === 1 ? '' : 's'}`;
  const examples = `${run.exampleCount} example${run.exampleCount === 1 ? '' : 's'}`;
  return `${variants} × ${models} · ${examples}`;
}

/**
 * The line under a row's title: the dataset the run was evaluated against, then
 * the grid shape. The dataset is dropped when it is already the title (an
 * unnamed experiment with no prompt) rather than printed twice.
 *
 * @param run - The history row.
 * @returns One line naming what the run ran against and how wide it was.
 */
export function runSubtitle(run: RunListItem): string {
  const shape = runShapeLine(run);
  return runTitle(run) === run.datasetName ? shape : `${run.datasetName} · ${shape}`;
}

/**
 * Formats a mean judge score for display: one decimal place, matching the
 * report matrix's own cells. An unscored run gets an em dash — a `0` would
 * read as "scored badly" when nothing was scored at all.
 *
 * @param avgScore - The run's mean score (0–100), or null when unscored.
 * @returns The score text, or `'—'`.
 */
export function formatScore(avgScore: number | null): string {
  return avgScore === null ? '—' : avgScore.toFixed(1);
}

/**
 * Formats a pass rate as a whole percentage, e.g. `"50% passed"`. Null when
 * nothing is scored, so the caller can omit the line entirely.
 *
 * @param passRate - Share of scored results that passed (0–1), or null.
 * @returns The label, or null when there is nothing to say.
 */
export function formatPassRate(passRate: number | null): string | null {
  return passRate === null ? null : `${Math.round(passRate * 100)}% passed`;
}

/**
 * Formats a run's wall-clock duration compactly — `"820ms"`, `"7.4s"`,
 * `"2m 05s"`. Runs are short enough that minutes are the largest useful unit.
 *
 * @param durationMs - The run's duration, or null while it has not finished.
 * @returns The duration text, or `'—'` when there is none yet.
 */
export function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return '—';
  if (durationMs < 1000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;

  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * Summarises a run's result counts for the row's tooltip, e.g.
 * `"4 results · 4 scored"`, adding the errored count only when there is one so
 * a clean run does not read as though errors were a category it belongs to.
 *
 * @param run - The history row.
 * @returns One line describing what the run produced.
 */
export function runResultsLine(run: RunListItem): string {
  const parts = [`${run.results.total} result${run.results.total === 1 ? '' : 's'}`];
  if (run.results.errored > 0) parts.push(`${run.results.errored} errored`);
  parts.push(`${run.results.scored} scored`);
  return parts.join(' · ');
}
