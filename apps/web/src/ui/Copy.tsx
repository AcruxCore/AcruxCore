import { useState } from 'react';
import { cn } from '@/lib/cn';

export interface CopyButtonProps {
  value: string;
  className?: string;
  /** Label shown before copying. Defaults to "Copy". */
  label?: string;
}

/**
 * Button that copies `value` to the clipboard and briefly confirms.
 *
 * @param value - Text to copy.
 * @param label - Idle label (default "Copy"); switches to "Copied" for 1.5s.
 */
export function CopyButton({ value, className, label = 'Copy' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard may be blocked; no-op — the value is still visible to select.
        }
      }}
      className={cn(
        'rounded-md border border-line px-2.5 py-1.5 text-[12px] font-medium text-muted',
        'transition-colors hover:border-faint hover:text-ink',
        className,
      )}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}
