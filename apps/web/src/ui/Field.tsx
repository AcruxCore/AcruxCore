import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface FieldProps {
  label: string;
  htmlFor?: string;
  error?: string;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}

/**
 * Labelled form field wrapper with an optional hint and validation error.
 *
 * @param label - Visible field label.
 * @param error - Error message shown in danger color when present.
 * @param hint - Secondary helper text shown when there is no error.
 */
export function Field({ label, htmlFor, error, hint, className, children }: FieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-[12px] text-danger">{error}</p>
      ) : hint ? (
        <p className="text-[12px] text-faint">{hint}</p>
      ) : null}
    </div>
  );
}
