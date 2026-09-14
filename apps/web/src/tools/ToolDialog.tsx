import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, CreateToolError, useCreateToolWithVersion } from '@/api';
import { Button, Dialog, DialogFooter, Field, Input, useToast } from '@/ui';
import { TOOL_NAME_PATTERN } from './catalog';
import { ToolVersionFields } from './ToolVersionFields';
import type { VersionFormField, VersionFormState } from './version-form';
import { canCommitVersionForm, emptyVersionForm, versionFormToCommit } from './version-form';

export interface ToolDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Creates a tool and its first version in one pass.
 *
 * The two are one act for the user even though they are two writes on the wire. Asking
 * for the name alone produced a tool that looked finished in every list and resolved to
 * nothing: a prompt bound to it rendered with one tool fewer and said so nowhere, and
 * `tool_refs` answered "has no versions, so alias 'production' does not exist yet" for a
 * tool the dashboard had shown as created. Committing the first version here is what
 * makes "I made a tool" and "the model can call it" the same moment.
 *
 * @param open - Whether the dialog is visible.
 * @param onOpenChange - Called to open/close the dialog.
 */
export function ToolDialog({ open, onOpenChange }: ToolDialogProps) {
  const toast = useToast();
  const navigate = useNavigate();
  const create = useCreateToolWithVersion();

  const [name, setName] = useState('');
  const [form, setForm] = useState<VersionFormState>(emptyVersionForm);
  const [error, setError] = useState<{ field: VersionFormField; message: string } | null>(null);
  /**
   * Set when the shell was created but its version was refused. The name is taken now, so
   * a retry must commit onto that tool rather than create a second one.
   *
   * Deliberately NOT cleared by the reset-on-open effect below: closing the dialog
   * (Escape, to go fix an executor URL) and reopening it used to throw this away, so
   * retyping the exact same name POSTed a second shell and collided with the name the
   * first one already took. It is cleared only where {@link strandedActive} says it
   * should stop applying — see there.
   */
  const [strandedToolId, setStrandedToolId] = useState<string | undefined>();
  /** The name that was submitted when {@link strandedToolId} was set. See {@link strandedActive}. */
  const [strandedName, setStrandedName] = useState<string | undefined>();

  useEffect(() => {
    if (!open) return;
    setName('');
    setForm(emptyVersionForm());
    setError(null);
    // strandedToolId/strandedName intentionally survive this reset — see their
    // declaration above.
  }, [open]);

  const trimmedName = name.trim();
  const nameValid = TOOL_NAME_PATTERN.test(trimmedName);
  /**
   * Whether the stranded shell is still the right thing to commit onto. Recomputed from
   * the current name every render rather than cleared imperatively in an effect or an
   * `onChange` handler: a stranded `get_weather` must stop applying the moment the form
   * names something else (a stranded `get_weather` should not be committed onto when the
   * user comes back to create `get_forecast`), and — since this is derived, not a one-way
   * reset — retyping the exact original name (the documented retry path: close, go fix
   * the URL, reopen, retype the same name) reactivates it instead of losing the shell for
   * good.
   */
  const strandedActive = strandedToolId !== undefined && trimmedName === strandedName;
  const canSubmit = nameValid && canCommitVersionForm(form) && !create.isPending;

  async function handleSubmit() {
    const version = versionFormToCommit(form);
    if (!version.ok) {
      setError({ field: version.field, message: version.message });
      return;
    }

    try {
      const { toolId } = await create.mutateAsync({
        name: trimmedName,
        description: version.body.description,
        version: version.body,
        existingToolId: strandedActive ? strandedToolId : undefined,
      });
      // The dialog actually completed — the stranded shell (if any) is now a finished
      // tool, so its id must not be picked up again by a later, unrelated create.
      setStrandedToolId(undefined);
      setStrandedName(undefined);
      toast.success(`"${trimmedName}" is ready to call.`);
      onOpenChange(false);
      navigate(`/tools/${toolId}`);
    } catch (e) {
      if (e instanceof CreateToolError && e.stage === 'version' && e.toolId) {
        setStrandedToolId(e.toolId);
        setStrandedName(trimmedName);
        toast.error(
          `"${trimmedName}" was created, but its first version was refused: ${e.message} Fix it and save again — the tool is waiting.`,
        );
        return;
      }
      const cause = e instanceof CreateToolError ? e.cause : e;
      toast.error(cause instanceof ApiError ? cause.message : 'Could not create tool');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New tool"
      description="Name it, say what it does, and choose who runs it. This creates the tool and its first version, so the model can call it right away."
      className="max-w-2xl"
    >
      <div className="flex max-h-[65vh] flex-col gap-3 overflow-y-auto pr-1">
        <Field
          label="Name"
          htmlFor="tool-name"
          hint="What the model calls. Letters, numbers, underscore and dash only (max 64 characters)."
          error={
            trimmedName.length > 0 && !nameValid
              ? 'Invalid name — use only letters, numbers, _ and -.'
              : undefined
          }
        >
          <Input
            id="tool-name"
            value={name}
            // Not disabled while stranded: the user must be able to type a different name
            // to abandon the stranded shell (see `strandedActive`), and the documented
            // retry (retype the same name) needs the field editable to begin with.
            disabled={create.isPending}
            onChange={(e) => setName(e.target.value)}
            placeholder="get_weather"
          />
        </Field>

        <ToolVersionFields
          form={form}
          onChange={(p) => {
            setForm((f) => ({ ...f, ...p }));
            setError(null);
          }}
          error={error}
        />
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!canSubmit} onClick={handleSubmit}>
          {create.isPending
            ? 'Creating…'
            : strandedActive
              ? 'Commit first version'
              : 'Create tool'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
