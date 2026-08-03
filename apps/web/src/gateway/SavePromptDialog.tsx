import { useState } from 'react';
import type { MessageRole } from '@/api';
import { ApiError, useCommitVersion, useCreatePrompt } from '@/api';
import { Button, Dialog, DialogFooter, Field, Input, useToast } from '@/ui';

export interface SavePromptDialogProps {
  messages: { role: MessageRole; content: string }[];
  open: boolean;
  onClose: () => void;
  onSaved: (promptId: string, name: string) => void;
}

/**
 * "Save as new prompt" dialog for the Playground. Creates a prompt shell from
 * a name, then immediately commits the current editor messages as its v1 —
 * so the new prompt is never left without content.
 */
export function SavePromptDialog({ messages, open, onClose, onSaved }: SavePromptDialogProps) {
  const toast = useToast();
  const create = useCreatePrompt();
  const commit = useCommitVersion();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const saving = create.isPending || commit.isPending;

  function handleClose() {
    setName('');
    setError(null);
    onClose();
  }

  async function handleSave() {
    if (!trimmed) {
      setError('Name is required.');
      return;
    }
    setError(null);
    try {
      const prompt = await create.mutateAsync({ name: trimmed });
      await commit.mutateAsync({ promptId: prompt.id, messages });
      toast.success(`Saved "${prompt.name}" v1`, { href: `/prompts/${prompt.id}` });
      onSaved(prompt.id, prompt.name);
      setName('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save prompt.');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && handleClose()}
      title="Save as new prompt"
      description="Creates a new prompt and commits these messages as its first version."
    >
      <Field label="Name" htmlFor="save-prompt-name" error={error ?? undefined}>
        <Input
          id="save-prompt-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="greeting"
          autoFocus
        />
      </Field>
      <DialogFooter>
        <Button variant="ghost" onClick={handleClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={saving} onClick={handleSave}>
          {saving ? 'Saving…' : 'Save prompt'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
