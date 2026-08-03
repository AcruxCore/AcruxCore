import { useEffect, useState } from 'react';
import type { MessageRole } from '@/api';
import { ApiError, useCommitVersion, usePrompts } from '@/api';
import { Button, Dialog, DialogFooter, Field, Select, useToast } from '@/ui';

export interface SaveVersionDialogProps {
  messages: { role: MessageRole; content: string }[];
  open: boolean;
  onClose: () => void;
  /** Pre-selects this prompt when opened (e.g. the one loaded in stored-prompt mode). */
  defaultPromptId?: string | null;
  /** Registered models to choose a default from (#12). */
  models?: { id: string; publicName: string }[];
  /** Pre-selects this model as the version's default when opened (#12). */
  defaultModel?: string | null;
  onSaved: (promptId: string, name: string, versionNumber: number) => void;
}

/**
 * "Save as a new version of an existing prompt" dialog for the Playground.
 *
 * Lets the user commit the current editor messages as a new version of ANY of
 * the team's prompts — the piece the quick "New version of <loaded>" action
 * can't cover, since it only targets the prompt open in stored-prompt mode.
 * This is what lets you compose freely (even in Messages mode) and then update
 * an existing prompt.
 */
export function SaveVersionDialog({
  messages,
  open,
  onClose,
  defaultPromptId,
  models,
  defaultModel,
  onSaved,
}: SaveVersionDialogProps) {
  const toast = useToast();
  const { data: promptPage } = usePrompts({ page: 1 });
  const prompts = promptPage?.data;
  const commit = useCommitVersion();
  const [promptId, setPromptId] = useState('');
  const [model, setModel] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Seed the picker each time it opens: prefer the caller's default, else the
  // first prompt. Re-runs on open so a stale selection never lingers.
  useEffect(() => {
    if (!open) return;
    if (defaultPromptId) setPromptId(defaultPromptId);
    else if (prompts && prompts.length > 0) setPromptId(prompts[0].id);
  }, [open, defaultPromptId, prompts]);

  // Seed the default-model selector from the model the user is testing with (#12).
  useEffect(() => {
    if (!open) return;
    setModel(defaultModel ?? '');
  }, [open, defaultModel]);

  const saving = commit.isPending;

  function handleClose() {
    setError(null);
    onClose();
  }

  async function handleSave() {
    if (!promptId) {
      setError('Pick a prompt to update.');
      return;
    }
    setError(null);
    try {
      const v = await commit.mutateAsync({ promptId, messages, model: model || null });
      const name = prompts?.find((p) => p.id === promptId)?.name ?? 'prompt';
      toast.success(`→ ${name} v${v.versionNumber}`, { href: `/prompts/${promptId}` });
      onSaved(promptId, name, v.versionNumber);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save version.');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && handleClose()}
      title="Save as a new version"
      description="Commits these messages as a new version of the prompt you pick."
    >
      {prompts && prompts.length === 0 ? (
        <p className="text-[13px] text-muted">
          You have no prompts yet — use “Save as new prompt” instead.
        </p>
      ) : (
        <Field label="Prompt" htmlFor="save-version-prompt" error={error ?? undefined}>
          <Select
            id="save-version-prompt"
            value={promptId}
            onChange={(e) => setPromptId(e.target.value)}
            className="font-mono"
          >
            {prompts?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {models && models.length > 0 && (
        <Field label="Default model" htmlFor="save-version-model">
          <Select
            id="save-version-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="font-mono"
          >
            <option value="">No default model</option>
            {models.map((m) => (
              <option key={m.id} value={m.publicName}>
                {m.publicName}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={handleClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={saving || !promptId}
          onClick={handleSave}
        >
          {saving ? 'Saving…' : 'Save version'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
