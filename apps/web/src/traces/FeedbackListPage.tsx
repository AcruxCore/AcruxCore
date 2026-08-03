import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Empty, PageSpinner, Select } from '@/ui';
import { useFeedbackFeed, useFeedbackSummary } from '@/api';
import { CreateDatasetDialog, ImproveFromFeedbackDialog } from '@/evaluations';
import { SOURCE_LABELS } from './format';
import { timeAgo } from '@/lib/format';
import type { FeedbackGroupBy } from '@/api/types';

const LIMIT = 20;

/** One grouped summary bucket (a prompt version id or a model name). */
function SummaryRow({ label, count, avgRating, downCount }: { label: string; count: number; avgRating: number | null; downCount: number }) {
  return (
    <tr className="border-b border-line-soft last:border-0">
      <td className="py-2 pr-3 font-mono text-[12px] text-ink">{label}</td>
      <td className="py-2 pr-3 text-[13px] text-muted">{count}</td>
      <td className="py-2 pr-3 font-mono text-[13px] text-ink">{avgRating === null ? '—' : avgRating.toFixed(2)}</td>
      <td className="py-2 text-[13px] text-danger">{downCount}</td>
    </tr>
  );
}

/**
 * Header checkbox that toggles selection for every row on the current page.
 * Renders as `indeterminate` (a dash, not a check) when some but not all of
 * the page's rows are selected — checkbox `indeterminate` isn't settable via
 * a JSX prop, so it's applied imperatively via a ref.
 */
function SelectAllCheckbox({
  ids,
  selected,
  onToggle,
}: {
  ids: string[];
  selected: Set<string>;
  onToggle: (next: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const selectedOnPage = ids.filter((id) => selected.has(id)).length;
  const allSelected = ids.length > 0 && selectedOnPage === ids.length;
  const someSelected = selectedOnPage > 0 && !allSelected;

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = someSelected;
  }, [someSelected]);

  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label="Select all feedback on this page"
      checked={allSelected}
      disabled={ids.length === 0}
      onChange={(e) => onToggle(e.target.checked)}
      className="h-4 w-4 accent-varhi"
    />
  );
}

/**
 * The `/observability/feedback` screen: the existing per-version/model summary
 * aggregate (Q20 — no new aggregation logic) alongside a paginated, browsable raw
 * feed of individual trace- and span-level feedback. Rows can be checked to
 * build an evaluation dataset from their captured variables (Q — dataset
 * builder), via a sticky action bar that appears once anything is selected.
 */
