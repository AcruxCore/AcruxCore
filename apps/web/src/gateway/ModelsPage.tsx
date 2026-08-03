import { useState } from 'react';
import type { GatewayModel } from '@/api';
import { useModels, useDeleteModel, useTestModel, ApiError } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { Badge, Button, Dialog, DialogFooter, Empty, PageSpinner, useToast } from '@/ui';
import { ModelDialog } from './ModelDialog';

// Formats a nullable per-1M price for display.
function price(n: number | null): string {
  return n == null ? '—' : `$${n}`;
}

/**
 * The model registry: public names → upstream models on a credential, with prices
 * and ordered fallbacks. A request's `model` resolves here. Reads open to any
 * role; mutations + Test are owner/admin.
 */
export function ModelsPage() {
  const { canManageTeam } = useAuth();
  const toast = useToast();
  const { data: models, isLoading, isError } = useModels();
  const del = useDeleteModel();
  const test = useTestModel();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<GatewayModel | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }
  function openEdit(m: GatewayModel) {
    setEditing(m);
    setDialogOpen(true);
  }

  async function handleDelete() {
    if (!deleteId) return;
    try {
      await del.mutateAsync(deleteId);
      toast.success('Model deleted');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not delete model');
    } finally {
      setDeleteId(null);
    }
  }

  async function handleTest(id: string) {
    setTestingId(id);
    try {
      const res = await test.mutateAsync(id);
      if (res.ok) toast.success(`Test OK · ${res.latencyMs}ms`);
      else toast.error(`Test failed: ${res.error ?? 'unknown error'}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not run test');
    } finally {
      setTestingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-center gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Models</h1>
          <p className="mt-1 text-[13px] text-muted">
            Named models the gateway can serve. A request’s <code className="font-mono">model</code>{' '}
            resolves to one of these, then to its credential.
          </p>
        </div>
        {canManageTeam && (
          <Button variant="primary" className="ml-auto" onClick={openCreate}>
            New model
          </Button>
        )}
      </header>

      {isLoading ? (
        <PageSpinner />
      ) : isError ? (
        <Empty title="Couldn't load models" description="Please try again." />
      ) : !models || models.length === 0 ? (
        <Empty
          title="No models yet"
          description="Register a model so requests (and the Playground) have something to call."
          action={
            canManageTeam ? (
              <Button variant="primary" onClick={openCreate}>
                New model
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="overflow-hidden rounded-xl border border-line">
          {models.map((m) => (
            <li
              key={m.id}
              className="flex items-center gap-4 border-b border-line-soft bg-surface px-4 py-3.5 last:border-b-0"
            >
              <Badge tone="default">{m.provider}</Badge>
              <div className="min-w-0">
                <p className="truncate text-[14px] font-medium text-ink">
                  <span className="font-mono">{m.publicName}</span>
                  <span className="text-faint"> → {m.upstreamModel}</span>
                </p>
                <p className="mt-0.5 truncate font-mono text-[12px] text-faint">
                  {m.credentialLabel} · in {price(m.inputPricePerM)} / out {price(m.outputPricePerM)} per 1M
                  {m.fallbacks.length > 0
                    ? ` · fallback → ${m.fallbacks.map((f) => f.publicName).join(', ')}`
                    : ''}
                </p>
              </div>
              {canManageTeam && (
                <div className="ml-auto flex flex-none gap-2">
                  <Button size="sm" disabled={testingId === m.id} onClick={() => handleTest(m.id)}>
                    {testingId === m.id ? 'Testing…' : 'Test'}
                  </Button>
                  <Button size="sm" onClick={() => openEdit(m)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setDeleteId(m.id)}>
                    Delete
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <ModelDialog open={dialogOpen} onOpenChange={setDialogOpen} model={editing} />

      <Dialog
        open={!!deleteId}
        onOpenChange={(o) => !o && setDeleteId(null)}
        title="Delete this model?"
        description="Requests using its public name will fail with MODEL_NOT_REGISTERED. Blocked if another model uses it as a fallback. This cannot be undone."
      >
        <DialogFooter>
          <Button variant="ghost" onClick={() => setDeleteId(null)}>
            Cancel
          </Button>
          <Button variant="danger" disabled={del.isPending} onClick={handleDelete}>
            {del.isPending ? 'Deleting…' : 'Delete model'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
