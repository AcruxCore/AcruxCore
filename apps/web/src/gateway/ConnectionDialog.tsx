import { useEffect, useState } from 'react';
import type { ProviderConnection, ProviderKind } from '@/api';
import { useCreateConnection, useUpdateConnection, ApiError } from '@/api';
import { Button, Dialog, DialogFooter, Field, Input, Select, useToast } from '@/ui';
import { PROVIDER_LABELS } from './format';

const PROVIDERS: ProviderKind[] = ['openai', 'anthropic', 'gemini', 'openai_compatible'];

export interface ConnectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the dialog edits this credential instead of creating a new one. */
  connection?: ProviderConnection | null;
}

/**
 * Create or edit a BYOK credential (provider + key + optional base URL). Provider
 * is immutable once created; on edit the API key field rotates the stored secret
 * only if filled. Routing/pricing now live on Models, not on the credential.
 */
export function ConnectionDialog({ open, onOpenChange, connection }: ConnectionDialogProps) {
  const editing = !!connection;
  const toast = useToast();
  const create = useCreateConnection();
  const update = useUpdateConnection();

  const [provider, setProvider] = useState<ProviderKind>('openai');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');

  // Reset the form whenever the dialog opens (fresh create, or hydrate for edit).
  useEffect(() => {
    if (!open) return;
    if (connection) {
      setProvider(connection.provider);
      setLabel(connection.label);
      setApiKey('');
      setBaseUrl(String(connection.config.base_url ?? ''));
    } else {
      setProvider('openai');
      setLabel('');
      setApiKey('');
      setBaseUrl('');
    }
  }, [open, connection]);

  const busy = create.isPending || update.isPending;
  const needsBaseUrl = provider === 'openai_compatible';

  function buildConfig(): Record<string, unknown> {
    const config: Record<string, unknown> = {};
    if (needsBaseUrl && baseUrl.trim()) config.base_url = baseUrl.trim();
    return config;
  }

  async function handleSubmit() {
    try {
      if (editing && connection) {
        const body: { label?: string; apiKey?: string; config?: Record<string, unknown> } = {
          label: label.trim(),
          config: buildConfig(),
        };
        if (apiKey.trim()) body.apiKey = apiKey.trim();
        await update.mutateAsync({ id: connection.id, body });
        toast.success('Credential updated');
      } else {
        await create.mutateAsync({
          provider,
          label: label.trim(),
          apiKey: apiKey.trim(),
          config: buildConfig(),
        });
        toast.success('Credential created');
      }
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save credential');
    }
  }

  const canSubmit =
    label.trim().length > 0 &&
    (editing || apiKey.trim().length > 0) &&
    (!needsBaseUrl || baseUrl.trim().length > 0);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? 'Edit credential' : 'New credential'}
      description={
        editing
          ? 'Update the label, base URL, or rotate the stored key.'
          : 'Add a provider credential. The key is encrypted at rest and never shown again. Register a Model to use it.'
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Provider" htmlFor="conn-provider">
          {editing ? (
            <div className="rounded-md border border-line bg-elevated px-3 py-2 font-mono text-[13px] text-muted">
              {PROVIDER_LABELS[provider]} · immutable
            </div>
          ) : (
            <Select
              id="conn-provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value as ProviderKind)}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABELS[p]}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="Label" htmlFor="conn-label" hint="A name you'll recognize, e.g. “OpenAI Prod”.">
          <Input
            id="conn-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="OpenAI Prod"
          />
        </Field>

        <Field
          label={editing ? 'API key' : 'Provider API key'}
          htmlFor="conn-key"
          hint={editing ? 'Leave blank to keep the current key.' : undefined}
        >
          <Input
            id="conn-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={editing ? '•••• keep current' : 'sk-…'}
            autoComplete="off"
          />
        </Field>

        {needsBaseUrl && (
          <Field label="Base URL" htmlFor="conn-baseurl" hint="Required for OpenAI-compatible endpoints (OpenRouter, Together, local, …).">
            <Input
              id="conn-baseurl"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://openrouter.ai/api/v1"
            />
          </Field>
        )}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={busy || !canSubmit} onClick={handleSubmit}>
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Create credential'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
