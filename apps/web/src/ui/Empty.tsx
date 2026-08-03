import type { ReactNode } from 'react';

export interface EmptyProps {
  title: string;
  description?: string;
  action?: ReactNode;
}

/** Centered empty-state block for lists with no data yet. */
export function Empty({ title, description, action }: EmptyProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line px-6 py-14 text-center">
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {description && (
        <p className="max-w-sm text-[13px] text-muted">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
