import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, useCreatePrompt } from '@/api';
import { Button, Dialog, DialogFooter, Field, Input, Textarea, useToast } from '@/ui';

export interface PromptCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing prompt names in the team, for a soft duplicate warning. */
  existingNames: string[];
}

/** Create-prompt dialog. On success, navigates to the new prompt's detail page. */
export function PromptCreateDialog({ open, onOpenChange, existingNames }: PromptCreateDialogProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const create = useCreatePrompt();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const duplicate = trimmed.length > 0 && existingNames.includes(trimmed);

  async function handleCreate() {
    if (!trimmed) {
      setError('Name is required.');
      return;
    }
    setError(null);
    try {
      const prompt = await create.mutateAsync({
        name: trimmed,
        description: description.trim() || undefined,
      });
      toast.success(`Created "${prompt.name}"`);
      onOpenChange(false);
      setName('');
      setDescription('');
      navigate(`/prompts/${prompt.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not create prompt.');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New prompt"
      description="A prompt holds versioned message templates. You'll add content next."
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Name"
          htmlFor="prompt-name"
          error={error ?? undefined}
          hint={
            duplicate
              ? 'A prompt with this name already exists — the SDK fetches by name, so duplicates are ambiguous.'
              : 'Used as the SDK lookup key. Lowercase with hyphens works well.'
          }
        >
          <Input
            id="prompt-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="greeting"
            autoFocus
          />
        </Field>
        <Field label="Description" htmlFor="prompt-desc" hint="Optional">
          <Textarea
            id="prompt-desc"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this prompt is for."
          />
        </Field>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={create.isPending} onClick={handleCreate}>
          {create.isPending ? 'Creating…' : 'Create prompt'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
