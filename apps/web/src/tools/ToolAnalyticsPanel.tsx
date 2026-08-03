import type { ReactNode } from 'react';
import { useToolAnalytics } from '@/api';
import { BarChart, Empty, PageSpinner } from '@/ui';
import { formatCount, formatLatency, formatPercent } from '@/gateway/format';

/** A titled card wrapping a single chart (mirrors `traces/DashboardsPage.tsx`'s `ChartCard`). */
function ChartCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="mb-3 text-[13px] font-medium text-ink">{title}</div>
      {children}
    </div>
  );
}

/**
 * Read-only panel showing per-tool call analytics (TC7): a bar chart of calls by
 * tool, plus a table of error rate and p50/p95 latency per tool. Sourced from
 * `useToolAnalytics`, which aggregates TC4's tool spans server-side — no new
 * capture path here.
 */
export function ToolAnalyticsPanel() {
  const { data, isLoading, isError } = useToolAnalytics();
  const stats = data?.data ?? [];

  if (isLoading) return <PageSpinner />;
  if (isError || !data) {
    return <Empty title="Couldn’t load tool analytics" description="Something went wrong. Try again." />;
  }
  if (stats.length === 0) {
    return (
      <Empty
        title="No tool executions yet"
        description="Once tools are called through traced runs, their call volume, error rate, and latency will show up here."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ChartCard title="Calls by tool">
        <BarChart bars={stats.map((s) => ({ label: s.toolName, value: s.calls }))} formatY={formatCount} />
      </ChartCard>

      <div className="overflow-hidden rounded-xl border border-line">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-line-soft bg-elevated text-[11px] uppercase tracking-[0.06em] text-faint">
              <th className="px-4 py-2 font-medium">Tool</th>
              <th className="px-4 py-2 font-medium">Calls</th>
              <th className="px-4 py-2 font-medium">Error rate</th>
              <th className="px-4 py-2 font-medium">p50</th>
              <th className="px-4 py-2 font-medium">p95</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s) => (
              <tr key={s.toolName} className="border-b border-line-soft last:border-b-0">
                <td className="px-4 py-2.5 font-medium text-ink">{s.toolName}</td>
                <td className="px-4 py-2.5 font-mono text-ink">{formatCount(s.calls)}</td>
                <td className="px-4 py-2.5 font-mono text-ink">{formatPercent(s.errorRate)}</td>
                <td className="px-4 py-2.5 font-mono text-ink">{formatLatency(s.p50Ms)}</td>
                <td className="px-4 py-2.5 font-mono text-ink">{formatLatency(s.p95Ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
