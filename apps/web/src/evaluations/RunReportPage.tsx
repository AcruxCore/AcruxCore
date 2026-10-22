import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, Dialog, DialogFooter, Empty, PageSpinner, Spinner, useToast } from '@/ui';
import { ApiError, useRejudgeRun, useRun, useRunReport } from '@/api';
import type { RunGridCell, RunReport, RunReportCell, RunReportVariant, RunStatus } from '@/api/types';
import { LeaderboardMatrix } from './LeaderboardMatrix';
import { NamedScoreTable } from './NamedScoreTable';
import { CellDrilldownPanel } from './CellDrilldownPanel';
import { PromptViewerDialog } from './PromptViewerDialog';
import type { PromptSource } from './PromptViewerDialog';
import { variantDisplayLabel } from './variant-label';
import { summarizeUnscored } from './matrix.helpers';
import { optimizerRejectionsNote } from './optimizer-rejections';

/**
 * Status strip above the matrix: while a run is in flight, when it failed, and when it
 * succeeded with examples left unscored. Quiet once every example has a score.
 *
 * `action` sits at the strip's right edge on a finished run — the re-judge button
 * (issue #639), shown only when there is something to re-judge.
 */
function RunStatusBanner({
  status,
  error,
  cells,
  unscoredReason,
  action,
}: {
  status: RunStatus;
  error?: string | null;
  cells: RunReportCell[];
  unscoredReason?: RunReport['unscoredReason'];
  action?: ReactNode;
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
      <div
        className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger"
        data-testid="run-status-banner"
      >
        <div className="min-w-0 flex-1">
          <p>Run failed. Results below reflect whatever completed before the failure.</p>
          {reason && (
            <p className="mt-1 text-[12px] text-danger/85" data-testid="run-status-reason">
              {reason}
            </p>
          )}
        </div>
        {action}
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
    <div
      className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[13px] text-warn"
      data-testid="run-unscored-banner"
    >
      <div className="min-w-0 flex-1">
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
      {action}
    </div>
  );
}

/**
 * Says how many of the optimizer's rewrites were dropped before scoring, and why
 * (issue #686). Without it, a report with fewer rewrites than requested looks the
 * same as the optimizer writing fewer. {@link optimizerRejectionsNote} decides
 * when it shows.
 */
