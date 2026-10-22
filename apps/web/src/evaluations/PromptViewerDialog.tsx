import { useMemo, useState } from 'react';
import { useRunCandidate, useVersionById, useVersions } from '@/api';
import { cn } from '@/lib/cn';
import { Button, CopyButton, Dialog, DialogFooter, Empty, PageSpinner, Select } from '@/ui';
import { formatMessages } from './format-messages';
import { buildSideBySide } from './side-by-side-diff';
import type { DiffCell } from './side-by-side-diff';

/**
 * A prompt template the viewer can show: either a committed version or an
 * optimizer-drafted candidate. `key` is unique within one picker.
 */
export interface PromptSource {
  key: string;
  /** What the reader sees, e.g. `candidate-A` or `v1 (production)`. */
  label: string;
  kind: 'version' | 'candidate';
  versionId?: string;
  candidateId?: string;
}

/** Props for {@link PromptViewerDialog}. */
export interface PromptViewerDialogProps {
  /** Whether the dialog is shown. Nothing is fetched while it is closed. */
  open: boolean;
  /** Called with `false` when the reader closes the dialog (Close, Esc or the overlay). */
  onOpenChange: (open: boolean) => void;
  /** The run the prompt was evaluated in; candidates are read through it. */
  runId: string;
  /** The prompt to show. */
  source: PromptSource;
  /** Every prompt variant in the run, offered first in the compare picker. May include `source` itself. */
  runSources: PromptSource[];
}

/** The loaded text of one {@link PromptSource}, from whichever endpoint owns it. */
function usePromptText(runId: string, source: PromptSource | null) {
  const candidate = useRunCandidate(
    source?.kind === 'candidate' ? runId : null,
    source?.kind === 'candidate' ? source.candidateId ?? null : null,
  );
  const version = useVersionById(source?.kind === 'version' ? source.versionId ?? null : null);
  const query = source?.kind === 'candidate' ? candidate : version;
  const data = source?.kind === 'candidate' ? candidate.data : version.data;

  return {
    isLoading: !!source && query.isLoading,
    isError: !!source && query.isError,
    text: data ? formatMessages(data.messages) : null,
    promptId: data?.promptId ?? null,
    rationale: candidate.data?.rationale ?? null,
    promptName: version.data?.promptName ?? null,
    versionNumber: version.data?.versionNumber ?? null,
  };
}

/** Colours for a whole line, and the stronger mark for the words that changed inside it. */
const CELL_STYLES: Record<DiffCell['kind'], { line: string; word: string }> = {
  same: { line: 'text-ink', word: '' },
  removed: { line: 'bg-danger-bg text-ink', word: 'rounded-sm bg-danger/30' },
  added: { line: 'bg-ok-bg text-ink', word: 'rounded-sm bg-ok/30' },
};

