import { cn } from '@/lib/cn';

export interface SpinnerProps {
  className?: string;
  /** Accessible label; defaults to "Loading". */
  label?: string;
}

/** Indeterminate loading spinner. */
export function Spinner({ className, label = 'Loading' }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn(
        'inline-block h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent',
        className,
      )}
    />
  );
}

/** Full-height centered spinner for page/route-level loading. */
export function PageSpinner() {
  return (
    <div className="flex h-full min-h-[240px] w-full items-center justify-center">
      <Spinner className="h-6 w-6" />
    </div>
  );
}
