import { useEffect, useState } from 'react';
import type {
  CreateVirtualKeyInput,
  UpdateVirtualKeyInput,
  VirtualKeyCreated,
  VirtualKeyListItem,
} from '@/api';
import { useCreateVirtualKey, useUpdateVirtualKey, ApiError } from '@/api';
import { Button, Dialog, DialogFooter, Field, Input, useToast } from '@/ui';

export interface VirtualKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, edits this key; otherwise creates a new one. */
  keyItem?: VirtualKeyListItem | null;
  /** Called with the freshly created key so the parent can reveal it once. */
  onCreated?: (created: VirtualKeyCreated) => void;
}

/** Parse a comma-separated list into a trimmed array, or `null` when empty. */
function parseList(raw: string): string[] | null {
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : null;
}

/** Parse a numeric field into a positive int, or `null` when blank. */
function parseNum(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Create or edit a virtual key: name plus optional model/provider scopes,
 * RPM/TPM rate limits, and an opt-in response-cache TTL. Empty scope/limit
 * fields mean "unrestricted".
 */
export function VirtualKeyDialog({ open, onOpenChange, keyItem, onCreated }: VirtualKeyDialogProps) {
  const editing = !!keyItem;
  const toast = useToast();
  const create = useCreateVirtualKey();
  const update = useUpdateVirtualKey();

  const [name, setName] = useState('');
  const [models, setModels] = useState('');
  const [providers, setProviders] = useState('');
  const [maxRpm, setMaxRpm] = useState('');
  const [maxTpm, setMaxTpm] = useState('');
  const [cacheTtl, setCacheTtl] = useState('');

  useEffect(() => {
    if (!open) return;
    if (keyItem) {
      setName(keyItem.name);
      setModels((keyItem.allowedModels ?? []).join(', '));
      setProviders((keyItem.allowedProviders ?? []).join(', '));
      setMaxRpm(keyItem.maxRpm != null ? String(keyItem.maxRpm) : '');
      setMaxTpm(keyItem.maxTpm != null ? String(keyItem.maxTpm) : '');
      setCacheTtl(keyItem.cacheTtlSeconds != null ? String(keyItem.cacheTtlSeconds) : '');
    } else {
      setName('');
      setModels('');
      setProviders('');
      setMaxRpm('');
      setMaxTpm('');
      setCacheTtl('');
    }
  }, [open, keyItem]);

  const busy = create.isPending || update.isPending;

  async function handleSubmit() {
    const am = parseList(models);
    const ap = parseList(providers);
    const rpm = parseNum(maxRpm);
    const tpm = parseNum(maxTpm);
    const ttl = parseNum(cacheTtl);
    try {
      if (editing && keyItem) {
        // Update accepts null to clear a previously-set scope or limit.
        const body: UpdateVirtualKeyInput = {
          name: name.trim(),
          allowedModels: am,
          allowedProviders: ap,
          maxRpm: rpm,
          maxTpm: tpm,
          cacheTtlSeconds: ttl,
        };
        await update.mutateAsync({ id: keyItem.id, body });
        toast.success('Key updated');
        onOpenChange(false);
      } else {
        // Create rejects null for the numeric limits, so omit blank fields.
        const body: CreateVirtualKeyInput = { name: name.trim() };
        if (am) body.allowedModels = am;
        if (ap) body.allowedProviders = ap;
        if (rpm != null) body.maxRpm = rpm;
        if (tpm != null) body.maxTpm = tpm;
        if (ttl != null) body.cacheTtlSeconds = ttl;
        const created = await create.mutateAsync(body);
        onOpenChange(false);
        onCreated?.(created);
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save key');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? 'Edit virtual key' : 'New virtual key'}
      description={
        editing
          ? 'Adjust the scope and limits. The token itself does not change.'
          : 'A machine credential for calling the gateway. The token is shown only once.'
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Name" htmlFor="vk-name" hint="e.g. “CI pipeline”, “Prod backend”.">
          <Input
            id="vk-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="CI pipeline"
          />
        </Field>

        <div className="rounded-md border border-line-soft bg-bg p-3">
          <p className="mb-3 text-[12px] font-medium uppercase tracking-[0.06em] text-faint">
            Scope · leave blank for unrestricted
          </p>
          <div className="flex flex-col gap-3">
            <Field label="Allowed models" htmlFor="vk-models">
              <Input
                id="vk-models"
                value={models}
                onChange={(e) => setModels(e.target.value)}
                placeholder="gpt-4o-mini, gpt-4o"
              />
            </Field>
            <Field label="Allowed providers" htmlFor="vk-providers">
              <Input
                id="vk-providers"
                value={providers}
                onChange={(e) => setProviders(e.target.value)}
                placeholder="openai, gemini"
              />
            </Field>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Max RPM" htmlFor="vk-rpm" hint="req/min">
            <Input
              id="vk-rpm"
              type="number"
              value={maxRpm}
              onChange={(e) => setMaxRpm(e.target.value)}
              placeholder="∞"
            />
          </Field>
          <Field label="Max TPM" htmlFor="vk-tpm" hint="tokens/min">
            <Input
              id="vk-tpm"
              type="number"
              value={maxTpm}
              onChange={(e) => setMaxTpm(e.target.value)}
              placeholder="∞"
            />
          </Field>
          <Field label="Cache TTL" htmlFor="vk-cache" hint="seconds">
            <Input
              id="vk-cache"
              type="number"
              value={cacheTtl}
              onChange={(e) => setCacheTtl(e.target.value)}
              placeholder="off"
            />
          </Field>
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={busy || name.trim().length === 0} onClick={handleSubmit}>
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Create key'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
