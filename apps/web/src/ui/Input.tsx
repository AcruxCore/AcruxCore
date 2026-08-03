import { forwardRef } from 'react';
import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

const base =
  'w-full rounded-md border border-line bg-bg px-3 py-2 text-[13px] text-ink ' +
  'placeholder:text-faint focus:border-accent focus:outline-none disabled:opacity-50';

/** Single-line text input. */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cn(base, className)} {...rest} />;
  },
);

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Render with the monospace content face (for template editing). */
  mono?: boolean;
}

/** Multi-line text input; `mono` switches to the monospace content face. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, mono, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cn(base, 'resize-y leading-relaxed', mono && 'font-mono', className)}
      {...rest}
    />
  );
});
