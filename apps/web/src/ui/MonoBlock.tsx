import { useLayoutEffect, useRef, useState } from 'react';
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
 * Expanding grows the block to a taller bounded box that scrolls, rather than
 * removing the cap: an uncapped payload pushed everything below it off the
 * screen, which is the opposite of what "expand" should do.
 *
 * The toggle only renders when there is something hidden. A value that already
 * fits gets no button, because a button that visibly does nothing reads as a
 * broken feature.
 *
 * @param value - Raw string to render inside a `<pre>`. Callers pre-serialize JSON.
 * @param label - Optional caption rendered above the block.
 * @param collapsible - When true (default), bounds the block's height and shows an expand/collapse toggle.
 * @param className - Extra classes merged onto the root wrapper.
 * @returns A labeled, monospace `<pre>` block with an optional collapse toggle.
 */
export function MonoBlock({ value, label, collapsible = true, className }: MonoBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  // Measured rather than guessed from the string's length: whether a value
  // overflows depends on wrapping and on the panel's width, not on how many
  // characters it has. Only measured while collapsed — once expanded, the cap
  // is what the box is showing, so re-measuring would hide the Collapse button.
  useLayoutEffect(() => {
    if (!collapsible || expanded) return;
    const el = preRef.current;
    if (!el) return;
    setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [value, collapsible, expanded]);

  const showToggle = collapsible && (overflows || expanded);

  return (
    <div className={cn('flex flex-col gap-1', className)} data-testid="mono-block">
      {label && <div className="text-[11px] uppercase tracking-[0.06em] text-faint">{label}</div>}
      <pre
        ref={preRef}
        className={cn(
          'overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-line-soft bg-bg px-3 py-2 font-mono text-[12px] leading-relaxed text-ink',
          collapsible && (expanded ? 'max-h-[70vh] overflow-y-auto' : 'max-h-56 overflow-y-hidden'),
        )}
      >
        {value}
      </pre>
      {showToggle && (
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
