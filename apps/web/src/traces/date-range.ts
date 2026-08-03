/** A quick date-range choice for the dashboards' `group_by=day` view, or `'custom'` for manual from/to inputs. */
export type DateRangePreset = '7d' | '30d' | '90d' | 'mtd' | 'ytd' | 'custom';

/** Options for the range `<Select>`, in display order. */
export const DATE_RANGE_PRESETS: { value: DateRangePreset; label: string }[] = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'mtd', label: 'Month to date' },
  { value: 'ytd', label: 'Year to date' },
  { value: 'custom', label: 'Custom range' },
];

/** `YYYY-MM-DD` in UTC — matches `<input type="date">` and the API's date-only params. */
function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The `from` date-only string for a preset, anchored to `now`. Recomputed on every
 * call rather than frozen into the URL, so e.g. "Last 30 days" always means the 30
 * days ending today whenever the link is opened, not the day it was first picked.
 * Returns `null` for `'custom'` — the caller falls back to the user's own manual
 * `from` input in that case.
 *
 * @param preset - The chosen preset.
 * @param now - Injectable clock for tests; defaults to the real current time.
 * @returns A `YYYY-MM-DD` string, or `null` for `'custom'`.
 */
export function presetFrom(preset: DateRangePreset, now = new Date()): string | null {
  switch (preset) {
    case '7d':
      return toDateOnly(new Date(now.getTime() - 7 * 86_400_000));
    case '30d':
      return toDateOnly(new Date(now.getTime() - 30 * 86_400_000));
    case '90d':
      return toDateOnly(new Date(now.getTime() - 90 * 86_400_000));
    case 'mtd':
      return toDateOnly(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
    case 'ytd':
      return toDateOnly(new Date(Date.UTC(now.getUTCFullYear(), 0, 1)));
    case 'custom':
      return null;
  }
}
