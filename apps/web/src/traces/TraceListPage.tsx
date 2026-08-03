import { useSearchParams } from 'react-router-dom';
import { Button, Empty, PageSpinner } from '@/ui';
import { useTraces } from '@/api';
import { TraceFilters, parseTraceFilters } from './TraceFilters';
import { TraceTable } from './TraceTable';

/**
 * The /traces screen: URL-synced filter bar over a paginated trace table. Loading,
 * empty, and error states follow the app conventions (PageSpinner / Empty).
 */
export function TraceListPage() {
  const [sp, setSp] = useSearchParams();
  const filters = parseTraceFilters(sp);
  const { data, isLoading, isError } = useTraces(filters);

  const page = filters.page ?? 1;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / (filters.limit ?? 20))) : 1;
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
      <TraceFilters />
      {isLoading ? (
        <PageSpinner />
      ) : isError ? (
        <Empty title="Couldn’t load traces" description="Something went wrong fetching traces. Try again." />
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
