import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, useAliases, useModels, usePrompts, useOptimize } from '@/api';
import type { StartRunResponse } from '@/api';
import { Button, Dialog, DialogFooter, Field, Input, Select } from '@/ui';

export interface OptimizeDatasetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The dataset to optimize against — already exists, no rebuild step. */
  datasetId: string;
}

/**
 * "Optimize this dataset": kicks off an optimize attempt directly against a
 * dataset that already exists, with no feedback-selection or dataset-build
 * step first (design "Optimize an existing dataset") — the counterpart to
 * `ImproveFromFeedbackDialog`, which always builds a fresh dataset.
 */
export function OptimizeDatasetDialog({ open, onOpenChange, datasetId }: OptimizeDatasetDialogProps) {
  const navigate = useNavigate();
  const [promptSearch, setPromptSearch] = useState('');
  const [promptId, setPromptId] = useState('');
  const [alias, setAlias] = useState('');
  const [models, setModels] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [mismatchWarning, setMismatchWarning] = useState<{
    runId: string;
    warning: NonNullable<StartRunResponse['prompt_mismatch_warning']>;
  } | null>(null);

  const prompts = usePrompts({ search: promptSearch || undefined });
  const aliases = useAliases(promptId);
  const gatewayModels = useModels();
  const optimize = useOptimize(promptId || 'unset');

  useEffect(() => {
    if (open) {
      setPromptSearch('');
      setPromptId('');
      setAlias('');
      setModels(new Set());
      setError(null);
      setSubmitting(false);
      setMismatchWarning(null);
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
      const result = await optimize.mutateAsync({
        dataset_id: datasetId,
        models: [...models],
        ...(alias ? { alias } : {}),
      });
      if (result.prompt_mismatch_warning) {
        setMismatchWarning({ runId: result.run_id, warning: result.prompt_mismatch_warning });
        setSubmitting(false);
        return;
      }
      onOpenChange(false);
      navigate(`/evaluations/runs/${result.run_id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not start the optimize run.');
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Optimize this dataset"
      description="Drafts candidate rewrites for a prompt and runs them against this dataset's existing examples."
    >
      <div className="flex flex-col gap-4">
        <Field label="Prompt to improve" htmlFor="optimize-dataset-prompt-search" hint="Which prompt's version the optimizer should rewrite.">
          <div className="flex flex-col gap-2">
            <Input
              id="optimize-dataset-prompt-search"
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

        {promptId && (
          <Field label="Baseline alias" htmlFor="optimize-dataset-alias" hint="Which version to compare candidates against. Leave unset to use production, falling back to the latest committed version if there's no production alias yet.">
            <Select
              aria-label="Baseline alias"
              id="optimize-dataset-alias"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              disabled={aliases.isLoading}
            >
              <option value="">Use production (or latest)</option>
              {(aliases.data ?? []).map((a) => (
                <option key={a.id} value={a.alias}>{a.alias} (v{a.versionNumber})</option>
              ))}
            </Select>
          </Field>
        )}

        <Field label="Models" hint="At least one — candidates (plus the baseline) are run against every selected model.">
          {gatewayModels.isLoading ? (
            <p className="text-[13px] text-muted">Loading…</p>
          ) : (gatewayModels.data ?? []).length === 0 ? (
            <p className="text-[13px] text-muted">No models registered — add one under Gateway → Models first.</p>
          ) : (
            <ul className="flex flex-col gap-1.5 rounded-md border border-line-soft bg-elevated p-2.5" data-testid="optimize-dataset-model-checkboxes">
              {(gatewayModels.data ?? []).map((m) => (
                <li key={m.id} className="flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    id={`optimize-dataset-model-${m.id}`}
                    checked={models.has(m.publicName)}
                    onChange={(e) => toggleModel(m.publicName, e.target.checked)}
                    className="h-4 w-4 accent-varhi"
                  />
                  <label htmlFor={`optimize-dataset-model-${m.id}`} className="flex-1 cursor-pointer">
                    <span className="font-mono">{m.publicName}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </Field>

        {mismatchWarning && (
          <p className="text-[13px] text-warn">
            Heads up: this dataset's examples came from{' '}
            {mismatchWarning.warning.mismatched_prompts.map((p) => `"${p.name}" (${p.example_count})`).join(', ')},
            not the prompt you picked. The run has started anyway.
          </p>
        )}
        {error && <p className="text-[13px] text-danger">{error}</p>}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={submitting}
          onClick={mismatchWarning ? () => navigate(`/evaluations/runs/${mismatchWarning.runId}`) : handleSubmit}
        >
          {submitting ? 'Starting…' : mismatchWarning ? 'Open run' : 'Optimize'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
