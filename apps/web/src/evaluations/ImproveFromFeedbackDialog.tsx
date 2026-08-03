import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, useCreateDatasetFromFeedback, useModels, usePrompts, useOptimize } from '@/api';
import { Button, Dialog, DialogFooter, Field, Input, Select, Textarea } from '@/ui';

export interface ImproveFromFeedbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Ids of the feedback rows selected on the feedback list page. */
  feedbackIds: string[];
  /** Called once the optimize run has been kicked off — the caller uses this to clear its selection. */
  onStarted?: () => void;
}

/**
 * "Improve from feedback": builds a dataset from the selected feedback rows
 * (same `POST /datasets/from-feedback` call `CreateDatasetDialog` uses), then
 * kicks off an optimize attempt against a prompt the user names explicitly.
 *
 * A feedback row only carries `traceId`/`spanId` (see `Feedback` in
 * `api/types.ts`) — there is no field, and no endpoint, that resolves a
 * feedback row (or the `promptVersionId` a linked span may carry) back to
 * its owning prompt id. Rather than guess at an inference path with no data
 * to support it — silently optimizing the WRONG prompt would be a real
 * footgun — this dialog asks the user to pick the target prompt and models
 * explicitly, the same explicit-picker pattern `ExperimentConfigPage` already
 * uses for prompt/model selection.
 */
export function ImproveFromFeedbackDialog({ open, onOpenChange, feedbackIds, onStarted }: ImproveFromFeedbackDialogProps) {
  const navigate = useNavigate();
  const createDataset = useCreateDatasetFromFeedback();
  const [promptSearch, setPromptSearch] = useState('');
  const [promptId, setPromptId] = useState('');
  const [models, setModels] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [overallFeedback, setOverallFeedback] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const prompts = usePrompts({ search: promptSearch || undefined });
  const gatewayModels = useModels();
  const optimize = useOptimize(promptId || 'unset');

  useEffect(() => {
    if (open) {
      setPromptSearch('');
      setPromptId('');
      setModels(new Set());
      setName('');
      setOverallFeedback('');
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  function toggleModel(name: string, checked: boolean) {
    setModels((cur) => {
      const next = new Set(cur);
      if (checked) next.add(name);
      else next.delete(name);
      return next;
    });
  }

  async function handleSubmit() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Name is required.');
      return;
    }
    if (!promptId) {
      setError('Pick the prompt to improve.');
      return;
    }
    if (models.size === 0) {
      setError('Pick at least one model.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const dataset = await createDataset.mutateAsync({
        name: trimmedName,
        overall_feedback: overallFeedback.trim() || undefined,
        feedback_ids: feedbackIds,
      });
      const { run_id } = await optimize.mutateAsync({
        dataset_id: dataset.id,
        models: [...models],
      });
      onStarted?.();
      onOpenChange(false);
      navigate(`/evaluations/runs/${run_id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not start the optimize run.');
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Improve from feedback"
      description={`Builds a dataset from ${feedbackIds.length} selected feedback row${feedbackIds.length === 1 ? '' : 's'}, then drafts and runs candidate rewrites against it.`}
    >
      <div className="flex flex-col gap-4">
        <Field label="Dataset name" htmlFor="improve-dataset-name">
          <Input
            id="improve-dataset-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="regression-suite"
            autoFocus
          />
        </Field>

        <Field label="Overall feedback" htmlFor="improve-overall-feedback" hint="Optional. Shown to the optimizer as extra context.">
          <Textarea
            id="improve-overall-feedback"
            rows={3}
            value={overallFeedback}
            onChange={(e) => setOverallFeedback(e.target.value)}
            placeholder="What these examples have in common."
          />
        </Field>

        <Field label="Prompt to improve" htmlFor="improve-prompt-search" hint="Which prompt's production version the optimizer should rewrite.">
          <div className="flex flex-col gap-2">
            <Input
              id="improve-prompt-search"
              value={promptSearch}
              onChange={(e) => setPromptSearch(e.target.value)}
              placeholder="Search prompts…"
            />
            <Select
              aria-label="Prompt to improve"
              value={promptId}
              onChange={(e) => setPromptId(e.target.value)}
              disabled={prompts.isLoading}
            >
              <option value="">{prompts.isLoading ? 'Loading…' : 'Select a prompt'}</option>
              {(prompts.data?.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </div>
        </Field>

        <Field label="Models" hint="At least one — candidates (plus the production baseline) are run against every selected model.">
          {gatewayModels.isLoading ? (
            <p className="text-[13px] text-muted">Loading…</p>
          ) : (gatewayModels.data ?? []).length === 0 ? (
            <p className="text-[13px] text-muted">No models registered — add one under Gateway → Models first.</p>
          ) : (
            <ul className="flex flex-col gap-1.5 rounded-md border border-line-soft bg-elevated p-2.5" data-testid="improve-model-checkboxes">
              {(gatewayModels.data ?? []).map((m) => (
                <li key={m.id} className="flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    id={`improve-model-${m.id}`}
                    checked={models.has(m.publicName)}
                    onChange={(e) => toggleModel(m.publicName, e.target.checked)}
                    className="h-4 w-4 accent-varhi"
                  />
                  <label htmlFor={`improve-model-${m.id}`} className="flex-1 cursor-pointer">
                    <span className="font-mono">{m.publicName}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </Field>

        {error && <p className="text-[13px] text-danger">{error}</p>}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={submitting} onClick={handleSubmit}>
          {submitting ? 'Starting…' : 'Improve'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
