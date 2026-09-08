import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Tone = 'muted' | 'danger';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required — the control has no visible text, so this is its only name. */
  'aria-label': string;
  /** `danger` turns red on hover; use it for anything that removes something. */
  tone?: Tone;
  children: ReactNode;
}

const TONES: Record<Tone, string> = {
  muted: 'text-faint hover:text-ink hover:bg-elevated',
  danger: 'text-faint hover:text-danger hover:bg-danger-bg',
};

/**
 * A square, icon-only control for a table row.
 *
 * Kept visible rather than revealed on hover: a hover-only control does not
 * exist on a touch screen, and a row action nobody can find is the same as one
 * that is not there. It sits at low contrast instead, so a table of twenty rows
 * does not read as twenty buttons, and comes forward on hover and on keyboard
 * focus.
 *
 * `title` mirrors `aria-label` automatically, so a pointer user gets the same
 * name a screen reader does without the caller writing it twice.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { tone = 'muted', className, children, type = 'button', title, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      title={title ?? rest['aria-label']}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded-md border border-transparent transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
        'disabled:pointer-events-none disabled:opacity-40',
        TONES[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

/** Shared frame for the 24px stroke icons below, matching the sidebar's set. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Delete. A bin, not an ✕ — an ✕ reads as "close this", not "remove this row". */
export function TrashIcon() {
  return (
    <Icon>
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </Icon>
  );
}

/** Edit in place. */
export function PencilIcon() {
  return (
    <Icon>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </Icon>
  );
}