function OptimizerRejectionsNote({ rejections, kept }: { rejections: string[]; kept: number }) {
  const written = kept + rejections.length;
  return (
    <div
      className="rounded-lg border border-line-soft bg-elevated px-3 py-2 text-[13px] text-muted"
      data-testid="run-optimizer-rejections"
    >
      <p>
        The optimizer wrote {written} rewrite{written === 1 ? '' : 's'}. {rejections.length} {rejections.length === 1 ? 'was' : 'were'}{' '}
        dropped before scoring, so the table below shows {kept}.
      </p>
      <ul className="mt-1 list-disc pl-5 text-[12px]">
        {rejections.map((reason) => (
          <li key={reason} className="break-words">
            {reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One {@link PromptSource} per prompt variant in the run, in grid order. The grid
 * holds one cell per variant per model, so a variant is kept once. A local run's
 * cells have no prompt on the platform and are left out.
 *
 * @param grid - The run's resolved grid (`Run.grid`), which alone carries the candidate ids.
 * @param variants - The report's variants, which carry the version numbers for display labels.
 * @returns The run's prompt variants by variant label; each source is keyed `candidate:<id>` or `version:<id>`.
 */
function promptSourcesOf(grid: RunGridCell[], variants: RunReportVariant[]): Map<string, PromptSource> {
  const sources = new Map<string, PromptSource>();
  for (const cell of grid) {
    if (sources.has(cell.variantLabel)) continue;
    const variant = variants.find((v) => v.variantLabel === cell.variantLabel);
    const label = variantDisplayLabel(cell.variantLabel, variant?.versionNumber);
    if (cell.variantKind === 'candidate' && cell.promptCandidateId) {
      sources.set(cell.variantLabel, { key: `candidate:${cell.promptCandidateId}`, label, kind: 'candidate', candidateId: cell.promptCandidateId });
    } else if (cell.variantKind === 'version' && cell.promptVersionId) {
      sources.set(cell.variantLabel, { key: `version:${cell.promptVersionId}`, label, kind: 'version', versionId: cell.promptVersionId });
    }
  }
  return sources;
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
  // The variant whose prompt is open in the viewer, from the matrix or the side panel.
  const [viewingLabel, setViewingLabel] = useState<string | null>(null);
  const rejudge = useRejudgeRun(id ?? '');
  const toast = useToast();
  const [confirmRejudgeAll, setConfirmRejudgeAll] = useState(false);

  /** Sends results back to the run's judge; the models under test are not called again. */
  async function handleRejudge(onlyUnscored: boolean) {
    try {
      const res = await rejudge.mutateAsync(onlyUnscored);
      if (res.rejudging === 0) toast.success('Nothing to re-judge: every result already has a score');
      else toast.success(`Sent ${res.rejudging} result${res.rejudging === 1 ? '' : 's'} back to the judge`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not re-judge this run');
    } finally {
      setConfirmRejudgeAll(false);
    }
  }

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
  const sourcesByLabel = promptSourcesOf(run.data?.grid ?? [], data.variants);
  const runSources = [...sourcesByLabel.values()];
  const selectedSource = selectedGridCell ? sourcesByLabel.get(selectedGridCell.variantLabel) ?? null : null;
  const viewingSource = viewingLabel ? sourcesByLabel.get(viewingLabel) ?? null : null;

  // Re-judging grades the outputs already produced, so a result that errored before
  // producing one is never counted. A local run has no server judge to run again.
  const finished = data.status === 'succeeded' || data.status === 'failed';
  const canRejudge = finished && !isLocal && !!data.judge?.model;
  const { total, unscored, errored } = summarizeUnscored(data.cells);
  const withOutput = total - errored;
  const rejudgeable = unscored - errored;
  const rejectionsNote = optimizerRejectionsNote(data);

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
        <div className="flex flex-wrap items-center gap-2">
          {canRejudge && withOutput > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setConfirmRejudgeAll(true)} data-testid="run-rejudge-all">
              Re-judge all
            </Button>
          )}
          {/* Averages hide examples that flipped both ways; the compare page shows them. */}
          <Link
            to={`/evaluations/runs/${id}/compare`}
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] text-ink hover:bg-elevated"
            data-testid="run-compare-link"
          >
            Compare per example
          </Link>
        </div>
      </header>

      <RunStatusBanner
        status={data.status}
        error={run.data?.error}
        cells={data.cells}
        unscoredReason={data.unscoredReason}
        action={
          canRejudge && rejudgeable > 0 ? (
            <Button
              size="sm"
              className="shrink-0"
              disabled={rejudge.isPending}
              onClick={() => handleRejudge(true)}
              data-testid="run-rejudge-unscored"
            >
              {rejudge.isPending
                ? 'Sending to the judge…'
                : `Re-judge ${rejudgeable} unscored result${rejudgeable === 1 ? '' : 's'}`}
            </Button>
          ) : undefined
        }
      />

      {rejectionsNote && <OptimizerRejectionsNote {...rejectionsNote} />}

      <LeaderboardMatrix
        report={data}
        selectedCellKey={selectedCellKey}
        onSelectCell={setSelectedCellKey}
        promptLabels={new Set(sourcesByLabel.keys())}
        onViewPrompt={setViewingLabel}
      />

      <NamedScoreTable cells={data.cells} />

      <Dialog
        open={confirmRejudgeAll}
        onOpenChange={setConfirmRejudgeAll}
        title={`Re-judge all ${withOutput} result${withOutput === 1 ? '' : 's'}?`}
        description={`Every result that has an output is graded again by ${data.judge?.model ?? 'the run’s judge'}, with the criteria and judge prompt this run started with. Existing scores are replaced. The models under test are not called again; only the judge calls are billed.`}
      >
        <DialogFooter>
          <Button variant="ghost" onClick={() => setConfirmRejudgeAll(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={rejudge.isPending}
            onClick={() => handleRejudge(false)}
            data-testid="run-rejudge-all-confirm"
          >
            {rejudge.isPending ? 'Sending to the judge…' : 'Re-judge all'}
          </Button>
        </DialogFooter>
      </Dialog>

      {id && (
        <CellDrilldownPanel
          runId={id}
          cellKey={selectedCellKey}
          candidateId={selectedCandidateId}
          variantLabel={selectedVariantLabel}
          onViewPrompt={selectedSource ? () => setViewingLabel(selectedGridCell?.variantLabel ?? null) : undefined}
          onClose={() => setSelectedCellKey(null)}
        />
      )}

      {id && viewingSource && (
        <PromptViewerDialog
          key={viewingSource.key}
          open
          onOpenChange={(open) => !open && setViewingLabel(null)}
          runId={id}
          source={viewingSource}
          runSources={runSources}
        />
      )}
    </div>
  );
}
