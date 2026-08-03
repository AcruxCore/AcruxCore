import { Link, useParams } from 'react-router-dom';
import { Empty, PageSpinner } from '@/ui';
import { useSession } from '@/api';
import { TraceTable } from './TraceTable';
import { formatUsd, formatCount } from './format';
import { dateTime } from '@/lib/format';

/** The /sessions/:id screen: a session's rollup header above its traces (newest first). */
export function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, isError } = useSession(id ?? null);
  if (isLoading) return <PageSpinner />;
  if (isError || !data) {
    return <Empty title="Session not found" description="No traces with that session id in your team." />;
  }
  const { session, traces } = data;
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <Link to="/sessions" className="text-[12px] text-muted hover:text-ink">
          ← Sessions
        </Link>
        <h1 className="font-mono text-[18px] font-semibold tracking-tight">{session.sessionId}</h1>
        <div className="flex flex-wrap gap-4 text-[13px] text-muted">
          <span>{session.traceCount} traces</span>
          <span className="font-mono">{formatCount(session.totalTokens)} tokens</span>
          <span className="font-mono">{formatUsd(session.totalCostUsd)}</span>
          <span>
            {dateTime(session.firstAt)} → {dateTime(session.lastAt)}
          </span>
        </div>
      </header>
      <TraceTable traces={traces} showSession={false} />
    </div>
  );
}
