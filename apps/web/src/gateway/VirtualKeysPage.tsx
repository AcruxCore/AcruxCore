import { useState } from 'react';
import type { VirtualKeyCreated, VirtualKeyListItem } from '@/api';
import { useVirtualKeys, useRevokeVirtualKey, ApiError } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { timeAgo } from '@/lib/format';
import {
  Badge,
  Button,
  CopyButton,
  Dialog,
  DialogFooter,
  Empty,
  PageSpinner,
  useToast,
} from '@/ui';
import { VirtualKeyDialog } from './VirtualKeyDialog';

/** Render a key's scope/limits as compact mono chips, or a muted "unrestricted". */
function KeyScopes({ k }: { k: VirtualKeyListItem }) {
  const chips: string[] = [];
  if (k.allowedModels?.length) chips.push(`models: ${k.allowedModels.join(', ')}`);
  if (k.allowedProviders?.length) chips.push(`providers: ${k.allowedProviders.join(', ')}`);
  if (k.maxRpm != null) chips.push(`${k.maxRpm} rpm`);
  if (k.maxTpm != null) chips.push(`${k.maxTpm} tpm`);
  if (k.cacheTtlSeconds != null) chips.push(`cache ${k.cacheTtlSeconds}s`);
  if (chips.length === 0) return <span className="text-faint">unrestricted</span>;
  return <span>{chips.join(' · ')}</span>;
}

/**
 * Virtual keys: machine credentials for calling the gateway. Listing is open to
 * any role; create/edit/revoke are owner/admin. The plaintext token is revealed
 * exactly once at creation.
 */
export function VirtualKeysPage() {
  const { canManageTeam } = useAuth();
  const toast = useToast();
  const { data: vkeys, isLoading, isError } = useVirtualKeys();
  const revoke = useRevokeVirtualKey();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<VirtualKeyListItem | null>(null);
  const [revealed, setRevealed] = useState<VirtualKeyCreated | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  async function handleRevoke() {
    if (!revokeId) return;
    try {
      await revoke.mutateAsync(revokeId);
      toast.success('Key revoked');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not revoke key');
    } finally {
      setRevokeId(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-center gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Virtual keys</h1>
          <p className="mt-1 text-[13px] text-muted">
            Scoped tokens your apps use to call the gateway. Set model limits, rate caps, and
            caching per key.
          </p>
        </div>
        {canManageTeam && (
          <Button variant="primary" className="ml-auto" onClick={openCreate}>
            New key
          </Button>
        )}
      </header>

      {isLoading ? (
        <PageSpinner />
      ) : isError ? (
        <Empty title="Couldn't load keys" description="Please try again." />
      ) : !vkeys || vkeys.length === 0 ? (
        <Empty
          title="No virtual keys yet"
          description="Create a key to authenticate gateway traffic from your apps or CI."
          action={
            canManageTeam ? (
              <Button variant="primary" onClick={openCreate}>
                New key
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="overflow-hidden rounded-xl border border-line">
          {vkeys.map((k) => {
            const revokedItem = !!k.revokedAt;
            return (
              <li
                key={k.id}
                className="flex items-center gap-4 border-b border-line-soft bg-surface px-4 py-3.5 last:border-b-0"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-[14px] font-medium text-ink">{k.name}</p>
                    <span className="font-mono text-[12px] text-faint">agh_sk_••••{k.keyLastFour}</span>
                    {revokedItem && <Badge tone="muted">revoked</Badge>}
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[12px] text-faint">
                    <KeyScopes k={k} /> · created {timeAgo(k.createdAt)}
                  </p>
                </div>
                {canManageTeam && !revokedItem && (
                  <div className="ml-auto flex flex-none gap-2">
                    <Button size="sm" onClick={() => { setEditing(k); setDialogOpen(true); }}>
                      Edit
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => setRevokeId(k.id)}>
                      Revoke
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <VirtualKeyDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        keyItem={editing}
        onCreated={(c) => setRevealed(c)}
      />

      {/* Reveal once */}
      <Dialog
        open={!!revealed}
        onOpenChange={(o) => !o && setRevealed(null)}
        title="Copy your virtual key"
        description="This is the only time the full token is shown. Store it somewhere safe."
      >
        {revealed && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 rounded-md border border-line bg-bg p-2">
              <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">
                {revealed.key}
              </code>
              <CopyButton value={revealed.key} />
            </div>
            <pre className="overflow-x-auto rounded-md border border-line bg-bg p-3 font-mono text-[11.5px] leading-relaxed text-muted">
{`import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: '${revealed.key}',
  baseURL: '${window.location.origin}/api/v1/gateway',
});`}
            </pre>
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
        title="Revoke this key?"
        description="Any app using this token will stop working immediately. Past requests keep their reference. This cannot be undone."
      >
        <DialogFooter>
          <Button variant="ghost" onClick={() => setRevokeId(null)}>
            Cancel
          </Button>
          <Button variant="danger" disabled={revoke.isPending} onClick={handleRevoke}>
            {revoke.isPending ? 'Revoking…' : 'Revoke key'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
