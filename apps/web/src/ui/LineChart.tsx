import { linePath, niceCeil, scaleY, xCoord } from './chart-scale';

export interface LineSeries {
  /** Legend label — meaning is never carried by color alone. */
  name: string;
  /** A token color utility suffix, e.g. 'accent' | 'warn' | 'danger'. */
  colorVar: string;
  /** One value per x position; `null` renders as a gap (e.g. an empty latency bucket). */
  points: (number | null)[];
}

export interface LineChartProps {
  series: LineSeries[];
  xLabels: string[];
  height?: number;
  formatY?: (v: number) => string;
}

/**
 * A minimal, dependency-free multi-series line chart drawn as inline SVG using theme
 * tokens (via CSS var colors). A text legend names each series so meaning never relies
 * on color alone. Renders an empty placeholder instead of a degenerate chart when there
 * are no x positions, and gaps (no line segment) instead of `NaN` where a series has a
 * `null` point. Each real point also gets a small circle marker — without it, a series
 * with a single bucket (e.g. one day of data under `group_by=day`) would draw a bare SVG
 * moveto with no line-to, which paints nothing, leaving the chart looking empty.
 *
 * Colors use the raw tokens (`--accent`, `--warn`, `--danger`, `--line-soft` from
 * tokens.css), not the `--color-*` aliases Tailwind's `@theme inline` generates for
 * utility classes — those aliases are tree-shaken out of the compiled CSS unless a
 * matching utility class name (e.g. `bg-accent`) literally appears in scanned source,
 * so `var(--color-accent)` resolves to nothing here and SVG falls back to black fill.
 */
export function LineChart({ series, xLabels, height = 160, formatY = String }: LineChartProps) {
  const width = 640;
  const isEmpty = xLabels.length === 0;
  const allValues = series.flatMap((s) => s.points).filter((v): v is number => v !== null);
  const max = niceCeil(Math.max(1, ...allValues));

  return (
    <div className="flex flex-col gap-2" data-testid="line-chart">
      <div className="flex flex-wrap gap-3 text-[11px] text-muted">
        {series.map((s) => (
          <span key={s.name} className="inline-flex items-center gap-1.5">
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: `var(--${s.colorVar})` }}
              aria-hidden
            />
            {s.name}
          </span>
        ))}
      </div>
      {isEmpty ? (
        <div
          className="flex h-[160px] items-center justify-center rounded-md border border-dashed border-line-soft text-[12px] text-faint"
          style={{ height }}
          data-testid="line-chart-empty"
        >
          No data
        </div>
      ) : (
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full"
          role="img"
          aria-label={series.map((s) => s.name).join(', ')}
        >
          <line x1="0" y1={height} x2={width} y2={height} stroke="var(--line-soft)" />
          {series.map((s) => (
            <path
              key={s.name}
              d={linePath(s.points, max, width, height)}
              fill="none"
              stroke={`var(--${s.colorVar})`}
              strokeWidth="1.5"
            />
          ))}
          {series.map((s) =>
            s.points.map((v, i) =>
              v === null ? null : (
                <circle
                  key={`${s.name}-${i}`}
                  cx={xCoord(i, s.points.length, width)}
                  cy={scaleY(v, max, height)}
                  r="2.5"
                  fill={`var(--${s.colorVar})`}
                  data-testid="line-chart-point"
                />
              ),
            ),
          )}
        </svg>
      )}
      {!isEmpty && (
        <div className="flex justify-between text-[10.5px] text-faint">
          <span>{xLabels[0]}</span>
          <span className="font-mono">max {formatY(max)}</span>
          <span>{xLabels[xLabels.length - 1]}</span>
        </div>
      )}
    </div>
  );
}
