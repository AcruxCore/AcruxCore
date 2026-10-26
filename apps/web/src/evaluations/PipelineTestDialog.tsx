import { useState } from 'react';
import {
  ApiError,
  useCommitCandidate,
  usePrompt,
  useRun,
  useRunCandidate,
  useRunReport,
  useVersionById,
} from '@/api';
import { Button, CopyButton, Dialog, DialogFooter, Empty, PageSpinner, Tabs } from '@/ui';
import { pipelineTestSnippets } from './pipeline-test-snippet';

/** Props of {@link PipelineTestDialog}. */
export interface PipelineTestDialogProps {
  /** Whether the dialog is shown. Nothing is fetched while it is closed. */
  open: boolean;
  /** Called when the dialog asks to open or close (Escape, a click outside it, or Close). */
  onOpenChange: (open: boolean) => void;
  /** The optimize run the candidate was drafted for. */
  runId: string;
  /** `prompt_candidates` row UUID to test. */
  candidateId: string;
}

const LANGS = [
  { value: 'python', label: 'Python' },
  { value: 'node', label: 'Node' },
];

/**
 * "Test in your pipeline" (phase-5 FAQ Q58). The optimize run scored a candidate with one
 * gateway call per example — no tools offered, earlier turns replayed as recorded.
 * A rewrite can change which tools the model calls and what it retrieves, and only the
 * team's own app can run those. This dialog commits the candidate as a version (no alias
 * moves) and hands over the SDK code that runs the app on production and on the candidate
 * side by side, graded by the run's judge.
 */
export function PipelineTestDialog({ open, onOpenChange, runId, candidateId }: PipelineTestDialogProps) {
  const [lang, setLang] = useState('python');
  const [error, setError] = useState<string | null>(null);
  const candidate = useRunCandidate(open ? runId : null, open ? candidateId : null);
  const run = useRun(open ? runId : null);
  const report = useRunReport(open ? runId : null);
  const commit = useCommitCandidate(runId, candidateId);
  const prompt = usePrompt(candidate.data?.promptId ?? '');
  // The report names the judge prompt's version; the SDK's judge takes the prompt.
  const judgeVersionId = report.data?.judge?.promptVersionId ?? null;
  const judgeVersion = useVersionById(open ? judgeVersionId : null);

  const versionNumber = commit.data?.version.versionNumber ?? candidate.data?.versionNumber ?? null;
  const promptName = commit.data?.promptName ?? prompt.data?.name ?? null;

  async function handleCommit() {
    setError(null);
    try {
      await commit.mutateAsync();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not commit this candidate.');
    }
  }

  const loading = candidate.isLoading || run.isLoading || report.isLoading || judgeVersion.isLoading;
  // Without the report there is no way to know the run's judge, and code that guessed
  // would grade differently from the leaderboard without saying so.
  const judgeUnknown = report.isError;
  // The run graded with a custom judge prompt whose version can no longer be read.
  const judgeLost = !!judgeVersionId && judgeVersion.isError;
  const snippets =
    versionNumber !== null && promptName && run.data && candidate.data && !judgeUnknown
      ? pipelineTestSnippets({
          datasetId: run.data.datasetId,
          judgeModel: report.data?.judge?.model ?? null,
          runModel: run.data.grid[0]?.model ?? '',
          judgePromptId: judgeVersion.data?.promptId ?? null,
          judgePromptVersion: judgeVersion.data?.versionNumber ?? null,
          judgePromptLost: judgeLost,
          promptName,
          versionNumber,
          label: candidate.data.label,
        })
      : null;
  const code = snippets ? (lang === 'python' ? snippets.python : snippets.node) : '';

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={candidate.data ? `Test ${candidate.data.label} in your pipeline` : 'Test in your pipeline'}
      description="Run your own app — retrieval, tools and code — on this rewrite before you promote it."
      className="max-w-2xl"
    >
      {loading ? (
        <PageSpinner />
      ) : candidate.isError || !candidate.data ? (
        <Empty title="Could not load this candidate" description="Something went wrong. Try again." />
      ) : (
        <div className="flex max-h-[65vh] flex-col gap-4 overflow-y-auto" data-testid="pipeline-test-dialog">
          <p className="text-[13px] text-muted">
            This run scored the rewrite with one model call per example. That call had no tools and no retrieval,
            and any earlier turns were replayed as recorded. With the new wording, your app may search or call tools
            differently. Only running the app itself shows that.
          </p>

          {versionNumber === null ? (
            <div className="flex flex-col gap-2 rounded-md border border-line-soft bg-elevated px-3 py-3">
              <p className="text-[13px] text-ink">
                First, commit the rewrite as a version. No alias moves, so production keeps serving what it serves now.
                Promoting later reuses this same version.
              </p>
              <div>
                <Button variant="primary" size="sm" onClick={handleCommit} disabled={commit.isPending} data-testid="pipeline-test-commit">
                  {commit.isPending ? 'Committing…' : 'Commit as a version'}
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-[13px] text-ink" data-testid="pipeline-test-version">
              Committed as <span className="font-mono font-semibold">{promptName} v{versionNumber}</span>. Nothing points at
              it yet. Your app pins it only inside the variant below.
            </p>
          )}

          {judgeUnknown && versionNumber !== null && (
            <p className="text-[13px] text-danger" data-testid="pipeline-test-judge-error">
              Could not load the judge this run graded with, so the code cannot be shown yet. Close this dialog
              and open it again.
            </p>
          )}

          {judgeLost && snippets && (
            <p className="text-[13px] text-warn" data-testid="pipeline-test-judge-warning">
              This run graded with a custom judge prompt that can no longer be read: it was deleted, or it failed
              to load. The code below grades with the built-in judge instead, so those scores will not compare with
              this run's scores.
            </p>
          )}

          {snippets && (
            <div className="flex flex-col gap-2">
              <div className="flex items-end justify-between gap-2">
                <Tabs items={LANGS} value={lang} onChange={setLang} />
                <CopyButton value={code} />
              </div>
              <pre className="overflow-x-auto rounded-md border border-line-soft bg-surface px-3 py-2.5 font-mono text-[12px] leading-relaxed text-ink">
                {code}
              </pre>
              <p className="text-[12px] text-muted">
                Both variants run at the same time on the dataset this run used. Inside the candidate variant, every
                SDK render of <span className="font-mono">{promptName}</span> returns v{versionNumber}, so your code
                does not change. If your app sends the prompt to the gateway as a <span className="font-mono">prompt</span>{' '}
                reference instead, send the number that <span className="font-mono">pinned_version(…)</span> returns as the{' '}
                <span className="font-mono">version</span> field of that reference. When both runs finish, open the printed link to
                compare them per example.
              </p>
            </div>
          )}

          {error && <p className="text-[13px] text-danger">{error}</p>}
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
