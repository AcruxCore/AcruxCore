import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Drawer, Empty, MonoBlock, PageSpinner } from '@/ui';
import { formatPayload } from '@/traces';
import { cn } from '@/lib/cn';
import { useAuth } from '@/auth/AuthContext';
import { useRunCell } from '@/api';
import type { RunCellExample } from '@/api/types';
import { scoreToGrade } from './matrix.helpers';
import { PromoteDialog } from './PromoteDialog';
import { PipelineTestDialog } from './PipelineTestDialog';
import { HistoryDisclosure } from './HistoryDisclosure';
import { NamedScoreList } from './NamedScoreList';

export interface CellDrilldownPanelProps {
  runId: string;
  /** The cell to drill into, or null when the panel should be closed. */
  cellKey: string | null;
  /**
   * The cell's `promptCandidateId` (from `Run.grid`), or null when the
   * selected cell is a `'version'` (production baseline) cell rather than
   * an optimizer-drafted `'candidate'` cell — only candidate cells can be
   * promoted.
   */
  candidateId: string | null;
  /** The variant's display label from the report, e.g. "v1 (production)". Falls back to the cell's own label. */
  variantLabel?: string;
  /**
   * Opens the prompt viewer for this cell's prompt. Absent for a local run's
   * cell, which has no prompt on the platform.
   */
  onViewPrompt?: () => void;
  onClose: () => void;
}

/** Pass/fail/unscored indicator for one example — text label always present, color never the only signal. */
function PassBadge({ passed }: { passed: boolean | null }) {
  if (passed === null) return <span className="text-[12px] font-medium text-faint">Unscored</span>;
  return (
    <span className={cn('text-[12px] font-medium', passed ? 'text-ok' : 'text-danger')}>
      {passed ? '▲ Passed' : '▼ Failed'}
    </span>
  );
}

/** One dataset example's row: input/output, judge verdict, and links to the produced + judge traces. */
function ExampleRow({ example }: { example: RunCellExample }) {
  const grade = scoreToGrade(example.score);
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-line-soft bg-surface px-3 py-3" data-testid="drilldown-example">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[13px] font-semibold text-ink">
            {example.score === null ? '—' : example.score.toFixed(1)}
          </span>
          <span className="text-[11px] uppercase tracking-[0.04em] text-faint">
            {grade === 'unscored' ? '' : grade}
          </span>
        </div>
        <PassBadge passed={example.passed} />
      </div>

      {example.criteria && <p className="text-[12px] text-muted">{example.criteria}</p>}
      <HistoryDisclosure history={example.history} />

      <MonoBlock label="Input" value={formatPayload(example.input)} />
      {example.expected != null && <MonoBlock label="Expected" value={formatPayload(example.expected)} />}
      {example.errorMessage != null ? (
        /* A cell that never produced output has no Output worth showing — the
           API returns null for it — and the reason is the only thing the reader
           came for. Shown in place of the block rather than beside it.
           Tested for null, not truthiness: an empty `errorMessage` still means the
           cell failed, and falling through would show the blank Output block that
           issue #504 was opened to remove. */
        <div className="flex flex-col gap-0.5" data-testid="drilldown-error">
          <span className="text-[11px] uppercase tracking-[0.06em] text-faint">Why this cell failed</span>
          <p className="text-[13px] text-danger">{example.errorMessage || 'No reason was recorded.'}</p>
        </div>
      ) : (
        <MonoBlock label="Output" value={formatPayload(example.output)} />
      )}

      {example.scores && example.scores.length > 0 ? (
        /* A local result: every scorer's verdict, the primary one included, so
           the single judge-reasoning line would only repeat one of them. */
        <NamedScoreList scores={example.scores} />
      ) : (
        example.reason && (
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] uppercase tracking-[0.06em] text-faint">Judge reasoning</span>
            <p className="text-[13px] text-ink">{example.reason}</p>
          </div>
        )
      )}

      <div className="flex flex-wrap gap-3 border-t border-line-soft pt-2">
        {example.traceId ? (
          <Link to={`/traces/${example.traceId}`} className="text-[12px] text-varhi hover:underline">
            View trace →
          </Link>
        ) : (
          <span className="text-[12px] text-faint">No trace captured</span>
        )}
        {example.judgeTraceId && (
          <Link to={`/traces/${example.judgeTraceId}`} className="text-[12px] text-varhi hover:underline">
            View judge trace →
          </Link>
        )}
      </div>
    </div>
  );
}