export function FeedbackListPage() {
  const [groupBy, setGroupBy] = useState<FeedbackGroupBy>('prompt_version');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [datasetDialogOpen, setDatasetDialogOpen] = useState(false);
  const [improveDialogOpen, setImproveDialogOpen] = useState(false);
  const summary = useFeedbackSummary({ groupBy });
  const feed = useFeedbackFeed({ page, limit: LIMIT });

  const totalPages = feed.data ? Math.max(1, Math.ceil(feed.data.total / LIMIT)) : 1;
  const pageIds = feed.data ? feed.data.data.map((f) => f.id) : [];

  function toggleRow(id: string, checked: boolean) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAllOnPage(checked: boolean) {
    setSelected((cur) => {
      const next = new Set(cur);
      for (const id of pageIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-5 pb-16">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">Feedback</h1>
        <p className="mt-1 text-[13px] text-muted">Trace- and span-level feedback across your team, plus rollups by prompt version or model.</p>
      </header>

      <section className="rounded-xl border border-line bg-surface p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">Summary</h2>
          <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value as FeedbackGroupBy)} className="w-44" aria-label="Group by" data-testid="feedback-summary-group-by">
            <option value="prompt_version">By prompt version</option>
            <option value="model">By model</option>
          </Select>
        </div>
        {summary.isLoading ? (
          <PageSpinner />
        ) : summary.isError || !summary.data ? (
          <Empty title="Couldn’t load summary" description="Something went wrong. Try again." />
        ) : summary.data.buckets.length === 0 ? (
          <Empty title="No feedback yet" description="Feedback from the last 30 days will summarize here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left" data-testid="feedback-summary-table">
              <thead>
                <tr className="border-b border-line-soft text-[11px] uppercase tracking-[0.06em] text-faint">
                  <th className="py-2 pr-3 font-medium">{groupBy === 'model' ? 'Model' : 'Prompt version'}</th>
                  <th className="py-2 pr-3 font-medium">Count</th>
                  <th className="py-2 pr-3 font-medium">Avg rating</th>
                  <th className="py-2 font-medium">Down</th>
                </tr>
              </thead>
              <tbody>
                {summary.data.buckets.map((b) => (
                  <SummaryRow key={b.key} label={b.key} count={b.count} avgRating={b.avgRating} downCount={b.downCount} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-line bg-surface p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">All feedback</h2>
          {feed.data && feed.data.data.length > 0 && (
            <label className="flex items-center gap-2 text-[12px] text-muted">
              <SelectAllCheckbox ids={pageIds} selected={selected} onToggle={toggleAllOnPage} />
              Select all on page
            </label>
          )}
        </div>
        {feed.isLoading ? (
          <PageSpinner />
        ) : feed.isError || !feed.data ? (
          <Empty title="Couldn’t load feedback" description="Something went wrong. Try again." />
        ) : feed.data.data.length === 0 ? (
          <Empty title="No feedback yet" description="Feedback posted on any trace or span will show up here." />
        ) : (
          <>
            <ul className="flex flex-col gap-2" data-testid="feedback-feed">
              {feed.data.data.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center gap-2 border-b border-line-soft pb-2 text-[13px] last:border-0" data-testid="feedback-feed-item">
                  <input
                    type="checkbox"
                    aria-label={`Select feedback ${f.id.slice(0, 8)}`}
                    checked={selected.has(f.id)}
                    onChange={(e) => toggleRow(f.id, e.target.checked)}
                    className="h-4 w-4 accent-varhi"
                  />
                  {f.rating !== null && (
                    <span className={`font-mono ${f.rating < 0 ? 'text-danger' : 'text-ok'}`}>
                      {f.rating > 0 ? `▲ ${f.rating}` : f.rating < 0 ? '▼' : '0'}
                    </span>
                  )}
                  {f.label && <span className="rounded border border-line-soft px-1.5 py-0.5 text-[11px] text-muted">{f.label}</span>}
                  {f.comment && <span className="text-ink">{f.comment}</span>}
                  <Link
                    to={`/traces/${f.traceId}${f.spanId ? `#span-${encodeURIComponent(f.spanId)}` : ''}`}
                    className="font-mono text-[12px] text-varhi hover:underline"
                  >
                    trace: {f.traceId.slice(0, 8)}
                  </Link>
                  {f.spanId && <span className="rounded border border-line-soft px-1.5 py-0.5 font-mono text-[11px] text-muted">span: {f.spanId}</span>}
                  <span className="ml-auto text-[11px] text-faint">
                    {SOURCE_LABELS[f.source] ?? f.source} · {timeAgo(f.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
            {totalPages > 1 && (
              <div className="mt-3 flex items-center gap-3 text-[13px] text-muted">
                <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                <span>Page {page} of {totalPages}</span>
                <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
              </div>
            )}
          </>
        )}
      </section>

      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-4 z-30 flex justify-center px-4" data-testid="feedback-selection-bar">
          <div className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-2.5 shadow-2xl">
            <span className="text-[13px] text-ink">
              {selected.size} feedback row{selected.size === 1 ? '' : 's'} selected
            </span>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setImproveDialogOpen(true)}
              title="Draft and run improved prompt candidates from this feedback."
            >
              Improve from feedback
            </Button>
            <Button variant="primary" size="sm" onClick={() => setDatasetDialogOpen(true)}>
              Create dataset
            </Button>
          </div>
        </div>
      )}

      <CreateDatasetDialog
        open={datasetDialogOpen}
        onOpenChange={setDatasetDialogOpen}
        feedbackIds={[...selected]}
        onCreated={() => setSelected(new Set())}
      />

      <ImproveFromFeedbackDialog
        open={improveDialogOpen}
        onOpenChange={setImproveDialogOpen}
        feedbackIds={[...selected]}
        onStarted={() => setSelected(new Set())}
      />
    </div>
  );
}
