import { useState } from 'react';
import { ApiError, useAliases, useRunCandidate, useRunCell, useVersion, usePromoteCandidate } from '@/api';
import type { Message } from '@/api/types';
import { Button, Dialog, DialogFooter, Empty, Field, Input, MonoBlock, PageSpinner, useToast } from '@/ui';

export interface PromoteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The run the candidate was drafted for (also the run `usePromoteCandidate` posts to). */
  runId: string;
  /** `prompt_candidates` row UUID to promote. */
  candidateId: string;
  /** The candidate's grid cell key — used to pull its judge evidence via `useRunCell`. */
  cellKey: string;
}

/** Renders a messages array as readable `role: content` text for the template panels. */
function formatMessages(messages: Message[]): string {
  return messages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n');
}

/**
 * Promote-review dialog (E7 Task 5) — the human-in-the-loop checkpoint before
 * `POST /runs/:id/promote` turns a disposable, optimizer-drafted candidate
 * into a real, immutable `PromptVersion`. Shows what is about to change (the
 * candidate's template vs. the prompt's current `production` template, plus
 * the optimizer's own rationale) and the judge evidence for that exact cell
 * (scores/reasons per example, via `useRunCell` — the same drill-down data
 * `CellDrilldownPanel` already renders), so a human can make an informed
 * call before an irreversible version-creation action.
 */
export function PromoteDialog({ open, onOpenChange, runId, candidateId, cellKey }: PromoteDialogProps) {
  const toast = useToast();
  const [alias, setAlias] = useState('production');
  const [error, setError] = useState<string | null>(null);

  const candidate = useRunCandidate(open ? runId : null, open ? candidateId : null);
  const promptId = candidate.data?.promptId ?? null;
  const aliases = useAliases(promptId ?? '');
  const productionVersionNumber = aliases.data?.find((a) => a.alias === 'production')?.versionNumber ?? null;
  const productionVersion = useVersion(promptId ?? '', productionVersionNumber);
  const cell = useRunCell(runId, open ? cellKey : null);
  const promote = usePromoteCandidate(runId);

  async function handleConfirm() {
    setError(null);
    try {
      const result = await promote.mutateAsync({ prompt_candidate_id: candidateId, alias: alias.trim() || 'production' });
      toast.success(`Promoted to v${result.version.versionNumber} — "${result.alias.alias}" now points there.`);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not promote this candidate.');
    }
  }

  const loading = candidate.isLoading || aliases.isLoading || (!!productionVersionNumber && productionVersion.isLoading);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={candidate.data ? `Promote ${candidate.data.label}` : 'Promote candidate'}
      description="Review the template change and judge evidence before promoting."
      className="max-w-2xl"
    >
      {loading ? (
        <PageSpinner />
      ) : candidate.isError || !candidate.data ? (
        <Empty title="Could not load this candidate" description="Something went wrong. Try again." />
      ) : (
        <div className="flex max-h-[65vh] flex-col gap-4 overflow-y-auto">
          {candidate.data.rationale && (
            <div className="rounded-md border border-line-soft bg-elevated px-3 py-2 text-[13px] text-ink">
              <span className="mb-1 block text-[11px] uppercase tracking-[0.06em] text-faint">Optimizer's rationale</span>
              {candidate.data.rationale}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <MonoBlock
              label={productionVersionNumber ? `Current production (v${productionVersionNumber})` : 'Current production'}
              value={productionVersion.data ? formatMessages(productionVersion.data.messages) : '(no production version yet)'}
            />
            <MonoBlock label={`Proposed (${candidate.data.label})`} value={formatMessages(candidate.data.messages)} />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-[0.06em] text-faint">Judge evidence for this cell</span>
            {cell.isLoading ? (
              <PageSpinner />
            ) : cell.data && cell.data.examples.length > 0 ? (
              <ul className="flex flex-col gap-1.5">
                {cell.data.examples.map((ex) => (
                  <li key={ex.exampleId} className="rounded-md border border-line-soft bg-surface px-2.5 py-2 text-[12.5px]">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-semibold text-ink">{ex.score === null ? '—' : ex.score.toFixed(1)}</span>
                      <span className={ex.passed ? 'text-ok' : ex.passed === false ? 'text-danger' : 'text-faint'}>
                        {ex.passed === null ? 'Unscored' : ex.passed ? '▲ Passed' : '▼ Failed'}
                      </span>
                    </div>
                    {ex.reason && <p className="mt-1 text-muted">{ex.reason}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-faint">No scored examples for this cell yet.</p>
            )}
          </div>

          <Field label="Alias to move" htmlFor="promote-alias" hint="Which alias should point at the new version.">
            <Input id="promote-alias" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="production" />
          </Field>

          {error && <p className="text-[13px] text-danger">{error}</p>}
        </div>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={promote.isPending || loading || !candidate.data} onClick={handleConfirm}>
          {promote.isPending ? 'Promoting…' : 'Promote'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
