import { Button, Dialog, DialogFooter } from '@/ui';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** What is about to happen, and what it costs. Say the irreversible part out loud. */
  description: string;
  /** Label for the destructive action. Name the act ("Delete dataset"), never "OK". */
  confirmLabel: string;
  pending?: boolean;
  onConfirm: () => void;
}

/**
 * A yes/no gate in front of one destructive action.
 *
 * Deleting a dataset or an example cannot be undone from the dashboard, and
 * both sit one click away from things a person clicks all day, so neither may
 * fire straight from its row button.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pending,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={description}>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="danger" disabled={pending} onClick={onConfirm} data-testid="confirm-destructive">
          {pending ? 'Working…' : confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
