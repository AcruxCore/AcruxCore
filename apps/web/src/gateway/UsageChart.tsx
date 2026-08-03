import type { UsageBucket, UsageGroupBy } from '@/api';
import { formatCount, formatUsd } from './format';

export interface UsageChartProps {
  buckets: UsageBucket[];
  groupBy: UsageGroupBy;
}

/**
 * Horizontal bar chart of usage buckets. Bars encode request volume (the one
 * quantity comparable across every group mode); cost and tokens ride alongside
 * as mono readouts. A single accent hue keeps it legible in both themes.
 */
export function UsageChart({ buckets, groupBy }: UsageChartProps) {
  if (buckets.length === 0) {
    return (
      <div className="rounded-xl border border-line bg-surface p-8 text-center text-[13px] text-muted">
        No requests in this window yet.
      </div>
    );
  }

  // Day buckets read best oldest→newest; categorical buckets by volume desc.
  const ordered =
    groupBy === 'day'
      ? [...buckets].sort((a, b) => a.key.localeCompare(b.key))
      : [...buckets].sort((a, b) => b.requests - a.requests);
  const max = Math.max(...ordered.map((b) => b.requests), 1);

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-col gap-2.5">
        {ordered.map((b) => (
          <div key={b.key} className="flex items-center gap-3">
            <div className="w-40 flex-none truncate text-right font-mono text-[12px] text-muted" title={b.key}>
              {b.key}
            </div>
            <div className="relative h-6 flex-1 overflow-hidden rounded-md bg-elevated">
              <div
                className="h-full rounded-md bg-accent/25 transition-[width]"
                style={{ width: `${Math.max((b.requests / max) * 100, 2)}%` }}
              />
              <span className="absolute inset-y-0 left-2 flex items-center font-mono text-[11.5px] text-ink">
                {formatCount(b.requests)} req
              </span>
            </div>
            <div className="w-28 flex-none text-right font-mono text-[12px] text-faint">
              {formatUsd(b.costUsd)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
