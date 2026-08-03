import { useState } from 'react';
import type { Secret } from '@/api';
import { useSecrets, useDeleteSecret, ApiError } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { timeAgo } from '@/lib/format';
import { Button, Dialog, DialogFooter, Empty, PageSpinner, useToast } from '@/ui';
import { SecretDialog } from './SecretDialog';

/**
 * Team secrets: encrypted values referenced as `{{secret.NAME}}` inside HTTP
 * tool executors. Reads are open to any role; mutations (create, rotate,
 * delete) are owner/admin only.
 */
export function SecretsPage() {
  const { canManageTeam } = useAuth();
  const toast = useToast();
  const { data: secrets, isLoading, isError } = useSecrets();
  const del = useDeleteSecret();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Secret | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(s: Secret) {
    setEditing(s);
    setDialogOpen(true);
  }

  async function handleDelete() {
    if (!deleteId) return;
    try {
      await del.mutateAsync(deleteId);
      toast.success('Secret deleted');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not delete secret');
    } finally {
      setDeleteId(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-center gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Secrets</h1>
          <p className="mt-1 text-[13px] text-muted">
            Encrypted values your HTTP tool executors can reference as{' '}
            <code className="font-mono text-[12px]">{'{{ secret.NAME }}'}</code>.
          </p>
        </div>
        {canManageTeam && (
          <Button variant="primary" className="ml-auto" onClick={openCreate}>
            New secret
          </Button>
        )}
      </header>

      {isLoading ? (
        <PageSpinner />
      ) : isError ? (
        <Empty title="Couldn't load secrets" description="Please try again." />
      ) : !secrets || secrets.length === 0 ? (
        <Empty
          title="No secrets yet"
          description="Add a secret so HTTP tool executors can reference it without exposing the value."
          action={
            canManageTeam ? (
              <Button variant="primary" onClick={openCreate}>
                New secret
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="overflow-hidden rounded-xl border border-line">
          {secrets.map((s) => (
            <li
              key={s.id}
              className="flex items-center gap-4 border-b border-line-soft bg-surface px-4 py-3.5 last:border-b-0"
            >
              <div className="min-w-0">
                <p className="truncate text-[14px] font-medium text-ink">{s.name}</p>
                <p className="mt-0.5 truncate font-mono text-[12px] text-faint">
                  ••••{s.lastFour} · added {timeAgo(s.createdAt)}
                </p>
              </div>
              {canManageTeam && (
                <div className="ml-auto flex flex-none gap-2">
                  <Button size="sm" onClick={() => openEdit(s)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setDeleteId(s.id)}>
                    Delete
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <SecretDialog open={dialogOpen} onOpenChange={setDialogOpen} secret={editing} />

      <Dialog
        open={!!deleteId}
        onOpenChange={(o) => !o && setDeleteId(null)}
        title="Delete this secret?"
        description="Blocked if any tool still references it. Remove those references first. This cannot be undone."
      >
        <DialogFooter>
          <Button variant="ghost" onClick={() => setDeleteId(null)}>
            Cancel
          </Button>
          <Button variant="danger" disabled={del.isPending} onClick={handleDelete}>
            {del.isPending ? 'Deleting…' : 'Delete secret'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
