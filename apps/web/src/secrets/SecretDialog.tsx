import { useEffect, useState } from 'react';
import type { Secret } from '@/api';
import { useCreateSecret, useRotateSecret, ApiError } from '@/api';
import { Button, Dialog, DialogFooter, Field, Input, useToast } from '@/ui';

/** `name` must be an uppercase snake-case identifier, e.g. `STRIPE_API_KEY`. */
const NAME_PATTERN = /^[A-Z0-9_]{1,64}$/;

export interface SecretDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the dialog rotates this secret's value instead of creating a new one. */
  secret?: Secret | null;
}

/**
 * Create or rotate a team secret. `name` is set once at creation and is
 * immutable afterward (it's the `{{secret.NAME}}` reference used by HTTP tool
 * executors); rotating only replaces the underlying value.
 */
export function SecretDialog({ open, onOpenChange, secret }: SecretDialogProps) {
  const editing = !!secret;
  const toast = useToast();
  const create = useCreateSecret();
  const rotate = useRotateSecret();

  const [name, setName] = useState('');
  const [value, setValue] = useState('');

  // Reset the form whenever the dialog opens (fresh create, or hydrate for rotate).
  useEffect(() => {
    if (!open) return;
    if (secret) {
      setName(secret.name);
      setValue('');
    } else {
      setName('');
      setValue('');
    }
  }, [open, secret]);

  const busy = create.isPending || rotate.isPending;
  const nameValid = NAME_PATTERN.test(name);
  const nameError = !editing && name.length > 0 && !nameValid ? 'Use only A-Z, 0-9, and _ (max 64 chars).' : undefined;

  async function handleSubmit() {
    try {
      if (editing && secret) {
        await rotate.mutateAsync({ id: secret.id, value: value.trim() });
        toast.success('Secret rotated');
      } else {
        await create.mutateAsync({ name: name.trim(), value: value.trim() });
        toast.success('Secret created');
      }
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save secret');
    }
  }

  const canSubmit = (editing || nameValid) && value.trim().length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? 'Rotate secret' : 'New secret'}
      description={
        editing
          ? 'Replace the stored value. The name and any tools referencing it stay the same.'
          : 'Add a secret. The value is encrypted at rest and never shown again. Reference it as {{ secret.NAME }} in an HTTP tool executor.'
      }
    >
      <div className="flex flex-col gap-3">
        <Field
          label="Name"
          htmlFor="secret-name"
          error={nameError}
          hint={editing ? undefined : 'Uppercase letters, digits, and underscores only.'}
        >
          {editing ? (
            <div className="rounded-md border border-line bg-elevated px-3 py-2 font-mono text-[13px] text-muted">
              {name} · immutable
            </div>
          ) : (
            <Input
              id="secret-name"
              value={name}
              onChange={(e) => setName(e.target.value.toUpperCase())}
              placeholder="STRIPE_API_KEY"
              autoComplete="off"
            />
          )}
        </Field>

        <Field
          label="Value"
          htmlFor="secret-value"
          hint={editing ? undefined : 'Stored encrypted; you will not be able to view it again.'}
        >
          <Input
            id="secret-value"
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={editing ? 'New value' : '••••••••'}
            autoComplete="off"
          />
        </Field>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={busy || !canSubmit} onClick={handleSubmit}>
          {busy ? 'Saving…' : editing ? 'Rotate secret' : 'Create secret'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
