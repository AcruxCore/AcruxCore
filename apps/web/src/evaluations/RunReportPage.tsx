import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Empty, PageSpinner, Spinner } from '@/ui';
import { useRun, useRunReport } from '@/api';
import type { RunStatus } from '@/api/types';
import { LeaderboardMatrix } from './LeaderboardMatrix';
import { CellDrilldownPanel } from './CellDrilldownPanel';

/** One-line status strip shown above the matrix while a run is in flight or has failed; quiet (no strip) once it has succeeded. */
function RunStatusBanner({ status }: { status: RunStatus }) {
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
    return (
      <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger" data-testid="run-status-banner">
        Run failed. Results below reflect whatever completed before the failure.
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
      <Link to="/evaluations" className="text-[12px] text-muted hover:text-ink">
        ← Evaluations
      </Link>

      <header>
        <h1 className="text-[20px] font-semibold tracking-tight">Run report</h1>
        <p className="mt-1 text-[13px] text-muted">
          {data.variants.length} variant{data.variants.length === 1 ? '' : 's'} × {data.models.length} model
          {data.models.length === 1 ? '' : 's'}
        </p>
      </header>

      <RunStatusBanner status={data.status} />

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
