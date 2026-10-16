import { useState } from 'react';
import type { AnalyticsBucket } from '@/api/types';
import { formatCount, formatLatency, formatPercent, formatUsd } from './format';

/** Columns the step table can be sorted by. */
type SortKey = 'requests' | 'errorRate' | 'p50' | 'p95' | 'p99' | 'totalTokens' | 'costUsd';

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'requests', label: 'Calls' },
  { key: 'errorRate', label: 'Error rate' },
  { key: 'p50', label: 'p50' },
  { key: 'p95', label: 'p95' },
  { key: 'p99', label: 'p99' },
  { key: 'totalTokens', label: 'Tokens' },
  { key: 'costUsd', label: 'Cost' },
];

/** The value a bucket is sorted on; a missing percentile sorts last. */
function sortValue(b: AnalyticsBucket, key: SortKey): number {
  if (key === 'p50' || key === 'p95' || key === 'p99') return b.latencyMs[key] ?? -1;
  return b[key];
}

/**
 * One row per step name inside a trace (`group_by=span_name`), so the slow, failing or
 * expensive step stands out. A table rather than bar charts: a team can have a hundred step
 * names, and each row needs calls, error rate and three percentiles side by side. Sorted by
 * call count by default; every numeric header re-sorts, highest first.
 *
 * @param buckets - The analytics buckets for the current range and kind filter.
 */
export function SpanNameTable({ buckets }: { buckets: AnalyticsBucket[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('requests');
  const rows = [...buckets].sort((a, b) => sortValue(b, sortKey) - sortValue(a, sortKey));

  return (
    <div className="overflow-x-auto rounded-xl border border-line" data-testid="span-name-table">
      <table className="w-full min-w-[700px] border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b border-line-soft text-[11px] uppercase tracking-[0.06em] text-faint">
            <th className="px-3 py-2.5 font-medium">Step</th>
            {COLUMNS.map((c) => (
              <th key={c.key} className="px-3 py-2.5 text-right font-medium" aria-sort={sortKey === c.key ? 'descending' : 'none'}>
                <button
                  type="button"
                  onClick={() => setSortKey(c.key)}
                  className={`whitespace-nowrap uppercase tracking-[0.06em] hover:text-ink ${sortKey === c.key ? 'text-ink' : ''}`}
                >
                  {c.label}
                  {sortKey === c.key ? ' ↓' : ''}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.key} className="border-b border-line-soft bg-surface last:border-b-0 hover:bg-elevated">
              <td
                className={`max-w-[280px] truncate px-3 py-2.5 font-mono text-[12px] ${b.key === '(unnamed)' ? 'text-muted' : 'text-ink'}`}
                title={b.key === '(unnamed)' ? 'Gateway calls sent without an x-span-name header' : b.key}
              >
                {b.key}
              </td>
              <td className="px-3 py-2.5 text-right font-mono">{formatCount(b.requests)}</td>
              <td className={`px-3 py-2.5 text-right font-mono ${b.errorRate > 0 ? 'text-danger' : ''}`}>
                {formatPercent(b.errorRate)}
              </td>
              <td className="px-3 py-2.5 text-right font-mono">{formatLatency(b.latencyMs.p50)}</td>
              <td className="px-3 py-2.5 text-right font-mono">{formatLatency(b.latencyMs.p95)}</td>
              <td className="px-3 py-2.5 text-right font-mono">{formatLatency(b.latencyMs.p99)}</td>
              <td className="px-3 py-2.5 text-right font-mono">{formatCount(b.totalTokens)}</td>
              <td className="px-3 py-2.5 text-right font-mono">{formatUsd(b.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
