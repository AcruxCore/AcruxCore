import { niceCeil, scaleY } from './chart-scale';

export interface BarChartProps {
  /** `value` is nullable so a grouped bucket with no timed spans (e.g. p95 latency) renders as an absent bar, not a `NaN` rect. */
  bars: { label: string; value: number | null }[];
  colorVar?: string;
  height?: number;
  formatY?: (v: number) => string;
}

/**
 * A minimal SVG bar chart for grouped dimensions (model/session/prompt version),
 * themed via CSS tokens. Renders an empty placeholder instead of a degenerate
 * chart when there are no bars, and skips `null` values (drawing no rect) instead
 * of a `NaN`-sized one.
 *
 * Colors use the raw tokens (`--accent`, `--warn`, `--danger`, `--line-soft` from
 * tokens.css), not the `--color-*` aliases Tailwind's `@theme inline` generates for
 * utility classes — those aliases are tree-shaken out of the compiled CSS unless a
 * matching utility class name (e.g. `bg-accent`) literally appears in scanned source,
 * so `var(--color-accent)` resolves to nothing here and SVG falls back to black fill.
 */
export function BarChart({ bars, colorVar = 'accent', height = 160, formatY = String }: BarChartProps) {
  const width = 640;
  const isEmpty = bars.length === 0;
  const values = bars.map((b) => b.value).filter((v): v is number => v !== null);
  const max = niceCeil(Math.max(1, ...values));
  const gap = 8;
  const bw = bars.length ? (width - gap * (bars.length - 1)) / bars.length : width;

  if (isEmpty) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-dashed border-line-soft text-[12px] text-faint"
        style={{ height }}
        data-testid="bar-chart-empty"
      >
        No data
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="bar-chart">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="bar chart">
        <line x1="0" y1={height} x2={width} y2={height} stroke="var(--line-soft)" />
        {bars.map((b, i) => {
          if (b.value === null) return null;
          const y = scaleY(b.value, max, height);
          return (
            <rect
              key={b.label}
              x={i * (bw + gap)}
              y={y}
              width={bw}
              height={height - y}
              fill={`var(--${colorVar})`}
              rx="2"
            />
          );
        })}
      </svg>
      <div className="flex justify-between text-[10.5px] text-faint">
        <span className="truncate">{bars[0]?.label}</span>
        <span className="font-mono">max {formatY(max)}</span>
        <span className="truncate">{bars[bars.length - 1]?.label}</span>
      </div>
    </div>
  );
}
