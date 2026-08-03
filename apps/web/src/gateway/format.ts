import type { ProviderKind } from '@/api';

/** Human labels for provider kinds (the API stores the snake_case value). */
export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  openai_compatible: 'OpenAI-compatible',
};

/**
 * Format a USD amount for display. Gateway costs are routinely sub-cent, so
 * small values reveal enough decimal places to be non-zero rather than rounding
 * to `$0.00`.
 *
 * @param n - Dollar amount, or `null`/`undefined` when a model has no price.
 */
export function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n === 0) return '$0';
  if (n < 0.01) {
    const places = Math.min(9, Math.max(2, -Math.floor(Math.log10(n)) + 2));
    return '$' + n.toFixed(places);
  }
  return '$' + n.toFixed(n < 1 ? 4 : 2);
}

/** Compact integer with thousands separators (token counts, request counts). */
export function formatCount(n: number): string {
  return n.toLocaleString();
}

/** Render a `[0, 1]` fraction as a whole-number percent, e.g. `0.42` → `42%`. */
export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** Format a latency in milliseconds, switching to seconds past 1000ms. */
export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
