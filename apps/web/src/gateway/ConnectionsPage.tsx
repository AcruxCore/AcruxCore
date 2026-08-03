import { useState } from 'react';
import type { ProviderConnection } from '@/api';
import { useConnections, useDeleteConnection, ApiError } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { timeAgo } from '@/lib/format';
import { Badge, Button, Dialog, DialogFooter, Empty, PageSpinner, useToast } from '@/ui';
import { ConnectionDialog } from './ConnectionDialog';
import { PROVIDER_LABELS } from './format';

/**
 * Provider connections (BYOK): the encrypted credentials the gateway uses to
 * reach each upstream provider. Reads are open to any role; mutations are
 * owner/admin.
 */
export function ConnectionsPage() {
  const { canManageTeam } = useAuth();
  const toast = useToast();
  const { data: connections, isLoading, isError } = useConnections();
  const del = useDeleteConnection();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderConnection | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(c: ProviderConnection) {
    setEditing(c);
    setDialogOpen(true);
  }

  async function handleDelete() {
    if (!deleteId) return;
    try {
      await del.mutateAsync(deleteId);
      toast.success('Credential deleted');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not delete credential');
    } finally {
      setDeleteId(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-center gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Credentials</h1>
          <p className="mt-1 text-[13px] text-muted">
            Your provider keys, encrypted at rest. Register a Model to point a callable name at a
            credential.
          </p>
        </div>
        {canManageTeam && (
          <Button variant="primary" className="ml-auto" onClick={openCreate}>
            New credential
          </Button>
        )}
      </header>

      {isLoading ? (
        <PageSpinner />
      ) : isError ? (
        <Empty title="Couldn't load connections" description="Please try again." />
      ) : !connections || connections.length === 0 ? (
        <Empty
          title="No credentials yet"
          description="Add a provider key so the gateway can make model calls on your behalf."
          action={
            canManageTeam ? (
              <Button variant="primary" onClick={openCreate}>
                New credential
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="overflow-hidden rounded-xl border border-line">
          {connections.map((c) => (
            <li
              key={c.id}
              className="flex items-center gap-4 border-b border-line-soft bg-surface px-4 py-3.5 last:border-b-0"
            >
              <Badge tone="default">{PROVIDER_LABELS[c.provider]}</Badge>
              <div className="min-w-0">
                <p className="truncate text-[14px] font-medium text-ink">{c.label}</p>
                <p className="mt-0.5 truncate font-mono text-[12px] text-faint">
                  ••••{c.keyLastFour} · added {timeAgo(c.createdAt)}
                  {c.config.base_url ? ` · ${c.config.base_url}` : ''}
                </p>
              </div>
              {canManageTeam && (
                <div className="ml-auto flex flex-none gap-2">
                  <Button size="sm" onClick={() => openEdit(c)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setDeleteId(c.id)}>
                    Delete
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <ConnectionDialog open={dialogOpen} onOpenChange={setDialogOpen} connection={editing} />

      <Dialog
        open={!!deleteId}
        onOpenChange={(o) => !o && setDeleteId(null)}
        title="Delete this credential?"
        description="Blocked if any model still uses it. Delete or reassign those models first. This cannot be undone."
      >
        <DialogFooter>
          <Button variant="ghost" onClick={() => setDeleteId(null)}>
            Cancel
          </Button>
          <Button variant="danger" disabled={del.isPending} onClick={handleDelete}>
            {del.isPending ? 'Deleting…' : 'Delete credential'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
