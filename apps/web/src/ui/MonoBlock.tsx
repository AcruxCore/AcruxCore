import { useState } from 'react';
import { cn } from '@/lib/cn';

export interface MonoBlockProps {
  /** Raw string to display. For JSON, pass JSON.stringify(value, null, 2). */
  value: string;
  /** Optional caption shown above the block. */
  label?: string;
  /** Collapse to a fixed max height with a toggle when true. Default true. */
  collapsible?: boolean;
  className?: string;
}

/**
 * Renders preformatted, read-only monospace content (payload JSON, ids). Long values
 * collapse to a bounded height with an expand/collapse toggle so a big payload never
 * pushes the drawer content off-screen.
 *
 * @param value - Raw string to render inside a `<pre>`. Callers pre-serialize JSON.
 * @param label - Optional caption rendered above the block.
 * @param collapsible - When true (default), bounds the block's height and shows an expand/collapse toggle.
 * @param className - Extra classes merged onto the root wrapper.
 * @returns A labeled, monospace `<pre>` block with an optional collapse toggle.
 */
export function MonoBlock({ value, label, collapsible = true, className }: MonoBlockProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={cn('flex flex-col gap-1', className)} data-testid="mono-block">
      {label && <div className="text-[11px] uppercase tracking-[0.06em] text-faint">{label}</div>}
      <pre
        className={cn(
          'overflow-x-auto rounded-lg border border-line-soft bg-bg px-3 py-2 font-mono text-[12px] leading-relaxed text-ink',
          collapsible && !expanded && 'max-h-56 overflow-y-hidden',
        )}
      >
        {value}
      </pre>
      {collapsible && (
        <button
          type="button"
          className="self-start text-[12px] text-accent hover:underline"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          data-testid="mono-block-toggle"
        >
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      )}
    </div>
  );
}
