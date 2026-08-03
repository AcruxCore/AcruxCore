import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Prompt } from '@/api';
import { ApiError, useDeletePrompt, useUpdatePrompt } from '@/api';
import { Button, Dialog, DialogFooter, Field, Input, Textarea, useToast } from '@/ui';

/** Edit a prompt's name/description, or delete it. Owner/admin/editor only. */
export function PromptSettingsDialog({
  prompt,
  open,
  onOpenChange,
}: {
  prompt: Prompt;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const update = useUpdatePrompt(prompt.id);
  const del = useDeletePrompt();
  const [name, setName] = useState(prompt.name);
  const [description, setDescription] = useState(prompt.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function save() {
    setError(null);
    try {
      await update.mutateAsync({
        name: name.trim(),
        description: description.trim() || null,
      });
      toast.success('Prompt updated');
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not update prompt.');
    }
  }

  async function remove() {
    try {
      await del.mutateAsync(prompt.id);
      toast.success('Prompt deleted');
      navigate('/prompts', { replace: true });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not delete prompt.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Prompt settings">
      <div className="flex flex-col gap-4">
        <Field
          label="Name"
          htmlFor="edit-name"
          error={error ?? undefined}
          hint="Renaming changes the SDK lookup key — existing callers will break."
        >
          <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description" htmlFor="edit-desc">
          <Textarea
            id="edit-desc"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        <div className="mt-1 rounded-md border border-danger/40 p-3">
          {!confirmDelete ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-[12.5px] text-muted">Delete this prompt and its versions.</span>
              <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <span className="text-[12.5px] text-danger">This can't be undone.</span>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
                <Button size="sm" variant="danger" disabled={del.isPending} onClick={remove}>
                  {del.isPending ? 'Deleting…' : 'Delete prompt'}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Close
        </Button>
        <Button variant="primary" disabled={update.isPending} onClick={save}>
          {update.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
