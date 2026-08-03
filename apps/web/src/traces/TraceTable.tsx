import { Link } from 'react-router-dom';
import { Empty, StatusDot, Badge } from '@/ui';
import { dateTime } from '@/lib/format';
import { formatUsd, formatCount, formatLatency } from './format';
import type { TraceListItem } from '@/api/types';

export interface TraceTableProps {
  traces: TraceListItem[];
  /** Show the Session column (hidden on the session-detail view where it is redundant). */
  showSession?: boolean;
}

/**
 * Renders trace rows as a plain HTML table (the app has no Table primitive; this
 * mirrors RequestLogTable). Each row links to the trace detail. Reused by the trace
 * list, session detail, and reverse-lineage views.
 *
 * @param traces - Trace rows to render, newest first.
 * @param showSession - Whether to render the Session column; defaults to `true`.
 */
/**
 * Resolves the duration to show for a trace row. Prefers `durationMs` (present on the
 * trace-list payload); falls back to computing it from `startedAt`/`endedAt` (present on
 * the session-detail payload, which omits `durationMs`). Returns null if neither yields a
 * valid, non-NaN value.
 */
function resolveDurationMs(t: TraceListItem): number | null {
  if (t.durationMs != null) return t.durationMs;
  if (!t.startedAt || !t.endedAt) return null;
  const startMs = new Date(t.startedAt).getTime();
  const endMs = new Date(t.endedAt).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;
  return endMs - startMs;
}

export function TraceTable({ traces, showSession = true }: TraceTableProps) {
  if (traces.length === 0) return <Empty title="No traces" description="No traces match these filters yet." />;
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-[820px] border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b border-line-soft text-[11px] uppercase tracking-[0.06em] text-faint">
            <th className="px-4 py-2.5 font-medium">Time</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 font-medium">Input</th>
            {showSession && <th className="px-4 py-2.5 font-medium">Session</th>}
            <th className="px-4 py-2.5 font-medium">Tags</th>
            <th className="px-4 py-2.5 text-right font-medium">Spans</th>
            <th className="px-4 py-2.5 text-right font-medium">Tokens</th>
            <th className="px-4 py-2.5 text-right font-medium">Cost</th>
            <th className="px-4 py-2.5 text-right font-medium">Duration</th>
          </tr>
        </thead>
        <tbody>
          {traces.map((t) => (
            <tr key={t.id} className="border-b border-line-soft bg-surface last:border-b-0 hover:bg-elevated">
              <td className="whitespace-nowrap px-4 py-2.5">
                <Link
                  to={`/traces/${t.id}`}
                  className="font-mono text-[12px] text-ink hover:text-accent"
                  data-testid="trace-row-link"
                  title={dateTime(t.startedAt)}
                >
                  {dateTime(t.startedAt)}
                </Link>
              </td>
              <td className="px-4 py-2.5"><StatusDot status={t.status} /></td>
              <td className="px-4 py-2.5">
                {t.name ? (
                  <span className="block max-w-[260px] truncate text-ink" title={t.name}>
                    {t.name}
                  </span>
                ) : (
                  <span className="font-mono text-faint">{t.id.slice(0, 8)}</span>
                )}
              </td>
              {showSession && (
                <td className="px-4 py-2.5">
                  {t.sessionId ? (
                    <Link to={`/sessions/${encodeURIComponent(t.sessionId)}`} className="font-mono text-[12px] text-varhi hover:underline">
                      {t.sessionId}
                    </Link>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </td>
              )}
              <td className="px-4 py-2.5">
                {t.tags.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {t.tags.slice(0, 3).map((tag) => (
                      <Badge key={tag} className="px-1.5 py-0.5 text-[11px]">{tag}</Badge>
                    ))}
                    {t.tags.length > 3 && <span className="text-[11px] text-faint">+{t.tags.length - 3}</span>}
                  </div>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </td>
              <td className="px-4 py-2.5 text-right font-mono">{t.spanCount}</td>
              <td className="px-4 py-2.5 text-right font-mono">{formatCount(t.totalTokens)}</td>
              <td className="px-4 py-2.5 text-right font-mono">{formatUsd(t.totalCostUsd)}</td>
              <td className="px-4 py-2.5 text-right font-mono">{formatLatency(resolveDurationMs(t))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