/**
 * Side-panel drill-down for one matrix cell: fetches its per-example
 * results (`useRunCell`) and renders each example's input/output, judge
 * score/pass/reason, and links to the produced trace and (when present)
 * the judge trace — reusing the `/traces/:id` detail route already used
 * throughout `traces/` and `evaluations/DatasetDetailPage`.
 *
 * @param runId - The run the cell belongs to.
 * @param cellKey - The cell to show, or null to keep the panel closed.
 * @param candidateId - The cell's `promptCandidateId`, or null if this cell
 *   is a production-baseline (`'version'`) cell rather than a candidate one.
 * @param onViewPrompt - Opens the cell's prompt read-only; the "View prompt" button shows
 *   when it is given, for every role, since reading a candidate is not promoting it.
 * @param onClose - Called when the panel is dismissed (Esc, overlay click, or close button).
 */
export function CellDrilldownPanel({
  runId,
  cellKey,
  candidateId,
  variantLabel,
  onViewPrompt,
  onClose,
}: CellDrilldownPanelProps) {
  const { canWrite } = useAuth();
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [pipelineOpen, setPipelineOpen] = useState(false);
  const detail = useRunCell(runId, cellKey);
  const title = detail.data ? `${variantLabel ?? detail.data.variantLabel} · ${detail.data.model}` : 'Cell detail';
  const description = detail.data ? `${detail.data.examples.length} example${detail.data.examples.length === 1 ? '' : 's'}` : undefined;

  return (
    <Drawer open={!!cellKey} onOpenChange={(open) => !open && onClose()} title={title} description={description}>
      {detail.isLoading ? (
        <PageSpinner />
      ) : detail.isError || !detail.data ? (
        <Empty title="Could not load this cell" description="Something went wrong. Try again." />
      ) : (
        <div className="flex flex-col gap-3">
          {/* View prompt shows for every cell and every role: reading a prompt needs no
              promote-right. Promote is gated on the same promote-right the prompt-alias
              promote UI uses (`canWrite` — owner/admin/editor, see `VersionsTab`), and only
              on candidate cells; the production baseline cell has nothing to promote. */}
          {(onViewPrompt || (canWrite && candidateId)) && (
            <div className="flex flex-wrap gap-2">
              {onViewPrompt && (
                <Button size="sm" onClick={onViewPrompt} data-testid="drilldown-view-prompt">
                  View prompt
                </Button>
              )}
              {canWrite && candidateId && (
                /* Before promoting: the run scored each example with one tool-less call, so only the
                   team's own app shows whether the rewrite changes what it retrieves or calls. */
                <Button size="sm" onClick={() => setPipelineOpen(true)} data-testid="drilldown-test-pipeline">
                  Test in your pipeline
                </Button>
              )}
              {canWrite && candidateId && (
                <Button variant="primary" size="sm" onClick={() => setPromoteOpen(true)}>
                  Promote to production
                </Button>
              )}
            </div>
          )}

          {detail.data.examples.length === 0 ? (
            <Empty title="No examples" description="This cell has no dataset examples." />
          ) : (
            <div className="flex flex-col gap-3" data-testid="drilldown-examples">
              {detail.data.examples.map((example) => (
                <ExampleRow key={example.exampleId} example={example} />
              ))}
            </div>
          )}

          {candidateId && (
            <PipelineTestDialog
              key={`pipeline-${candidateId}`}
              open={pipelineOpen}
              onOpenChange={setPipelineOpen}
              runId={runId}
              candidateId={candidateId}
            />
          )}

          {candidateId && cellKey && (
            <PromoteDialog
              key={candidateId}
              open={promoteOpen}
              onOpenChange={setPromoteOpen}
              runId={runId}
              candidateId={candidateId}
              cellKey={cellKey}
            />
          )}
        </div>
      )}
    </Drawer>
  );
}
