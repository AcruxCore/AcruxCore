/**
 * Reads an optimize run's report as "which candidate, if any, beat the baseline".
 *
 * The REST report (`GET /runs/:id/report`) is a (variant x model) matrix built for a
 * dashboard: it never names a candidate's id, because the UI joins that in from the run's
 * grid. An agent needs the opposite shape — one row per candidate, with the id it must
 * pass to promote and a plain yes/no on whether promoting it is an improvement. This
 * module does that join and that verdict, and nothing else, so both the report tool and
 * the promote tool's safety check read the same answer.
 */

/** One frozen grid cell from `GET /runs/:id`. */
export interface OptimizeGridCell {
  cellKey: string;
  variantKind: string;
  variantLabel: string;
  model: string;
  promptCandidateId?: string;
  /** Set on the baseline cells: the version the rewrites were scored against. */
  promptVersionId?: string;
  isProductionBaseline?: boolean;
}

/** One cell of `GET /runs/:id/report`, reduced to the fields read here. */
export interface OptimizeReportCell {
  cellKey: string;
  variantLabel: string;
  model: string;
  isProductionBaseline: boolean;
  avgScore: number | null;
  passRate: number | null;
  scoredCount: number;
  exampleCount: number;
  deltaVsBaseline: {
    score: number | null;
    passRate: number | null;
    label: 'improved' | 'regressed' | 'flat' | 'unknown';
  } | null;
}

/** How one candidate scored on one model, next to the baseline on that model. */
export interface CandidateModelScore {
  model: string;
  avgScore: number | null;
  passRate: number | null;
  baselineAvgScore: number | null;
  /** Candidate minus baseline average score; null when either side has no scores. */
  scoreDelta: number | null;
  /** The report's own label: `improved` / `regressed` need a gap of at least 2 points. */
  verdict: 'improved' | 'regressed' | 'flat' | 'unknown';
}

/** One optimizer-drafted candidate with its scores and the promote verdict. */
export interface CandidateSummary {
  /** The id `promote_optimize_candidate` takes. */
  candidateId: string;
  /** `candidate-A`, `candidate-B`, … as the dashboard shows it. */
  label: string;
  scores: CandidateModelScore[];
  /**
   * True when the candidate improved on at least one model and was improved or flat on
   * every other. A candidate that is worse on one model, or has no scores on one, is not
   * called a win: the prompt is shared by every model that runs it.
   */
  beatsBaseline: boolean;
}

/**
 * Builds one {@link CandidateSummary} per candidate in the run.
 *
 * @param grid - The run's frozen grid, which carries each cell's `promptCandidateId`.
 * @param cells - The report's cells, which carry the scores and deltas.
 * @returns Candidates in label order (`candidate-A` first); ranking is {@link bestCandidate}'s job.
 */
export function summarizeCandidates(
  grid: OptimizeGridCell[],
  cells: OptimizeReportCell[],
): CandidateSummary[] {
  const cellByKey = new Map(cells.map((cell) => [cell.cellKey, cell]));
  const baselineByModel = new Map(
    cells.filter((cell) => cell.isProductionBaseline).map((cell) => [cell.model, cell]),
  );

  const byCandidate = new Map<string, CandidateSummary>();
  for (const gridCell of grid) {
    if (gridCell.variantKind !== 'candidate' || !gridCell.promptCandidateId) continue;
    const reportCell = cellByKey.get(gridCell.cellKey);
    const baseline = baselineByModel.get(gridCell.model);

    let summary = byCandidate.get(gridCell.promptCandidateId);
    if (!summary) {
      summary = {
        candidateId: gridCell.promptCandidateId,
        label: gridCell.variantLabel,
        scores: [],
        beatsBaseline: false,
      };
      byCandidate.set(gridCell.promptCandidateId, summary);
    }
    summary.scores.push({
      model: gridCell.model,
      avgScore: reportCell?.avgScore ?? null,
      passRate: reportCell?.passRate ?? null,
      baselineAvgScore: baseline?.avgScore ?? null,
      scoreDelta: reportCell?.deltaVsBaseline?.score ?? null,
      verdict: reportCell?.deltaVsBaseline?.label ?? 'unknown',
    });
  }

  const summaries = [...byCandidate.values()];
  for (const summary of summaries) {
    // `unknown` blocks a win like `regressed` does: a model with no scored answers is a
    // model the rewrite was never shown to work on.
    summary.beatsBaseline =
      summary.scores.some((score) => score.verdict === 'improved') &&
      summary.scores.every((score) => score.verdict === 'improved' || score.verdict === 'flat');
  }
  return summaries.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Picks the candidate to recommend: the one that beats the baseline by the largest mean
 * score delta across its models.
 *
 * @param candidates - Output of {@link summarizeCandidates}.
 * @returns The best winning candidate, or null when none beats the baseline.
 */
export function bestCandidate(candidates: CandidateSummary[]): CandidateSummary | null {
  let best: CandidateSummary | null = null;
  let bestDelta = -Infinity;
  for (const candidate of candidates) {
    if (!candidate.beatsBaseline) continue;
    const deltas = candidate.scores
      .map((score) => score.scoreDelta)
      .filter((delta): delta is number => delta !== null);
    const mean = deltas.reduce((sum, delta) => sum + delta, 0) / Math.max(1, deltas.length);
    if (mean > bestDelta) {
      best = candidate;
      bestDelta = mean;
    }
  }
  return best;
}
