import { useState } from 'react';
import type { ApiKeyCreated, ApiKeyListItem } from '@/api';
import { ApiError } from '@/api';
import { timeAgo } from '@/lib/format';
import {
  Button,
  CopyButton,
  Dialog,
  DialogFooter,
  Empty,
  Field,
  Input,
  Spinner,
  useToast,
} from '@/ui';

export interface ApiKeysPanelProps {
  title: string;
  description: string;
  keys: ApiKeyListItem[] | undefined;
  isLoading: boolean;
  canManage: boolean;
  onCreate: (name: string | undefined) => Promise<ApiKeyCreated>;
  onRevoke: (id: string) => Promise<void>;
  /** Show a copy-paste SDK usage snippet in the reveal dialog. */
  showSdkSnippet?: boolean;
}

/**
 * Reusable API-key management panel (personal and team-scoped).
 *
 * Handles create (name optional), the one-time secret reveal with copy, and
 * revoke-with-confirm. The full key is shown exactly once, matching the API.
 */
export function ApiKeysPanel({
  title,
  description,
  keys,
  isLoading,
  canManage,
  onCreate,
  onRevoke,
  showSdkSnippet,
}: ApiKeysPanelProps) {
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<ApiKeyCreated | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);

  async function handleCreate() {
    setBusy(true);
    try {
      const created = await onCreate(name.trim() || undefined);
      setRevealed(created);
      setCreating(false);
      setName('');
      toast.success('API key created');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not create key');
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke() {
    if (!revokeId) return;
    setBusy(true);
    try {
      await onRevoke(revokeId);
      toast.success('API key revoked');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not revoke key');
    } finally {
      setBusy(false);
      setRevokeId(null);
    }
  }

  return (
    <section className="rounded-xl border border-line bg-surface">
      <div className="flex items-start justify-between gap-4 border-b border-line-soft p-4">
        <div>
          <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
          <p className="mt-0.5 text-[12.5px] text-muted">{description}</p>
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setCreating(true)}>
            New key
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="flex justify-center p-8">
          <Spinner />
        </div>
      ) : !keys || keys.length === 0 ? (
        <div className="p-4">
          <Empty title="No API keys yet" description="Create a key to use the SDK or CI." />
        </div>
      ) : (
        <ul className="divide-y divide-line-soft">
          {keys.map((k) => (
            <li key={k.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-ink">
                  {k.name || 'Untitled key'}
                </p>
                <p className="font-mono text-[12px] text-faint">
                  ••••{k.lastFour} · {timeAgo(k.createdAt)}
                </p>
              </div>
              {canManage && (
                <Button
                  size="sm"
                  variant="danger"
                  className="ml-auto"
                  onClick={() => setRevokeId(k.id)}
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Create */}
      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title="Create API key"
        description="Give the key a name to recognize it later (optional)."
      >
        <Field label="Name" htmlFor="key-name" hint="e.g. CI, local dev">
          <Input
            id="key-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Untitled key"
          />
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setCreating(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={handleCreate}>
            {busy ? 'Creating…' : 'Create key'}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Reveal once */}
      <Dialog
        open={!!revealed}
        onOpenChange={(o) => !o && setRevealed(null)}
        title="Copy your API key"
        description="This is the only time the full key is shown. Store it somewhere safe."
      >
        {revealed && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 rounded-md border border-line bg-bg p-2">
              <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">
                {revealed.key}
              </code>
              <CopyButton value={revealed.key} />
            </div>
            {showSdkSnippet && (
              <pre className="overflow-x-auto rounded-md border border-line bg-bg p-3 font-mono text-[11.5px] leading-relaxed text-muted">
{`import { acruxcore } from '@acruxcoreai/sdk';

const hub = new acruxcore({ apiKey: '${revealed.key}' });
const messages = await hub.renderPrompt('greeting', 'production', { name: 'Alice' });`}
              </pre>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="primary" onClick={() => setRevealed(null)}>
            Done
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Revoke confirm */}
      <Dialog
        open={!!revokeId}
        onOpenChange={(o) => !o && setRevokeId(null)}
        title="Revoke this API key?"
        description="Any client using this key will stop working immediately. This cannot be undone."
      >
        <DialogFooter>
          <Button variant="ghost" onClick={() => setRevokeId(null)}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy} onClick={handleRevoke}>
            {busy ? 'Revoking…' : 'Revoke key'}
          </Button>
        </DialogFooter>
      </Dialog>
    </section>
  );
}
