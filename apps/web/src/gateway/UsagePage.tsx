import { useMemo, useState } from 'react';
import type { UsageGroupBy } from '@/api';
import { useUsage } from '@/api';
import { Empty, PageSpinner, Select } from '@/ui';
import { UsageChart } from './UsageChart';
import { RequestLogTable } from './RequestLogTable';
import { formatCount, formatPercent, formatUsd } from './format';

const RANGES = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];

const GROUPS: { value: UsageGroupBy; label: string }[] = [
  { value: 'day', label: 'By day' },
  { value: 'model', label: 'By model' },
  { value: 'provider', label: 'By provider' },
  { value: 'virtual_key', label: 'By virtual key' },
];

/** A single headline metric tile. */
function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="text-[11px] uppercase tracking-[0.07em] text-faint">{label}</p>
      <p className={`mt-1.5 font-mono text-[20px] tracking-tight ${accent ? 'text-accent' : 'text-ink'}`}>
        {value}
      </p>
    </div>
  );
}

/** Return `YYYY-MM-DD` for `daysAgo` days before today (0 = today). */
function isoDay(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/**
 * Usage & analytics: headline totals, a grouped bar chart, and the full request
 * log. The window is `[from, to)`, so `to` is set to tomorrow to include today.
 */
export function UsagePage() {
  const [range, setRange] = useState('30');
  const [groupBy, setGroupBy] = useState<UsageGroupBy>('day');

  const { from, to } = useMemo(
    () => ({ from: isoDay(Number(range)), to: isoDay(-1) }),
    [range],
  );

  const { data, isLoading, isError } = useUsage({ from, to, groupBy });
  const totals = data?.totals;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-center gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Usage</h1>
          <p className="mt-1 text-[13px] text-muted">
            Every call through the gateway, priced and logged. No message content is stored.
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <Select className="max-w-[150px]" value={range} onChange={(e) => setRange(e.target.value)}>
            {RANGES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
        </div>
      </header>

      {isLoading ? (
        <PageSpinner />
      ) : isError ? (
        <Empty title="Couldn't load usage" description="Please try again." />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Requests" value={formatCount(totals?.requests ?? 0)} />
            <Stat label="Spend" value={formatUsd(totals?.costUsd ?? 0)} accent />
            <Stat
              label="Tokens"
              value={formatCount(
                (totals?.promptTokens ?? 0) + (totals?.completionTokens ?? 0),
              )}
            />
            <Stat label="Cache hit rate" value={formatPercent(totals?.cacheHitRate ?? 0)} />
            <Stat label="Error rate" value={formatPercent(totals?.errorRate ?? 0)} />
          </div>

          <div className="flex items-center justify-between gap-4">
            <h2 className="text-[14px] font-semibold text-ink">Volume</h2>
            <Select
              className="max-w-[170px]"
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as UsageGroupBy)}
            >
              {GROUPS.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </Select>
          </div>
          <UsageChart buckets={data?.buckets ?? []} groupBy={groupBy} />

          <h2 className="mt-1 text-[14px] font-semibold text-ink">Request log</h2>
          <RequestLogTable />
        </>
      )}
    </div>
  );
}
