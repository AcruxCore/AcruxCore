import { useState } from 'react';
import type { Budget } from '@/api';
import {
  useBudgets,
  useVirtualKeys,
  useDeleteBudget,
  useFlushCache,
  ApiError,
} from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { timeAgo } from '@/lib/format';
import { Badge, Button, Dialog, DialogFooter, Empty, PageSpinner, useToast } from '@/ui';
import { BudgetDialog } from './BudgetDialog';
import { formatUsd } from './format';

const PERIOD_LABEL: Record<Budget['period'], string> = {
  day: 'daily',
  week: 'weekly',
  month: 'monthly',
  total: 'total',
};

/** A spend-vs-limit meter. Turns amber past 80%, danger red at/over 100%. */
function SpendBar({ spend, limit }: { spend: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, (spend / limit) * 100) : 0;
  const tone =
    pct >= 100 ? 'bg-danger' : pct >= 80 ? 'bg-warn' : 'bg-accent';
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-elevated">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(pct, 2)}%` }} />
    </div>
  );
}

/**
 * Budgets: team-wide or per-key spend caps with live spend meters. Reads are
 * open to any role; create/edit/delete and cache flush are owner/admin. The
 * response-cache flush lives here since both are cost controls.
 */
export function BudgetsPage() {
  const { canManageTeam } = useAuth();
  const toast = useToast();
  const { data: budgets, isLoading, isError } = useBudgets();
  const { data: vkeys } = useVirtualKeys();
  const del = useDeleteBudget();
  const flush = useFlushCache();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Budget | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const keyName = (id: string | null) =>
    id ? vkeys?.find((k) => k.id === id)?.name ?? 'Virtual key' : 'Team-wide';

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  async function handleDelete() {
    if (!deleteId) return;
    try {
      await del.mutateAsync(deleteId);
      toast.success('Budget deleted');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not delete budget');
    } finally {
      setDeleteId(null);
    }
  }

  async function handleFlush() {
    try {
      const { deleted } = await flush.mutateAsync();
      toast.success(deleted > 0 ? `Flushed ${deleted} cached response${deleted > 1 ? 's' : ''}` : 'Cache was already empty');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not flush cache');
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-center gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Budgets</h1>
          <p className="mt-1 text-[13px] text-muted">
            Spend caps enforced in real time. Over-budget requests are stopped before they cost
            anything.
          </p>
        </div>
        {canManageTeam && (
          <Button variant="primary" className="ml-auto" onClick={openCreate}>
            New budget
          </Button>
        )}
      </header>

      {isLoading ? (
        <PageSpinner />
      ) : isError ? (
        <Empty title="Couldn't load budgets" description="Please try again." />
      ) : !budgets || budgets.length === 0 ? (
        <Empty
          title="No budgets yet"
          description="Set a cap to protect against runaway spend across the team or a single key."
          action={
            canManageTeam ? (
              <Button variant="primary" onClick={openCreate}>
                New budget
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {budgets.map((b) => {
            const over = b.limitUsd > 0 && b.spendUsd >= b.limitUsd;
            return (
              <li key={b.id} className="rounded-xl border border-line bg-surface p-4">
                <div className="flex items-center gap-3">
                  <Badge tone={b.virtualKeyId ? 'default' : 'prod'} dot>
                    {keyName(b.virtualKeyId)}
                  </Badge>
                  <span className="text-[12.5px] text-muted">{PERIOD_LABEL[b.period]}</span>
                  {over && <Badge tone="staging">at limit</Badge>}
                  <div className="ml-auto flex items-center gap-4">
                    <span className="font-mono text-[13px] text-ink">
                      {formatUsd(b.spendUsd)}{' '}
                      <span className="text-faint">/ {formatUsd(b.limitUsd)}</span>
                    </span>
                    {canManageTeam && (
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => { setEditing(b); setDialogOpen(true); }}>
                          Edit
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => setDeleteId(b.id)}>
                          Delete
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
                <div className="mt-3">
                  <SpendBar spend={b.spendUsd} limit={b.limitUsd} />
                </div>
                <p className="mt-2 text-[12px] text-faint">
                  {b.resetsAt ? `Resets ${timeAgo(b.resetsAt)}` : 'Never resets'}
                </p>
              </li>
            );
          })}
        </ul>
      )}

      {/* Response cache control */}
      <section className="rounded-xl border border-line bg-surface">
        <div className="flex items-center justify-between gap-4 p-4">
          <div>
            <h2 className="text-[14px] font-semibold text-ink">Response cache</h2>
            <p className="mt-0.5 text-[12.5px] text-muted">
              Exact-match cache scoped to your team. Enable it per virtual key with a cache TTL; a
              hit costs nothing.
            </p>
          </div>
          {canManageTeam && (
            <Button size="sm" variant="danger" disabled={flush.isPending} onClick={handleFlush}>
              {flush.isPending ? 'Flushing…' : 'Flush cache'}
            </Button>
          )}
        </div>
      </section>

      <BudgetDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        budget={editing}
        virtualKeys={vkeys ?? []}
      />

      <Dialog
        open={!!deleteId}
        onOpenChange={(o) => !o && setDeleteId(null)}
        title="Delete this budget?"
        description="Spend will no longer be capped for this scope. This cannot be undone."
      >
        <DialogFooter>
          <Button variant="ghost" onClick={() => setDeleteId(null)}>
            Cancel
          </Button>
          <Button variant="danger" disabled={del.isPending} onClick={handleDelete}>
            {del.isPending ? 'Deleting…' : 'Delete budget'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
