import { useEffect, useState } from 'react';
import type { Budget, BudgetPeriod, VirtualKeyListItem } from '@/api';
import { useCreateBudget, useUpdateBudget, ApiError } from '@/api';
import { Button, Dialog, DialogFooter, Field, Input, Select, useToast } from '@/ui';

const PERIODS: BudgetPeriod[] = ['day', 'week', 'month', 'total'];
const PERIOD_LABELS: Record<BudgetPeriod, string> = {
  day: 'Daily',
  week: 'Weekly',
  month: 'Monthly',
  total: 'Total (never resets)',
};

export interface BudgetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  budget?: Budget | null;
  /** Virtual keys available as budget scopes (for the create scope picker). */
  virtualKeys: VirtualKeyListItem[];
}

/**
 * Create or edit a spend cap. Scope (team-wide vs. a single virtual key) is
 * chosen at creation only; editing changes the limit and/or period.
 */
export function BudgetDialog({ open, onOpenChange, budget, virtualKeys }: BudgetDialogProps) {
  const editing = !!budget;
  const toast = useToast();
  const create = useCreateBudget();
  const update = useUpdateBudget();

  const [scope, setScope] = useState<string>('team'); // 'team' or a virtualKeyId
  const [period, setPeriod] = useState<BudgetPeriod>('month');
  const [limitUsd, setLimitUsd] = useState('');

  useEffect(() => {
    if (!open) return;
    if (budget) {
      setScope(budget.virtualKeyId ?? 'team');
      setPeriod(budget.period);
      setLimitUsd(String(budget.limitUsd));
    } else {
      setScope('team');
      setPeriod('month');
      setLimitUsd('');
    }
  }, [open, budget]);

  const busy = create.isPending || update.isPending;
  const limitNum = Number(limitUsd);
  const canSubmit = limitUsd.trim() !== '' && Number.isFinite(limitNum) && limitNum > 0;

  async function handleSubmit() {
    try {
      if (editing && budget) {
        await update.mutateAsync({ id: budget.id, body: { period, limitUsd: limitNum } });
        toast.success('Budget updated');
      } else {
        await create.mutateAsync({
          virtualKeyId: scope === 'team' ? null : scope,
          period,
          limitUsd: limitNum,
        });
        toast.success('Budget created');
      }
      onOpenChange(false);
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? e.code === 'BUDGET_EXISTS'
            ? 'A budget already exists for this scope and period.'
            : e.message
          : 'Could not save budget';
      toast.error(msg);
    }
  }

  const activeKeys = virtualKeys.filter((k) => !k.revokedAt);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? 'Edit budget' : 'New budget'}
      description="A spend cap. Requests are rejected before any provider call once the cap is reached."
    >
      <div className="flex flex-col gap-3">
        <Field label="Scope" htmlFor="budget-scope">
          {editing ? (
            <div className="rounded-md border border-line bg-elevated px-3 py-2 font-mono text-[13px] text-muted">
              {budget?.virtualKeyId
                ? activeKeys.find((k) => k.id === budget.virtualKeyId)?.name ?? 'Virtual key'
                : 'Team-wide'}{' '}
              · immutable
            </div>
          ) : (
            <Select id="budget-scope" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="team">Team-wide (all traffic)</option>
              {activeKeys.map((k) => (
                <option key={k.id} value={k.id}>
                  Key: {k.name}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="Period" htmlFor="budget-period">
          <Select
            id="budget-period"
            value={period}
            onChange={(e) => setPeriod(e.target.value as BudgetPeriod)}
          >
            {PERIODS.map((p) => (
              <option key={p} value={p}>
                {PERIOD_LABELS[p]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Limit (USD)" htmlFor="budget-limit" hint="Stored to 4 decimal places.">
          <Input
            id="budget-limit"
            type="number"
            min="0"
            step="0.01"
            value={limitUsd}
            onChange={(e) => setLimitUsd(e.target.value)}
            placeholder="50"
          />
        </Field>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={busy || !canSubmit} onClick={handleSubmit}>
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Create budget'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
