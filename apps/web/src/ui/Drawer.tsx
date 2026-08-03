import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Required accessible name, rendered as the panel heading. */
  title: string;
  /** Optional supporting line under the title. */
  description?: string;
  children: ReactNode;
  className?: string;
}

/**
 * A right-anchored slide-over panel for contextual detail (e.g. a selected span).
 * Built on the same `@radix-ui/react-dialog` primitive as `Dialog`, so it inherits
 * focus-trap, Escape-to-close, and overlay-click dismiss for free; the slide-in
 * animation is skipped under `prefers-reduced-motion`.
 *
 * @param open - Whether the drawer is visible.
 * @param onOpenChange - Called with the next open state (Radix fires this on Esc, overlay click, or the close button).
 * @param title - Required accessible name, rendered as the panel heading.
 * @param description - Optional supporting line under the title.
 * @param children - Panel body content, scrollable independently of the header.
 * @param className - Extra classes merged onto the Radix `Content` panel.
 * @returns A portal-rendered right-side panel.
 */
export function Drawer({ open, onOpenChange, title, description, children, className }: DrawerProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in motion-reduce:animate-none" />
        <DialogPrimitive.Content
          data-testid="drawer-content"
          className={cn(
            'fixed right-0 top-0 z-50 flex h-full w-full max-w-[560px] flex-col border-l border-line bg-surface shadow-xl outline-none',
            'data-[state=open]:animate-in data-[state=open]:slide-in-from-right motion-reduce:animate-none',
            className,
          )}
        >
          <div className="flex items-start gap-3 border-b border-line-soft px-5 py-4">
            <div className="min-w-0">
              <DialogPrimitive.Title className="truncate text-[15px] font-semibold">{title}</DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="mt-0.5 text-[12px] text-muted">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close
              className="ml-auto rounded-md px-2 py-1 text-muted hover:bg-elevated"
              aria-label="Close"
              data-testid="drawer-close"
            >
              ✕
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
