import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'default' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-accent text-accent-ink border-accent hover:brightness-110 font-semibold',
  default: 'bg-surface text-ink border-line hover:border-faint',
  ghost: 'bg-transparent text-muted border-transparent hover:text-ink hover:bg-elevated',
  danger:
    'bg-transparent text-danger border-line hover:border-danger hover:bg-danger-bg',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-9 px-3.5 text-[13px]',
};

/**
 * Primary button primitive with variants and sizes.
 *
 * @param variant - Visual weight; `primary` is the accent action. Defaults to `default`.
 * @param size - `sm` or `md` (default).
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md border font-medium',
        'transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    />
  );
});
