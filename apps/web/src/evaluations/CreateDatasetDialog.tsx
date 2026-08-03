import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, useCreateDatasetFromFeedback } from '@/api';
import type { CreateDatasetFromFeedbackResult } from '@/api';
import { Button, Dialog, DialogFooter, Field, Input, Textarea, useToast } from '@/ui';
import { formatSkipped } from './format-skipped';

export interface CreateDatasetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Ids of the feedback rows selected on the feedback list page. */
  feedbackIds: string[];
  /** Called once the dataset is created — the caller uses this to clear its selection. */
  onCreated?: () => void;
}

/**
 * Builds a dataset from the feedback rows the user checked on the feedback list
 * page. Posts `{ name, overall_feedback, feedback_ids }` to
 * `POST /datasets/from-feedback`; on success shows how many examples were added
 * vs. skipped (a feedback row is skipped when it has no captured input
 * variables to seed an example from) and a link to the new dataset.
 */
export function CreateDatasetDialog({ open, onOpenChange, feedbackIds, onCreated }: CreateDatasetDialogProps) {
  const toast = useToast();
  const create = useCreateDatasetFromFeedback();
  const [name, setName] = useState('');
  const [overallFeedback, setOverallFeedback] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateDatasetFromFeedbackResult | null>(null);

  // Reset to a fresh form every time the dialog is (re)opened.
  useEffect(() => {
    if (open) {
      setName('');
      setOverallFeedback('');
      setError(null);
      setResult(null);
    }
  }, [open]);

  async function handleCreate() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Name is required.');
      return;
    }
    setError(null);
    try {
      const created = await create.mutateAsync({
        name: trimmedName,
        overall_feedback: overallFeedback.trim() || undefined,
        feedback_ids: feedbackIds,
      });
      setResult(created);
      onCreated?.();
      toast.success(`Created dataset "${created.name}"`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not create dataset.');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={result ? 'Dataset created' : 'Create dataset from feedback'}
      description={
        result
          ? undefined
          : `Builds a dataset from ${feedbackIds.length} selected feedback row${feedbackIds.length === 1 ? '' : 's'}.`
      }
    >
      {result ? (
        <div className="flex flex-col gap-3" data-testid="create-dataset-result">
          <p className="text-[13px] text-ink">{formatSkipped(result.example_count, result.skipped)}</p>
          {result.skipped.length > 0 && (
            <ul className="flex flex-col gap-1 rounded-md border border-line-soft bg-elevated p-2.5 text-[12px] text-muted">
              {result.skipped.map((s) => (
                <li key={s.feedbackId}>
                  <span className="font-mono text-faint">{s.feedbackId.slice(0, 8)}</span> — {s.reason}
                </li>
              ))}
            </ul>
          )}
          <Link to={`/evaluations/datasets/${result.id}`} className="text-[13px] text-varhi hover:underline">
            View dataset "{result.name}"
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Field label="Name" htmlFor="dataset-name" error={error ?? undefined} hint="What this dataset is for.">
            <Input
              id="dataset-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="regression-suite"
              autoFocus
            />
          </Field>
          <Field label="Overall feedback" htmlFor="dataset-overall-feedback" hint="Optional. Shown to the optimizer as extra context.">
            <Textarea
              id="dataset-overall-feedback"
              rows={3}
              value={overallFeedback}
              onChange={(e) => setOverallFeedback(e.target.value)}
              placeholder="What these examples have in common."
            />
          </Field>
        </div>
      )}
      <DialogFooter>
        {result ? (
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={create.isPending} onClick={handleCreate}>
              {create.isPending ? 'Creating…' : 'Create dataset'}
            </Button>
          </>
        )}
      </DialogFooter>
    </Dialog>
  );
}
