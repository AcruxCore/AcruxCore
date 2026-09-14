import { useEffect, useState } from 'react';
import type { ToolDetail } from '@/api';
import { ApiError, useDeleteTool, useUpdateTool } from '@/api';
import { Button, Dialog, DialogFooter, Field, Input, Textarea, useToast } from '@/ui';
import { TOOL_NAME_PATTERN } from './catalog';

export interface ToolSettingsDialogProps {
  tool: ToolDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful delete, so the page can leave the now-missing tool. */
  onDeleted: () => void;
}

/**
 * Rename a tool, edit its catalog description, or delete it.
 *
 * Both of these were API-only, which left the dashboard unable to undo its own mistakes:
 * a tool created with a typo could not be renamed or removed from any screen, so the
 * catalog only ever grew. A catalog full of dead names is its own kind of confusion.
 *
 * Both actions are told plainly, because both reach further than they look. A rename
 * changes the name the model is shown and the name every `tool_ref` resolves, so a
 * caller naming the old one stops working. A delete stops the tool reaching the model
 * everywhere at once, including through prompt bindings nobody remembers making.
 *
 * @param tool - The tool being edited.
 * @param open - Whether the dialog is visible.
 * @param onOpenChange - Called to open/close the dialog.
 * @param onDeleted - Called once the delete succeeds.
 */
export function ToolSettingsDialog({ tool, open, onOpenChange, onDeleted }: ToolSettingsDialogProps) {
  const toast = useToast();
  const update = useUpdateTool(tool.id);
  const remove = useDeleteTool();

  const [name, setName] = useState(tool.name);
  const [description, setDescription] = useState(tool.description ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(tool.name);
    setDescription(tool.description ?? '');
    setConfirmDelete(false);
    // Reset on open, or on the tool's identity changing — never on its contents
    // changing. A `POST /tools/sync` (or any other background refetch) can update
    // `tool.name`/`tool.description` while the dialog is still open; keying this effect
    // on those fields re-ran it on that refetch and threw away whatever the user had
    // typed but not yet saved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tool.id]);

  const trimmedName = name.trim();
  const nameValid = TOOL_NAME_PATTERN.test(trimmedName);
  const renaming = trimmedName !== tool.name;
  const changed = renaming || description.trim() !== (tool.description ?? '');

  async function handleSave() {
    try {
      await update.mutateAsync({
        ...(renaming ? { name: trimmedName } : {}),
        description: description.trim() || null,
      });
      toast.success(renaming ? `Renamed to "${trimmedName}"` : 'Description saved');
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save that change.');
    }
  }

  async function handleDelete() {
    try {
      await remove.mutateAsync(tool.id);
      toast.success(`"${tool.name}" deleted`);
      onOpenChange(false);
      onDeleted();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not delete that tool.');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Tool settings"
      description="The name and description on the tool itself. Parameters and the executor belong to a version — commit a new one to change those."
    >
      <div className="flex flex-col gap-3">
        <Field
          label="Name"
          htmlFor="ts-name"
          hint="What the model calls, and what every reference to this tool looks up."
          error={
            trimmedName.length > 0 && !nameValid
              ? 'Invalid name — use only letters, numbers, _ and -.'
              : undefined
          }
        >
          <Input id="ts-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        {renaming && nameValid && (
          <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[12.5px] text-ink">
            Renaming changes the name the model is shown and the name every caller resolves.
            Anything referring to <code className="font-mono">{tool.name}</code> — a{' '}
            <code className="font-mono">tool_ref</code>, a decorated function, a{' '}
            <code className="font-mono">client_tools</code> key — stops matching until it is
            updated too. Prompt bindings follow the rename, because they point at the tool itself.
          </p>
        )}

        <Field
          label="Description"
          htmlFor="ts-description"
          hint="A catalog label for your team. The model reads the version's description, not this one — it is only used as a fallback while a version has none."
        >
          <Textarea
            id="ts-description"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Fetches the current weather for a location."
          />
        </Field>

        <div className="mt-1 flex flex-col gap-2 rounded-lg border border-line-soft p-3">
          <p className="text-[13px] font-medium text-ink">Delete this tool</p>
          {confirmDelete ? (
            <>
              <p className="text-[12.5px] text-muted">
                <span className="font-mono">{tool.name}</span> stops being sent to the model
                everywhere at once — including through any prompt bound to it, with no warning on
                those prompts. Its versions and history are kept, and the name becomes free to use
                again.
              </p>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="danger"
                  disabled={remove.isPending}
                  onClick={handleDelete}
                >
                  {remove.isPending ? 'Deleting…' : `Yes, delete ${tool.name}`}
                </Button>
                <button
                  type="button"
                  className="text-[12px] text-faint hover:text-ink"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
              Delete tool…
            </Button>
          )}
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={update.isPending || !changed || !nameValid}
          onClick={handleSave}
        >
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
