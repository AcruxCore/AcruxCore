import { Link, useSearchParams } from 'react-router-dom';
import { Button, Empty, PageSpinner } from '@/ui';
import { useSessions } from '@/api';
import { formatUsd, formatCount } from './format';
import { timeAgo, dateTime } from '@/lib/format';

/** The /sessions screen: distinct sessions with trace-count/cost/token/time-span rollups. */
export function SessionsPage() {
  const [sp, setSp] = useSearchParams();
  const page = Number(sp.get('page') ?? '1');
  const { data, isLoading, isError } = useSessions({ page, limit: 20, q: sp.get('q') ?? undefined });
  const totalPages = data ? Math.max(1, Math.ceil(data.total / 20)) : 1;
  const goTo = (p: number) => {
    const n = new URLSearchParams(sp);
    n.set('page', String(p));
    setSp(n);
  };

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">Sessions</h1>
        <p className="text-[13px] text-muted">Related traces grouped by their caller-supplied session id.</p>
      </header>
      {isLoading ? (
        <PageSpinner />
      ) : isError ? (
        <Empty title="Couldn’t load sessions" description="Something went wrong. Try again." />
      ) : data!.data.length === 0 ? (
        <Empty title="No sessions" description="Traces created with a sessionId will group here." />
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full min-w-[640px] border-collapse text-left text-[13px]">
              <thead>
                <tr className="border-b border-line-soft text-[11px] uppercase tracking-[0.06em] text-faint">
                  <th className="px-4 py-2.5 font-medium">Session</th>
                  <th className="px-4 py-2.5 text-right font-medium">Traces</th>
                  <th className="px-4 py-2.5 text-right font-medium">Tokens</th>
                  <th className="px-4 py-2.5 text-right font-medium">Cost</th>
                  <th className="px-4 py-2.5 text-right font-medium">Span</th>
                </tr>
              </thead>
              <tbody>
                {data!.data.map((s) => (
                  <tr key={s.sessionId} className="border-b border-line-soft bg-surface hover:bg-elevated">
                    <td className="px-4 py-2.5">
                      <Link
                        to={`/sessions/${encodeURIComponent(s.sessionId)}`}
                        className="font-mono text-[12px] text-varhi hover:underline"
                        data-testid="session-row-link"
                      >
                        {s.sessionId}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">{s.traceCount}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{formatCount(s.totalTokens)}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{formatUsd(s.totalCostUsd)}</td>
                    <td
                      className="px-4 py-2.5 text-right text-muted"
                      title={`${dateTime(s.firstAt)} → ${dateTime(s.lastAt)}`}
                    >
                      {timeAgo(s.firstAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-3 text-[13px] text-muted">
            <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => goTo(page - 1)}>
              Previous
            </Button>
            <span>
              Page {page} of {totalPages}
            </span>
            <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => goTo(page + 1)}>
              Next
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
