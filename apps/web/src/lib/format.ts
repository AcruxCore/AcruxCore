/**
 * Format an ISO timestamp as a compact relative string, past or future
 * ("2h ago", "3d ago", "in 5d"), falling back to an absolute date beyond a week.
 *
 * @param iso - An ISO-8601 timestamp string.
 * @returns Human-readable relative time; "in …" for future timestamps (e.g. invite expiry).
 */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const deltaSecs = Math.round((Date.now() - then) / 1000);
  const future = deltaSecs < 0;
  const secs = Math.abs(deltaSecs);
  const phrase = (value: string) => (future ? `in ${value}` : `${value} ago`);

  if (secs < 45) return future ? 'in a moment' : 'just now';
  if (secs < 90) return phrase('1m');
  const mins = Math.round(secs / 60);
  if (mins < 60) return phrase(`${mins}m`);
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return phrase(`${hrs}h`);
  const days = Math.round(hrs / 24);
  if (days < 7) return phrase(`${days}d`);
  return new Date(iso).toLocaleDateString();
}

/**
 * Format an ISO timestamp as an absolute local date-time for tooltips/detail.
 *
 * @param iso - An ISO-8601 timestamp string.
 * @returns Locale date-time string, or empty string if unparseable.
 */
export function dateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}
