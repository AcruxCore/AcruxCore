import { useSearchParams } from 'react-router-dom';
import { Button, Empty, PageSpinner } from '@/ui';
import { useTraces } from '@/api';
import { FilterBar, useUrlFilterState } from './filter-bar';
import { TraceTable } from './TraceTable';

/** Rows per page. Fixed: the list is scanned, not paged through deliberately. */
const PAGE_SIZE = 20;

/**
 * The /traces screen: URL-synced filter bar over a paginated trace table. Loading,
 * empty, and error states follow the app conventions (PageSpinner / Empty).
 */
export function TraceListPage() {
  const [sp, setSp] = useSearchParams();
  const [filters, setFilters] = useUrlFilterState();
  const page = Number(sp.get('page')) || 1;
  const { data, isLoading, isError } = useTraces({ ...filters, page, limit: PAGE_SIZE });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const goTo = (p: number) => {
    const next = new URLSearchParams(sp);
    next.set('page', String(p));
    setSp(next);
  };

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Traces</h1>
          <p className="mt-1 text-[13px] text-muted">Every gateway completion and SDK-reported run, newest first.</p>
        </div>
      </header>
      <FilterBar value={filters} onChange={setFilters} surface="traces" />
      {isLoading ? (
        <PageSpinner />
      ) : isError ? (
        <Empty title="Couldn’t load traces" description="Something went wrong fetching traces. Try again." />
      ) : data!.data.length === 0 ? (
        <Empty
          title="No traces match these filters"
          description="Clear a filter, or widen the date range. Searching input and output text only finds traces whose payloads were captured."
        />
      ) : (
        <>
          <TraceTable traces={data!.data} />
          {totalPages > 1 && (
            <div className="flex items-center gap-3 text-[13px] text-muted">
              <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => goTo(page - 1)}>Previous</Button>
              <span>Page {page} of {totalPages}</span>
              <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => goTo(page + 1)}>Next</Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
