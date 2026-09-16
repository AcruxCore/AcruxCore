import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Empty, PageSpinner, Spinner } from '@/ui';
import { useRun, useRunReport } from '@/api';
import type { RunStatus } from '@/api/types';
import { LeaderboardMatrix } from './LeaderboardMatrix';
import { CellDrilldownPanel } from './CellDrilldownPanel';

/** One-line status strip shown above the matrix while a run is in flight or has failed; quiet (no strip) once it has succeeded. */
function RunStatusBanner({ status, error }: { status: RunStatus; error?: string | null }) {
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
  return null;
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
  const selectedGridCell = run.data?.grid.find((g) => g.cellKey === selectedCellKey) ?? null;
  const selectedCandidateId = selectedGridCell?.variantKind === 'candidate' ? selectedGridCell.promptCandidateId ?? null : null;

  return (
    <div className="flex flex-col gap-5">
      {/* Back to the run history rather than the datasets list: both ways into
          this page (starting a run, or clicking a history row) came past it. */}
      <Link to="/evaluations/runs" className="text-[12px] text-muted hover:text-ink">
        ← Runs
      </Link>

      <header>
        <h1 className="text-[20px] font-semibold tracking-tight">Run report</h1>
        <p className="mt-1 text-[13px] text-muted">
          {data.variants.length} variant{data.variants.length === 1 ? '' : 's'} × {data.models.length} model
          {data.models.length === 1 ? '' : 's'}
        </p>
      </header>

      <RunStatusBanner status={data.status} error={run.data?.error} />

      <LeaderboardMatrix report={data} selectedCellKey={selectedCellKey} onSelectCell={setSelectedCellKey} />

      {id && (
        <CellDrilldownPanel
          runId={id}
          cellKey={selectedCellKey}
          candidateId={selectedCandidateId}
          onClose={() => setSelectedCellKey(null)}
        />
      )}
    </div>
  );
}
