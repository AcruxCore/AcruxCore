import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';
import { useClickOutside } from './useClickOutside';

/** Panel width in px. Must match the `w-64` below — the clamp maths needs the number. */
const PANEL_WIDTH = 256;
/** Gap between the trigger and the panel, and the minimum gap to a viewport edge. */
const OFFSET = 6;

export interface InfoTipProps {
  /** Optional bold first line, for a tip whose body needs a name. */
  heading?: string;
  /** The explanation itself. Kept as nodes so a tip can use `<code>`. */
  children: ReactNode;
  /**
   * Which edge of the panel lines up with the trigger. Use `'right'` for a
   * trigger near the right of the screen; either way the panel is clamped
   * inside the viewport, so this only decides the preferred side.
   */
  align?: 'left' | 'right';
  /** Screen-reader name for the trigger; say what it explains. */
  label: string;
}

/**
 * A small `i` button that reveals a short explanation on hover, focus or tap.
 *
 * Built in-house because this UI kit has no tooltip primitive, and the one
 * earlier attempt used a native `title` attribute, which cannot be read on a
 * touch device, cannot be styled, and appears too slowly to be noticed. Opens
 * on hover for a mouse and on focus for a keyboard; a tap pins it open, which
 * is the only way a touch device can reach it at all.
 *
 * The panel is rendered through a portal at `position: fixed` rather than
 * absolutely inside the trigger. An absolute panel is clipped by any scroll
 * container it sits in — including a table wrapped in `overflow-x-auto`, which
 * clips vertically too — and a column-header tip is exactly that case.
 *
 * Intended for a sentence or two of genuinely non-obvious context: a column
 * whose emptiness means something, a default that surprises people. Anything
 * longer belongs in the docs, with a link to it.
 */
export function InfoTip({ heading, children, align = 'left', label }: InfoTipProps) {
  const [hovering, setHovering] = useState(false);
  const [pinned, setPinned] = useState(false);
  // Escape must close a tooltip even though the pointer and the focus are both
  // still on the trigger, which would otherwise re-open it immediately. Cleared
  // as soon as either one leaves, so the next hover works normally.
  const [dismissed, setDismissed] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useClickOutside(rootRef, () => setPinned(false));

  const open = (hovering || pinned) && !dismissed;

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const preferred = align === 'right' ? rect.right - PANEL_WIDTH : rect.left;
    setPosition({
      top: rect.bottom + OFFSET,
      left: Math.max(OFFSET, Math.min(preferred, window.innerWidth - PANEL_WIDTH - OFFSET)),
    });
  }, [align]);

  // Placed before paint so the panel never renders at the wrong coordinates first.
  useLayoutEffect(() => {
    if (open) place();
    else setPosition(null);
  }, [open, place]);

  // A fixed panel does not travel with the trigger, so follow anything that
  // moves it. `capture` is what catches a scroll inside the table, not just the
  // window's — a scroll event from an element does not bubble.
  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  return (
    <span
      ref={rootRef}
      className="relative inline-flex"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => {
        setHovering(false);
        setDismissed(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-describedby={open ? panelId : undefined}
        aria-expanded={pinned}
        className="flex h-4 w-4 items-center justify-center rounded-full text-faint transition-colors hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
        onClick={() => {
          setDismissed(false);
          setPinned((p) => !p);
        }}
        onFocus={() => setHovering(true)}
        onBlur={() => {
          setHovering(false);
          setDismissed(false);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          // Stop the key reaching an enclosing dialog or drawer, which would
          // close the whole thing when the reader only meant to close the tip.
          e.stopPropagation();
          setPinned(false);
          setDismissed(true);
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5">
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <circle cx="8" cy="5.1" r="0.85" fill="currentColor" />
          <path d="M8 7.4v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
      {open &&
        position &&
        createPortal(
          <span
            id={panelId}
            role="tooltip"
            style={{ top: position.top, left: position.left, width: PANEL_WIDTH }}
            className={cn(
              // The explicit type resets undo an uppercased table header: the
              // trigger inherits the header's type, the panel must not.
              'fixed z-50 block rounded-md border border-line bg-elevated p-2.5',
              'text-[12px] font-normal normal-case leading-[1.5] tracking-normal text-muted shadow-lg',
            )}
          >
            {heading && <span className="mb-1 block font-medium text-ink">{heading}</span>}
            {children}
          </span>,
          document.body,
        )}
    </span>
  );
}
