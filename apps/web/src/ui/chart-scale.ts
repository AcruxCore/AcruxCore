/**
 * Pure, DOM-free scaling/geometry helpers for the hand-rolled SVG charts
 * ({@link LineChart}, {@link BarChart}). No React, no browser APIs — safe to
 * unit test with plain numbers and to reuse from either chart component.
 */

/**
 * Rounds a max value up to a "nice" axis bound (1, 2, 5 × 10^n). Never returns 0,
 * so a flat/zero series still gets a sane axis instead of a degenerate scale.
 *
 * @param max - The largest value the axis must accommodate; may be 0 or negative.
 * @returns A clean ceiling ≥ 1 that is ≥ `max`.
 */
export function niceCeil(max: number): number {
  if (max <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const n = max / pow;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return nice * pow;
}

/**
 * Maps a value in `[0, max]` to a y pixel with the origin at the bottom (inverted
 * SVG y-axis, since SVG y grows downward but chart values grow upward).
 *
 * @param value - The data value to place.
 * @param max - The axis ceiling (from {@link niceCeil}); a non-positive max is
 *   treated as "no range" and always bottoms out, avoiding a divide-by-zero.
 * @param height - The plot area height in SVG user units (pixels).
 * @returns The y coordinate: `height` (bottom) at `value = 0`, `0` (top) at `value = max`.
 */
export function scaleY(value: number, max: number, height: number): number {
  if (max <= 0) return height;
  return height - (value / max) * height;
}

/**
 * Evenly spaces the i-th of n points across a width. A single point (or an empty
 * series, where the caller still needs a coordinate for index 0) collapses to the
 * left edge rather than dividing by zero.
 *
 * @param i - Zero-based point index.
 * @param n - Total number of points in the series.
 * @param width - The plot area width in SVG user units (pixels).
 * @returns The x coordinate for point `i`.
 */
export function xCoord(i: number, n: number, width: number): number {
  if (n <= 1) return 0;
  return (i / (n - 1)) * width;
}

/**
 * Builds an SVG path (`M…L…`) for a polyline of values scaled to `[0, max]`.
 * `null` values (e.g. a latency percentile bucket with no timed spans) break the
 * line into a gap instead of being plotted as `NaN`: the point is skipped, and the
 * next real value starts a fresh `M` (moveto) rather than continuing with `L`.
 *
 * @param values - The series values, left to right; `null` marks a missing point.
 * @param max - The axis ceiling shared by every point (from {@link niceCeil}).
 * @param width - The plot area width in SVG user units (pixels).
 * @param height - The plot area height in SVG user units (pixels).
 * @returns The SVG path `d` string; `''` for an empty series.
 */
export function linePath(values: (number | null)[], max: number, width: number, height: number): string {
  const n = values.length;
  let d = '';
  let atGap = true; // true until the first real point is drawn, and again right after a null
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v === null) {
      atGap = true;
      continue;
    }
    const x = xCoord(i, n, width);
    const y = scaleY(v, max, height);
    const prefix = d === '' ? '' : ' ';
    const command = atGap ? 'M' : 'L';
    d += `${prefix}${command}${x},${y}`;
    atGap = false;
  }
  return d;
}
