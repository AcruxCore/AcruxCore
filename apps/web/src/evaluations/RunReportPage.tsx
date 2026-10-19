import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Empty, PageSpinner, Spinner } from '@/ui';
import { useRun, useRunReport } from '@/api';
import type { RunReport, RunReportCell, RunStatus } from '@/api/types';
import { LeaderboardMatrix } from './LeaderboardMatrix';
import { NamedScoreTable } from './NamedScoreTable';
import { CellDrilldownPanel } from './CellDrilldownPanel';
import { variantDisplayLabel } from './variant-label';
import { summarizeUnscored } from './matrix.helpers';

/**
 * Status strip above the matrix: while a run is in flight, when it failed, and when it
 * succeeded with examples left unscored. Quiet once every example has a score.
 */
function RunStatusBanner({
  status,
  error,
  cells,
  unscoredReason,
}: {
  status: RunStatus;
  error?: string | null;
  cells: RunReportCell[];
  unscoredReason?: RunReport['unscoredReason'];
}) {
  if (status === 'queued' || status === 'running') {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-line-soft bg-elevated px-3 py-2 text-[13px] text-muted" data-testid="run-status-banner">
        <Spinner />
        {status === 'queued'
          ? 'Queued — waiting to start…'
          : 'Running — cells fill in below as each finishes.'}
      </div>
    );
  }
  if (status === 'failed') {
    // `error` is written by several producers and only one of them is written for a
    // reader: `summariseCellErrors` condenses the cell failures into a sentence, while
    // `markFinalizeExhausted` stores a raw BullMQ message carrying a run UUID, and the
    // worker stores a job's `failedReason`, which is `''` for `new Error()`. So the
    // reason is shown BESIDE the standing sentence rather than instead of it: the
    // "results are partial" warning is the thing a reader must not lose, and an empty
    // string must not render an empty red box (issue #504).
    const reason = error?.trim();
    return (
      <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger" data-testid="run-status-banner">
        <p>Run failed. Results below reflect whatever completed before the failure.</p>
        {reason && (
          <p className="mt-1 text-[12px] text-danger/85" data-testid="run-status-reason">
            {reason}
          </p>
        )}
      </div>
    );
  }
  // A run whose cells errored, or whose judge failed, still ends "succeeded", and its
  // score averages only the scored examples. Say so, and say why (issues #576, #570).
  const { total, unscored, errored } = summarizeUnscored(cells);
  if (unscored === 0) return null;
  const topReason = unscoredReason?.message;
  // "Results", not "examples": a run with 3 examples on 2 models has 6 results, and the
  // counts here are results.
  return (
    <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[13px] text-warn" data-testid="run-unscored-banner">
      <p>
        {unscored} of {total} result{total === 1 ? '' : 's'} {unscored === 1 ? 'was' : 'were'} not scored
        {errored > 0 && <> ({errored} errored before an answer was produced)</>}. A result is one example run on one
        prompt version and one model. Scores average only the scored results.
      </p>
      {topReason && (
        <p className="mt-1 break-words text-[12px] text-warn/90" data-testid="run-unscored-reason">
          Most common cause: {topReason}
        </p>
      )}
    </div>
  );
}

/**
 * The `/evaluations/runs/:id` screen: polls the run's comparison report
 * ({@link useRunReport}) and renders the matrix leaderboard, a run-status
 * strip while results are still streaming in, and — on cell click — the
 * per-example drill-down panel.
 */
export function RunReportPage() {
  const { id } = useParams<{ id: string }>();
  const report = useRunReport(id ?? null);
  // `RunReport`'s cells never carry `promptCandidateId` (see `RunReportVariant`'s
  // doc comment) — only `Run.grid` does. Fetched alongside the report so the
  // drill-down panel can resolve a selected cell's candidate id for the
  // promote button.
  const run = useRun(id ?? null);
  const [selectedCellKey, setSelectedCellKey] = useState<string | null>(null);

  if (report.isLoading) return <PageSpinner />;
  if (report.isError || !report.data) {
    return <Empty title="Run not found" description="This run does not exist or is not in your team." />;
  }

  const data = report.data;
  const isLocal = run.data?.kind === 'local';
  const selectedGridCell = run.data?.grid.find((g) => g.cellKey === selectedCellKey) ?? null;
  const selectedCandidateId = selectedGridCell?.variantKind === 'candidate' ? selectedGridCell.promptCandidateId ?? null : null;
  const selectedVariant = data?.variants.find((v) => v.variantLabel === selectedGridCell?.variantLabel);
  const selectedVariantLabel = selectedVariant
    ? variantDisplayLabel(selectedVariant.variantLabel, selectedVariant.versionNumber)
    : undefined;

  return (
    <div className="flex flex-col gap-5">
      {/* Back to the run history rather than the datasets list: both ways into
          this page (starting a run, or clicking a history row) came past it. */}
      <Link to="/evaluations/runs" className="text-[12px] text-muted hover:text-ink">
        ← Runs
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Run report</h1>
          <p className="mt-1 text-[13px] text-muted">
            {isLocal ? (
              <span data-testid="run-local-note">
                Local run: your app and scorers ran in your own code through the SDK, and the results were uploaded
                here. The score below is the primary scorer.
              </span>
            ) : (
              <>
                {data.variants.length} variant{data.variants.length === 1 ? '' : 's'} × {data.models.length} model
                {data.models.length === 1 ? '' : 's'}
              </>
            )}
            {data.judge?.model && (
              <span data-testid="run-judge">
                {' '}· judged by {data.judge.model}
                {data.judge.promptVersionId ? ' with a custom judge prompt' : ''}
              </span>
            )}
          </p>
        </div>
        {/* Averages hide examples that flipped both ways; the compare page shows them. */}
        <Link
          to={`/evaluations/runs/${id}/compare`}
          className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] text-ink hover:bg-elevated"
          data-testid="run-compare-link"
        >
          Compare per example
        </Link>
      </header>

      <RunStatusBanner status={data.status} error={run.data?.error} cells={data.cells} unscoredReason={data.unscoredReason} />

      <LeaderboardMatrix report={data} selectedCellKey={selectedCellKey} onSelectCell={setSelectedCellKey} />

      <NamedScoreTable cells={data.cells} />

      {id && (
        <CellDrilldownPanel
          runId={id}
          cellKey={selectedCellKey}
          candidateId={selectedCandidateId}
          variantLabel={selectedVariantLabel}
          onClose={() => setSelectedCellKey(null)}
        />
      )}
    </div>
  );
}