/** One side of a diff row; an empty side is shaded so the gap reads as "no line here". */
function DiffSide({ cell }: { cell: DiffCell | null }) {
  if (!cell) return <div className="bg-elevated/60" />;
  const style = CELL_STYLES[cell.kind];
  return (
    <div className={cn('whitespace-pre-wrap break-words px-3 py-px', style.line)}>
      {cell.segments.map((s, i) =>
        s.changed ? (
          <mark key={i} className={cn('text-ink', style.word)}>
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
      {cell.segments.every((s) => s.text === '') && ' '}
    </div>
  );
}

/** Two prompt texts side by side, matching lines aligned, changed words marked. */
function SideBySide({ before, after, beforeLabel, afterLabel }: { before: string; after: string; beforeLabel: string; afterLabel: string }) {
  const diff = useMemo(() => buildSideBySide(before, after), [before, after]);
  const identical = diff.added === 0 && diff.removed === 0;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12.5px] text-muted" data-testid="prompt-diff-summary">
        {identical ? (
          'The two prompts are identical.'
        ) : (
          <>
            <span className="text-danger">−{diff.removed} line{diff.removed === 1 ? '' : 's'}</span>
            {' · '}
            <span className="text-ok">+{diff.added} line{diff.added === 1 ? '' : 's'}</span>
            {' '}from {beforeLabel} to {afterLabel}
          </>
        )}
      </p>
      <div className="overflow-hidden rounded-xl border border-line bg-surface" data-testid="prompt-diff">
        <div className="grid grid-cols-2 border-b border-line bg-elevated text-[11px] uppercase tracking-[0.06em] text-faint">
          <div className="border-r border-line px-3 py-2">{beforeLabel}</div>
          <div className="px-3 py-2">{afterLabel}</div>
        </div>
        <div className="max-h-[55vh] overflow-y-auto font-mono text-[12.5px] leading-relaxed">
          {diff.rows.map((row, i) => (
            <div key={i} className="grid grid-cols-2">
              <div className="border-r border-line-soft">
                <DiffSide cell={row.left} />
              </div>
              <DiffSide cell={row.right} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Large read-only view of one prompt from a run report: an optimizer-drafted
 * candidate or a committed version. Reading a candidate here changes nothing;
 * it stays a draft until someone promotes it.
 *
 * The compare picker diffs this prompt against another variant in the same
 * run, or against any committed version of the prompt. Variants in the run
 * come first, because "why did this one score higher than that one" is the
 * question a run report raises.
 *
 * Any team member can open it: reading a candidate needs no promote-right.
 *
 * @param open - Whether the dialog is shown; nothing is fetched while it is closed.
 * @param onOpenChange - Called with `false` when the reader closes the dialog.
 * @param runId - The run the prompt was evaluated in.
 * @param source - The prompt to show.
 * @param runSources - Every prompt variant in the run; `source` itself is left out of the picker.
 * @returns The dialog element.
 */
export function PromptViewerDialog({ open, onOpenChange, runId, source, runSources }: PromptViewerDialogProps) {
  const [compareKey, setCompareKey] = useState('');
  const current = usePromptText(runId, open ? source : null);
  const versions = useVersions(open ? current.promptId ?? '' : '');

  const runVersionIds = new Set(runSources.map((s) => s.versionId).filter(Boolean));
  const inRun = runSources.filter((s) => s.key !== source.key);
  const otherVersions: PromptSource[] = (versions.data ?? [])
    .filter((v) => !runVersionIds.has(v.id))
    .sort((a, b) => b.versionNumber - a.versionNumber)
    .map((v) => ({ key: `version:${v.id}`, label: `v${v.versionNumber}`, kind: 'version', versionId: v.id }));
  const compareTo = [...inRun, ...otherVersions].find((s) => s.key === compareKey) ?? null;
  const compared = usePromptText(runId, open ? compareTo : null);

  const description =
    source.kind === 'candidate'
      ? 'A rewrite the optimizer drafted for this run. It is not a prompt version until someone promotes it.'
      : current.versionNumber !== null && current.promptName
        ? `Version ${current.versionNumber} of ${current.promptName}.`
        : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`Prompt · ${source.label}`} description={description} className="max-w-6xl">
      {current.isLoading ? (
        <PageSpinner />
      ) : current.isError || current.text === null ? (
        <Empty title="Could not load this prompt" description="Something went wrong. Try again." />
      ) : (
        <div className="flex flex-col gap-4" data-testid="prompt-viewer">
          {current.rationale && (
            <div className="rounded-md border border-line-soft bg-elevated px-3 py-2 text-[13px] text-ink">
              <span className="mb-1 block text-[11px] uppercase tracking-[0.06em] text-faint">Optimizer's rationale</span>
              {current.rationale}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-[13px] text-muted">
              Compare with
              <Select
                value={compareKey}
                onChange={(e) => setCompareKey(e.target.value)}
                className="w-64"
                data-testid="prompt-compare-select"
              >
                <option value="">Nothing (show this prompt)</option>
                {inRun.length > 0 && (
                  <optgroup label="In this run">
                    {inRun.map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.label}
                      </option>
                    ))}
                  </optgroup>
                )}
                {otherVersions.length > 0 && (
                  <optgroup label="Other versions of this prompt">
                    {otherVersions.map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.label}
                      </option>
                    ))}
                  </optgroup>
                )}
              </Select>
            </label>
            <CopyButton value={current.text} label="Copy prompt" />
          </div>
          {/* Without this the "Other versions" group would just be missing, and the
              reader would take it that the prompt has no other versions. */}
          {versions.isError && (
            <p className="-mt-2 text-[12px] text-danger" data-testid="prompt-versions-error">
              Could not load the other versions of this prompt. Only the variants in this run can be compared.
            </p>
          )}

          {!compareTo ? (
            <pre
              className="max-h-[55vh] overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-surface px-4 py-3 font-mono text-[12.5px] leading-relaxed text-ink"
              data-testid="prompt-text"
            >
              {current.text}
            </pre>
          ) : compared.isLoading ? (
            <PageSpinner />
          ) : compared.isError || compared.text === null ? (
            <Empty title="Could not load the other prompt" description="Something went wrong. Try again." />
          ) : (
            <SideBySide before={compared.text} after={current.text} beforeLabel={compareTo.label} afterLabel={source.label} />
          )}
        </div>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
