import * as RD from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  className?: string;
  children: ReactNode;
}

/**
 * Accessible modal dialog (focus trap + Escape + overlay dismiss via Radix).
 *
 * @param title - Required accessible title, rendered as the heading.
 * @param description - Optional supporting line under the title.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  className,
  children,
}: DialogProps) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[2px] data-[state=open]:animate-in" />
        <RD.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2',
            'rounded-xl border border-line bg-surface p-5 shadow-2xl focus:outline-none',
            className,
          )}
        >
          <RD.Title className="text-[15px] font-semibold text-ink">{title}</RD.Title>
          {description && (
            <RD.Description className="mt-1 text-[13px] text-muted">
              {description}
            </RD.Description>
          )}
          <div className="mt-4">{children}</div>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

/** Right-aligned footer row for dialog actions. */
export function DialogFooter({ children }: { children: ReactNode }) {
  return <div className="mt-5 flex justify-end gap-2">{children}</div>;
}
