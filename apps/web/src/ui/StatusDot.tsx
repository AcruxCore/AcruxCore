import { cn } from '@/lib/cn';
import type { SpanStatus } from '@/api/types';

export interface StatusDotProps {
  /** Span/trace status to render. */
  status: SpanStatus;
  /** Hide the text label (dot only). Default false — a label is shown for accessibility. */
  dotOnly?: boolean;
  className?: string;
}

const META: Record<SpanStatus, { dot: string; text: string; label: string }> = {
  ok: { dot: 'bg-ok', text: 'text-ok', label: 'OK' },
  error: { dot: 'bg-danger', text: 'text-danger', label: 'Error' },
  unset: { dot: 'bg-faint', text: 'text-faint', label: 'Unset' },
};

/**
 * A status indicator: a small colored dot plus its text label so meaning never
 * relies on hue alone (WCAG 1.4.1). Used across the trace list, detail header, and
 * span rows.
 *
 * @param status - Which status to render (`ok` | `error` | `unset`); selects the token color and label.
 * @param dotOnly - When true, renders only the dot (no visible text). The status label is still exposed
 *   via `aria-label` so the indicator keeps an accessible name. Default false.
 * @param className - Extra classes merged onto the root `<span>`.
 * @returns A `<span>` containing the colored dot and, unless `dotOnly`, its text label.
 */
export function StatusDot({ status, dotOnly = false, className }: StatusDotProps) {
  const m = META[status];
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-[13px]', className)}
      data-testid="status-dot"
      data-status={status}
      aria-label={dotOnly ? m.label : undefined}
    >
      <span className={cn('h-2 w-2 rounded-full', m.dot)} aria-hidden />
      {!dotOnly && <span className={m.text}>{m.label}</span>}
    </span>
  );
}
