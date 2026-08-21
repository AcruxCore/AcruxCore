import { Button, useToast } from '@/ui';
import { useUpdateEvalRule } from '@/api';
import type { EvalRule } from '@/api/types';
import { formatDailyLimit, formatMeanScore, formatSampleRate } from './rules.helpers';

export interface RulesTableProps {
  rules: EvalRule[];
  /** Called with the row's rule when a row (or its Edit action) is clicked. */
  onSelectRule: (rule: EvalRule) => void;
  /** Called with the rule's id when its Delete action is clicked. */
  onDeleteRule: (id: string) => void;
}

/**
 * The enabled toggle for one row. A separate component so each row owns its
 * own `useUpdateEvalRule` mutation rather than the table sharing one across
 * every rule, and so a failed flip toasts without disturbing the rest of the
 * table.
 *
 * @param rule - The rule this switch controls.
 */
function EnabledToggle({ rule }: { rule: EvalRule }) {
  const toast = useToast();
  const update = useUpdateEvalRule(rule.id);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={rule.enabled}
      aria-label={`${rule.enabled ? 'Disable' : 'Enable'} ${rule.name}`}
      disabled={update.isPending}
      onClick={(e) => {
        e.stopPropagation();
        update.mutate(
          { enabled: !rule.enabled },
          { onError: () => toast.error('Could not update the rule') },
        );
      }}
      data-testid="rule-enabled-toggle"
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40 ${
        rule.enabled ? 'bg-accent' : 'bg-line'
      }`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-surface transition-all ${
          rule.enabled ? 'left-[22px]' : 'left-0.5'
        }`}
      />
    </button>
  );
}

/**
 * The rules table: one row per online-evaluation rule, each opening the rule
 * editor drawer on click (bubbled up via `onSelectRule` — the drawer itself
 * does not exist yet, see Task 20). The enabled switch flips independently of
 * that click, since toggling a rule and editing it are different intents.
 *
 * @param rules - The team's rules (already ordered by the API).
 * @param onSelectRule - Called with the clicked rule so a caller can open its editor.
 * @param onDeleteRule - Called with a rule's id when its Delete action is clicked.
 */
export function RulesTable({ rules, onSelectRule, onDeleteRule }: RulesTableProps) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-[760px] border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b border-line-soft text-[11px] uppercase tracking-[0.06em] text-faint">
            <th className="px-4 py-2.5 font-medium">Name</th>
            <th className="px-4 py-2.5 font-medium">Enabled</th>
            <th className="px-4 py-2.5 text-right font-medium">Sample rate</th>
            <th className="px-4 py-2.5 text-right font-medium">Daily limit</th>
            <th className="px-4 py-2.5 text-right font-medium">Today</th>
            <th className="px-4 py-2.5 text-right font-medium">Mean score</th>
            <th className="px-4 py-2.5 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => (
            <tr
              key={rule.id}
              onClick={() => onSelectRule(rule)}
              className="cursor-pointer border-b border-line-soft bg-surface last:border-b-0 hover:bg-elevated"
              data-testid="rule-row"
            >
              <td className="px-4 py-2.5">
                <p className="font-medium text-ink" data-testid="rule-name">
                  {rule.name}
                </p>
                <p className="mt-0.5 truncate text-[12px] text-muted" title={rule.criteria}>
                  {rule.criteria}
                </p>
              </td>
              <td className="px-4 py-2.5">
                <EnabledToggle rule={rule} />
              </td>
              <td className="px-4 py-2.5 text-right font-mono text-muted">{formatSampleRate(rule.sampleRate)}</td>
              <td className="px-4 py-2.5 text-right font-mono text-muted">{formatDailyLimit(rule.dailyLimit)}</td>
              <td className="px-4 py-2.5 text-right font-mono text-ink">{rule.todayCount}</td>
              <td className="px-4 py-2.5 text-right font-mono text-ink">{formatMeanScore(rule.todayMeanScore)}</td>
              <td className="px-4 py-2.5">
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectRule(rule);
                    }}
                    data-testid="rule-edit-button"
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteRule(rule.id);
                    }}
                    data-testid="rule-delete-button"
                  >
                    Delete
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
