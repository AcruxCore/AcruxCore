import { useEffect, useState } from 'react';
import { ApiError, useCreateTool } from '@/api';
import { Button, Dialog, DialogFooter, Field, Input, Textarea, useToast } from '@/ui';

/** Tool names must match the server's re-validated pattern (letters, digits, `_`/`-`, 1-64 chars). */
const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export interface ToolDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Create-tool dialog: collects a tool's name and optional description. A tool
 * created here has no versions yet — the caller commits one afterwards from
 * the tool's detail page via {@link CommitVersionDialog}, which is where the
 * parameters schema and executor are actually defined.
 *
 * @param open - Whether the dialog is visible.
 * @param onOpenChange - Called to open/close the dialog.
 */
export function ToolDialog({ open, onOpenChange }: ToolDialogProps) {
  const toast = useToast();
  const create = useCreateTool();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  // Reset the form every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setName('');
    setDescription('');
  }, [open]);

  const trimmedName = name.trim();
  const nameValid = NAME_PATTERN.test(trimmedName);
  const canSubmit = trimmedName.length > 0 && nameValid;

  async function handleSubmit() {
    try {
      const tool = await create.mutateAsync({
        name: trimmedName,
        description: description.trim() || undefined,
      });
      toast.success(`Tool "${tool.name}" created`);
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not create tool');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New tool"
      description="Give the tool a stable name. Commit a version afterwards to define its parameters and executor."
    >
      <div className="flex flex-col gap-3">
        <Field
          label="Name"
          htmlFor="tool-name"
          hint="Letters, numbers, underscore, and dash only (max 64 characters)."
          error={
            trimmedName.length > 0 && !nameValid
              ? 'Invalid name — use only letters, numbers, _ and -.'
              : undefined
          }
        >
          <Input
            id="tool-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="get_weather"
          />
        </Field>

        <Field
          label="Description"
          htmlFor="tool-description"
          hint="Optional — shown to the model as the tool's summary."
        >
          <Textarea
            id="tool-description"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Fetches the current weather for a location."
          />
        </Field>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={create.isPending || !canSubmit} onClick={handleSubmit}>
          {create.isPending ? 'Creating…' : 'Create tool'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
