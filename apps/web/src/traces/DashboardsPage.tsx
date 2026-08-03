import { useState } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, BarChart, Empty, Input, LineChart, PageSpinner, Select } from '@/ui';
import { useTraceAnalytics } from '@/api';
import { formatCount, formatLatency, formatPercent, formatUsd } from './format';
import { DATE_RANGE_PRESETS, presetFrom, type DateRangePreset } from './date-range';
import type { AnalyticsGroupBy } from '@/api/types';

/** Dimensions with a bounded, comparable set of group keys worth narrowing down. */
const FILTERABLE_GROUP_BYS: AnalyticsGroupBy[] = ['model', 'prompt_version'];

/** One totals tile (requests, error rate, tokens, cost, latency percentiles). */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="text-[11px] uppercase tracking-[0.06em] text-faint">{label}</div>
      <div className="mt-1 font-mono text-[18px] text-ink">{value}</div>
    </div>
  );
}

/** A titled card wrapping a single chart. */
function ChartCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="mb-3 text-[13px] font-medium text-ink">{title}</div>
      {children}
    </div>
  );
}

/**
 * The `/observability` dashboards screen: a URL-synced date range + `group_by`
 * control over {@link useTraceAnalytics}, rendered as a totals row plus either
 * time-series line charts (`group_by=day`) or grouped bar charts (model, session,
 * prompt version). Nullable latency percentiles and an empty bucket list are
 * handled by the chart components themselves (gaps / placeholder, never `NaN`).
 *
 * The date range is a preset picker (`?range=7d|30d|90d|mtd|ytd|custom`, see
 * {@link DATE_RANGE_PRESETS}/{@link presetFrom}) defaulting to the last 30 days;
 * the raw from/to date inputs only appear for `range=custom`.
 *
 * For `model`/`prompt_version` groupings, a chip + autocomplete filter (the same
 * pattern as {@link TraceFilters}'s tag picker) narrows the bar charts down to a
 * chosen subset of the already-fetched buckets — e.g. comparing 10 of 20 models
 * — entirely client-side; no extra request is made.
 */
