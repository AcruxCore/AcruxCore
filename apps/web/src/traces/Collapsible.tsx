import { useState, type ReactNode } from 'react';

export interface CollapsibleProps {
  label: string;
  children: ReactNode;
  defaultOpen?: boolean;
  testId?: string;
}

/** A label + chevron toggle that shows/hides its children. Collapsed by default. */
export function Collapsible({ label, children, defaultOpen = false, testId }: CollapsibleProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div data-testid={testId}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 text-left text-[11px] font-medium uppercase tracking-[0.06em] text-faint"
      >
        {label}
        <span className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden>
          ›
        </span>
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  );
}
