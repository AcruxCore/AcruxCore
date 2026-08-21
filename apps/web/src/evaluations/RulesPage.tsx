import { useState } from 'react';
import { Button, Dialog, DialogFooter, Empty, PageSpinner, useToast } from '@/ui';
import { ApiError, useDeleteEvalRule, useEvalRules } from '@/api';
import type { EvalRule } from '@/api/types';
import { RuleDrawer } from './RuleDrawer';
import { RulesTable } from './RulesTable';

/**
 * The `/evaluations/rules` screen: every online-evaluation rule the team has
 * defined, scoring live traffic automatically as it flows through the
 * gateway — the counterpart to the Datasets/Runs tabs, which only ever score
 * what a person deliberately sends through.
 *
 * `editing` holds the rule (or `'new'`) whose editor should be open; it
 * drives the `RuleDrawer` below in create mode (`'new'`) or edit mode (a
 * real `EvalRule`).
 */
export function RulesPage() {
  const { data: rules, isLoading, isError } = useEvalRules();
  const [editing, setEditing] = useState<EvalRule | 'new' | null>(null);

  const toast = useToast();
  const del = useDeleteEvalRule();
  const [deleteId, setDeleteId] = useState<string | null>(null);

  /** Deletes the rule pending confirmation. A rule stops scoring the moment it's gone. */
  async function handleDelete() {
    if (!deleteId) return;
    try {
      await del.mutateAsync(deleteId);
      toast.success('Rule deleted');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not delete rule');
    } finally {
      setDeleteId(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-center gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Rules</h1>
          <p className="mt-1 text-[13px] text-muted">
            Rules that score live traffic automatically, without waiting for someone to run an experiment.
          </p>
        </div>
        <Button variant="primary" className="ml-auto" onClick={() => setEditing('new')} data-testid="new-rule-button">
          New rule
        </Button>
      </header>

      {isLoading ? (
        <PageSpinner />
      ) : isError ? (
        <Empty title="Couldn’t load rules" description="Something went wrong fetching rules. Try again." />
      ) : !rules || rules.length === 0 ? (
        <Empty
          title="No rules yet"
          description="Score live traffic → filter the bad ones → build a dataset → run an experiment."
          action={
            <Button variant="primary" onClick={() => setEditing('new')}>
              New rule
            </Button>
          }
        />
      ) : (
        <RulesTable rules={rules} onSelectRule={setEditing} onDeleteRule={setDeleteId} />
      )}

      <RuleDrawer
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        rule={editing === 'new' ? undefined : editing ?? undefined}
      />

      <Dialog
        open={!!deleteId}
        onOpenChange={(o) => !o && setDeleteId(null)}
        title="Delete this rule?"
        description="Stops all scoring for this rule immediately. This cannot be undone."
      >
        <DialogFooter>
          <Button variant="ghost" onClick={() => setDeleteId(null)}>
            Cancel
          </Button>
          <Button variant="danger" disabled={del.isPending} onClick={handleDelete}>
            {del.isPending ? 'Deleting…' : 'Delete rule'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