export function DashboardsPage() {
  const [sp, setSp] = useSearchParams();
  const groupBy = (sp.get('group_by') as AnalyticsGroupBy) ?? 'day';
  const range = (sp.get('range') as DateRangePreset) ?? '30d';
  const isCustomRange = range === 'custom';
  // Presets recompute `from` from "now" on every render (never frozen into the
  // URL) so e.g. "Last 30 days" always means the 30 days ending today, whenever
  // the link is opened. `to` stays unset for presets — the API defaults it to the
  // current instant, which correctly includes today; the raw "To" date input is
  // midnight-exclusive and would silently cut off today's data if used instead.
  const from = isCustomRange ? (sp.get('from') ?? undefined) : (presetFrom(range) ?? undefined);
  const to = isCustomRange ? (sp.get('to') ?? undefined) : undefined;
  const { data, isLoading, isError } = useTraceAnalytics({ from, to, groupBy });
  const [draftKey, setDraftKey] = useState('');

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(sp);
    if (value) next.set(key, value);
    else next.delete(key);
    setSp(next);
  };

  const setRange = (value: string) => {
    const next = new URLSearchParams(sp);
    next.set('range', value);
    if (value !== 'custom') {
      next.delete('from');
      next.delete('to');
    }
    setSp(next);
  };

  // `keys` narrows which group (model / prompt version) bars are charted; it only
  // makes sense for the dimension it was picked under, so switching group_by drops it.
  const setGroupBy = (value: string) => {
    const next = new URLSearchParams(sp);
    if (value) next.set('group_by', value);
    else next.delete('group_by');
    next.delete('keys');
    setSp(next);
  };

  const selectedKeys = sp.getAll('keys');
  const addKey = (key: string) => {
    const trimmed = key.trim();
    if (!trimmed || selectedKeys.includes(trimmed)) return;
    const next = new URLSearchParams(sp);
    next.append('keys', trimmed);
    setSp(next);
    setDraftKey('');
  };
  const removeKey = (key: string) => {
    const next = new URLSearchParams(sp);
    next.delete('keys');
    for (const k of selectedKeys) if (k !== key) next.append('keys', k);
    setSp(next);
  };

  const isFilterable = FILTERABLE_GROUP_BYS.includes(groupBy);
  const displayedBuckets =
    isFilterable && selectedKeys.length > 0
      ? (data?.buckets ?? []).filter((b) => selectedKeys.includes(b.key))
      : (data?.buckets ?? []);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Dashboards</h1>
          <p className="mt-1 text-[13px] text-muted">
            Volume, latency, tokens, cost, and error rate across gateway and SDK traffic.
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-end gap-2">
          <Select
            value={range}
            onChange={(e) => setRange(e.target.value)}
            className="w-40"
            aria-label="Date range"
            data-testid="analytics-range"
          >
            {DATE_RANGE_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
          {isCustomRange && (
            <>
              <Input
                type="date"
                defaultValue={sp.get('from') ?? ''}
                onChange={(e) => setParam('from', e.target.value)}
                className="w-40"
                aria-label="From date"
                data-testid="analytics-from"
              />
              <Input
                type="date"
                defaultValue={sp.get('to') ?? ''}
                onChange={(e) => setParam('to', e.target.value)}
                className="w-40"
                aria-label="To date"
                data-testid="analytics-to"
              />
            </>
          )}
          <Select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value)}
            className="w-44"
            aria-label="Group by"
            data-testid="analytics-group-by"
          >
            <option value="day">By day</option>
            <option value="model">By model</option>
            <option value="session">By session</option>
            <option value="prompt_version">By prompt version</option>
          </Select>
        </div>
      </header>

      {isFilterable && data && data.buckets.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="analytics-key-filter">
          {selectedKeys.map((key) => (
            <Badge key={key} className="cursor-pointer">
              {key}
              <button type="button" onClick={() => removeKey(key)} aria-label={`Remove ${key}`} className="ml-1">
                ×
              </button>
            </Badge>
          ))}
          <Input
            list="analytics-key-options"
            placeholder={selectedKeys.length === 0 ? `Filter ${groupBy === 'model' ? 'models' : 'prompt versions'}…` : 'Add…'}
            value={draftKey}
            onChange={(e) => setDraftKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addKey(draftKey)}
            onBlur={() => draftKey && addKey(draftKey)}
            className="w-56"
            data-testid="analytics-key-input"
          />
          <datalist id="analytics-key-options">
            {data.buckets
              .filter((b) => !selectedKeys.includes(b.key))
              .map((b) => (
                <option key={b.key} value={b.key} />
              ))}
          </datalist>
        </div>
      )}

      {isLoading ? (
        <PageSpinner />
      ) : isError || !data ? (
        <Empty title="Couldn’t load analytics" description="Something went wrong. Try again." />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7" data-testid="analytics-totals">
            <Stat label="Requests" value={formatCount(data.totals.requests)} />
            <Stat label="Error rate" value={formatPercent(data.totals.errorRate)} />
            <Stat label="Tokens" value={formatCount(data.totals.totalTokens)} />
            <Stat label="Cost" value={formatUsd(data.totals.costUsd)} />
            <Stat label="p50" value={formatLatency(data.totals.latencyMs.p50)} />
            <Stat label="p95" value={formatLatency(data.totals.latencyMs.p95)} />
            <Stat label="p99" value={formatLatency(data.totals.latencyMs.p99)} />
          </div>

          {data.buckets.length === 0 ? (
            <Empty title="No data in range" description="No traced traffic for this window." />
          ) : groupBy === 'day' ? (
            <div className="grid gap-4 lg:grid-cols-2" data-testid="analytics-charts">
              <ChartCard title="Latency percentiles">
                <LineChart
                  xLabels={data.buckets.map((b) => b.key)}
                  formatY={(v) => formatLatency(v)}
                  series={[
                    { name: 'p50', colorVar: 'accent', points: data.buckets.map((b) => b.latencyMs.p50) },
                    { name: 'p95', colorVar: 'warn', points: data.buckets.map((b) => b.latencyMs.p95) },
                    { name: 'p99', colorVar: 'danger', points: data.buckets.map((b) => b.latencyMs.p99) },
                  ]}
                />
              </ChartCard>
              <ChartCard title="Request volume">
                <LineChart
                  xLabels={data.buckets.map((b) => b.key)}
                  formatY={formatCount}
                  series={[{ name: 'requests', colorVar: 'accent', points: data.buckets.map((b) => b.requests) }]}
                />
              </ChartCard>
              <ChartCard title="Tokens">
                <LineChart
                  xLabels={data.buckets.map((b) => b.key)}
                  formatY={formatCount}
                  series={[{ name: 'tokens', colorVar: 'accent', points: data.buckets.map((b) => b.totalTokens) }]}
                />
              </ChartCard>
              <ChartCard title="Cost (USD)">
                <LineChart
                  xLabels={data.buckets.map((b) => b.key)}
                  formatY={(v) => formatUsd(v)}
                  series={[{ name: 'cost', colorVar: 'accent', points: data.buckets.map((b) => b.costUsd) }]}
                />
              </ChartCard>
              <ChartCard title="Error rate">
                <LineChart
                  xLabels={data.buckets.map((b) => b.key)}
                  formatY={formatPercent}
                  series={[{ name: 'error rate', colorVar: 'danger', points: data.buckets.map((b) => b.errorRate) }]}
                />
              </ChartCard>
            </div>
          ) : displayedBuckets.length === 0 ? (
            <Empty
              title="No matching groups"
              description="None of the selected models / prompt versions have traffic in this range. Clear the filter above to see everything."
            />
          ) : (
            <div className="grid gap-4 lg:grid-cols-2" data-testid="analytics-charts">
              <ChartCard title="Requests">
                <BarChart bars={displayedBuckets.map((b) => ({ label: b.key, value: b.requests }))} formatY={formatCount} />
              </ChartCard>
              <ChartCard title="Cost (USD)">
                <BarChart
                  bars={displayedBuckets.map((b) => ({ label: b.key, value: b.costUsd }))}
                  formatY={(v) => formatUsd(v)}
                />
              </ChartCard>
              <ChartCard title="Tokens">
                <BarChart bars={displayedBuckets.map((b) => ({ label: b.key, value: b.totalTokens }))} formatY={formatCount} />
              </ChartCard>
              <ChartCard title="p95 latency">
                <BarChart
                  bars={displayedBuckets.map((b) => ({ label: b.key, value: b.latencyMs.p95 }))}
                  colorVar="warn"
                  formatY={(v) => formatLatency(v)}
                />
              </ChartCard>
            </div>
          )}
        </>
      )}
    </div>
  );
}
