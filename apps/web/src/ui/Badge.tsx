import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Tone = 'default' | 'prod' | 'staging' | 'muted';

export interface BadgeProps {
  tone?: Tone;
  /** Show a small status dot before the content. */
  dot?: boolean;
  className?: string;
  children: ReactNode;
}

const TONES: Record<Tone, { box: string; dot: string }> = {
  default: { box: 'border-line text-muted', dot: 'bg-muted' },
  prod: { box: 'border-accent/45 text-ink', dot: 'bg-accent shadow-[0_0_8px_var(--accent-dim)]' },
  staging: { box: 'border-warn/45 text-ink', dot: 'bg-warn' },
  muted: { box: 'border-line text-faint', dot: 'bg-faint' },
};

/**
 * Pill badge, used for alias status (`production`, `staging`) and small labels.
 *
 * @param tone - Color intent. `prod` uses the accent, `staging` uses amber.
 * @param dot - Whether to render a leading status dot.
 */
export function Badge({ tone = 'default', dot, className, children }: BadgeProps) {
  const t = TONES[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-full border bg-surface px-2.5 py-1',
        'font-mono text-[12px] font-medium',
        t.box,
        className,
      )}
    >
      {dot && <span className={cn('h-1.5 w-1.5 rounded-full', t.dot)} />}
      {children}
    </span>
  );
}
