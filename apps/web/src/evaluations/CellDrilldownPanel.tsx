import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Drawer, Empty, MonoBlock, PageSpinner } from '@/ui';
import { cn } from '@/lib/cn';
import { useAuth } from '@/auth/AuthContext';
import { useRunCell } from '@/api';
import type { RunCellExample } from '@/api/types';
import { scoreToGrade } from './matrix.helpers';
import { PromoteDialog } from './PromoteDialog';
import { HistoryDisclosure } from './HistoryDisclosure';

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

      <MonoBlock label="Input" value={JSON.stringify(example.input, null, 2)} />
      <MonoBlock label="Output" value={JSON.stringify(example.output, null, 2)} />

      {example.reason && (
        <div className="flex flex-col gap-0.5">
          <span className="text-[11px] uppercase tracking-[0.06em] text-faint">Judge reasoning</span>
          <p className="text-[13px] text-ink">{example.reason}</p>
        </div>
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
 * @param onClose - Called when the panel is dismissed (Esc, overlay click, or close button).
 */
export function CellDrilldownPanel({ runId, cellKey, candidateId, onClose }: CellDrilldownPanelProps) {
  const { canWrite } = useAuth();
  const [promoteOpen, setPromoteOpen] = useState(false);
  const detail = useRunCell(runId, cellKey);
  const title = detail.data ? `${detail.data.variantLabel} · ${detail.data.model}` : 'Cell detail';
  const description = detail.data ? `${detail.data.examples.length} example${detail.data.examples.length === 1 ? '' : 's'}` : undefined;

  return (
    <Drawer open={!!cellKey} onOpenChange={(open) => !open && onClose()} title={title} description={description}>
      {detail.isLoading ? (
        <PageSpinner />
      ) : detail.isError || !detail.data ? (
        <Empty title="Could not load this cell" description="Something went wrong. Try again." />
      ) : (
        <div className="flex flex-col gap-3">
          {/* Promote is gated on the same promote-right the prompt-alias promote UI uses
              (`canWrite` — owner/admin/editor, see `VersionsTab`) — viewers never see the button.
              Only rendered for candidate cells; the production baseline cell has nothing to promote. */}
          {canWrite && candidateId && (
            <Button variant="primary" size="sm" onClick={() => setPromoteOpen(true)} className="self-start">
              Promote to production
            </Button>
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
