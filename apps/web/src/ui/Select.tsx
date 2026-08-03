import { forwardRef } from 'react';
import type { SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

const base =
  'w-full appearance-none rounded-md border border-line bg-bg px-3 py-2 pr-8 text-[13px] text-ink ' +
  'focus:border-accent focus:outline-none disabled:opacity-50';

/**
 * Native select styled to match {@link Input}, with a custom chevron so it reads
 * as part of the same form system across light/dark themes.
 */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <div className="relative">
        <select ref={ref} className={cn(base, className)} {...rest}>
          {children}
        </select>
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-faint"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>
    );
  },
);
