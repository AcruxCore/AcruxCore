import { useSearchParams } from 'react-router-dom';
import { Button, Empty, PageSpinner, Select } from '@/ui';
import { useRuns } from '@/api';
import type { RunListFilters, RunStatus } from '@/api/types';
import { EvaluationsTabs } from './EvaluationsTabs';
import { RunHistoryTable } from './RunHistoryTable';

/** Rows per page. Fixed rather than user-selectable — the list is scanned, not browsed. */
const PAGE_SIZE = 20;

const STATUSES: RunStatus[] = ['running', 'queued', 'succeeded', 'failed'];

/** Reads the filter state off the URL, so a filtered history is linkable and survives a reload. */
function parseFilters(sp: URLSearchParams): RunListFilters {
  const status = sp.get('status');
  const page = Number(sp.get('page') ?? 1);

  return {
    ...(status && STATUSES.includes(status as RunStatus) ? { status: status as RunStatus } : {}),
    ...(sp.get('dataset_id') ? { dataset_id: sp.get('dataset_id')! } : {}),
    page: Number.isFinite(page) && page >= 1 ? page : 1,
    limit: PAGE_SIZE,
  };
}

/**
 * The `/evaluations/runs` screen: every evaluation and optimize run the team has
 * started, newest first, each linking to its comparison report. This is the only
 * way back to a report once the tab that started the run is gone.
 *
 * Polls while any listed run is still in flight (see `useRuns`), so a run
 * started elsewhere fills in on its own.
 */
export function RunHistoryPage() {
  const [sp, setSp] = useSearchParams();
  const filters = parseFilters(sp);
  const { data, isLoading, isError } = useRuns(filters);

  const page = filters.page ?? 1;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  /** Writes one filter to the URL, resetting to page 1 for anything but paging itself. */
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(sp);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setSp(next);
  };

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">Datasets</h1>
        <p className="mt-1 text-[13px] text-muted">
          Datasets built from feedback, and the experiments run against them.
        </p>
      </header>

      <EvaluationsTabs active="runs" />

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[12px] text-muted">
          Status
          <Select
            className="w-[150px]"
            value={filters.status ?? ''}
            onChange={(e) => setParam('status', e.target.value)}
            data-testid="run-status-filter"
          >
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s[0].toUpperCase() + s.slice(1)}
              </option>
            ))}
          </Select>
        </label>
        {data && (
          <span className="text-[12px] text-faint">
            {data.total} run{data.total === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {isLoading ? (
        <PageSpinner />
      ) : isError ? (
        <Empty title="Couldn’t load runs" description="Something went wrong fetching runs. Try again." />
      ) : data!.data.length === 0 ? (
        <Empty
          title={filters.status ? `No ${filters.status} runs` : 'No runs yet'}
          description={
            filters.status
              ? 'No run matches this filter. Clear it to see the team’s full history.'
              : 'Open a dataset on the Datasets tab and press Run experiment to evaluate a prompt.'
          }
        />
      ) : (
        <>
          <RunHistoryTable runs={data!.data} />
          {totalPages > 1 && (
            <div className="flex items-center gap-3 text-[13px] text-muted">
              <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setParam('page', String(page - 1))}>
                Previous
              </Button>
              <span>
                Page {page} of {totalPages}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setParam('page', String(page + 1))}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
