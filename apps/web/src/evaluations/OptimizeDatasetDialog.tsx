import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, filterPrompts, useAliases, useAllPrompts, useCreatePrompt, useModels, useOptimize } from '@/api';
import type { StartRunResponse } from '@/api';
import { Button, Dialog, DialogFooter, Field, Input, Select, useToast } from '@/ui';
import { ModelCheckboxList } from './ModelCheckboxList';
import { PromptPicker } from './PromptPicker';

export interface OptimizeDatasetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The dataset to optimize against — already exists, no rebuild step. */
  datasetId: string;
}

/**
 * Starts an optimize attempt against a dataset that already exists, with no
 * feedback-selection or dataset-build step first (design "Optimize an existing
 * dataset") — the counterpart to `ImproveFromFeedbackDialog`, which always
 * builds a fresh dataset.
 *
 * It lives on the dataset page because the dataset is the input: the optimizer
 * reads these examples to work out what to change. What it rewrites is a
 * *prompt*, which the title says plainly — "Optimize this dataset" read as
 * though the dataset were being improved, and it never is.
 *
 * The optimizer model and optimizer prompt are surfaced here for the same
 * reason the judge surfaces its own: the run bills a model and follows
 * instructions, and neither should be invisible.
 */
export function OptimizeDatasetDialog({ open, onOpenChange, datasetId }: OptimizeDatasetDialogProps) {
  const navigate = useNavigate();
  const [promptSearch, setPromptSearch] = useState('');
  const [promptId, setPromptId] = useState('');
  const [alias, setAlias] = useState('');
  const [models, setModels] = useState<Set<string>>(new Set());
  const [optimizerModel, setOptimizerModel] = useState('');
  const [optimizerPrompt, setOptimizerPrompt] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [mismatchWarning, setMismatchWarning] = useState<{
    runId: string;
    warning: NonNullable<StartRunResponse['prompt_mismatch_warning']>;
  } | null>(null);

  const allPrompts = useAllPrompts();
  const prompts = useMemo(
    () => filterPrompts(allPrompts.data ?? [], promptSearch),
    [allPrompts.data, promptSearch],
  );
  const aliases = useAliases(promptId);
  const gatewayModels = useModels();
  const optimize = useOptimize(promptId || 'unset');
  const createPrompt = useCreatePrompt();
  const toast = useToast();

  useEffect(() => {
    if (open) {
      setPromptSearch('');
      setPromptId('');
      setAlias('');
      setModels(new Set());
      setOptimizerModel('');
      setOptimizerPrompt(null);
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
        ...(optimizerModel ? { optimizer_model: optimizerModel } : {}),
        ...(optimizerPrompt ? { optimizer_prompt_id: optimizerPrompt.id } : {}),
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
      title="Optimize a prompt"
      description="An optimizer model reads this dataset's examples, drafts candidate rewrites of a prompt, then runs them against those same examples."
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
              disabled={allPrompts.isLoading}
            >
              <option value="">{allPrompts.isLoading ? 'Loading…' : 'Select a prompt'}</option>
              {prompts.map((p) => (
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

        <Field
          label="Test the rewrites on"
          hint="One set of rewrites is written, not one per model. Each rewrite, plus the baseline, is then run against every model you tick here — so two models means the same candidates are graded twice, once per model."
        >
          {gatewayModels.isLoading ? (
            <p className="text-[13px] text-muted">Loading…</p>
          ) : (gatewayModels.data ?? []).length === 0 ? (
            <p className="text-[13px] text-muted">No models registered — add one under Gateway → Models first.</p>
          ) : (
            <ModelCheckboxList
              models={gatewayModels.data ?? []}
              selected={models}
              onToggle={toggleModel}
              idPrefix="optimize-dataset-model"
              data-testid="optimize-dataset-model-checkboxes"
            />
          )}
        </Field>

        <Field
          label="Optimizer model"
          htmlFor="optimize-dataset-optimizer-model"
          hint="The one model that writes the candidate rewrites. It is a different job from the list above, which is what the finished rewrites get tested on."
        >
          <Select
            id="optimize-dataset-optimizer-model"
            aria-label="Optimizer model"
            value={optimizerModel}
            onChange={(e) => setOptimizerModel(e.target.value)}
            disabled={gatewayModels.isLoading}
          >
            <option value="">Use the first model selected above</option>
            {(gatewayModels.data ?? []).map((m) => (
              <option key={m.id} value={m.publicName}>
                {m.publicName}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Optimizer prompt"
          htmlFor="optimize-dataset-optimizer-prompt"
          hint="Optional — rewrite using your own instructions instead of the built-in optimizer. The required JSON output format is always added for you."
        >
          <PromptPicker
            id="optimize-dataset-optimizer-prompt"
            value={optimizerPrompt}
            onChange={setOptimizerPrompt}
            placeholder="Built-in optimizer"
          />
          {!optimizerPrompt && (
            <button
              type="button"
              className="mt-1.5 self-start text-[12px] text-accent hover:underline"
              onClick={async () => {
                try {
                  const created = await createPrompt.mutateAsync({ name: 'Optimizer instructions' });
                  setOptimizerPrompt({ id: created.id, name: created.name });
                  toast.success('Prompt created — write its optimizer instructions, then commit a version.');
                } catch (e) {
                  toast.error(e instanceof ApiError ? e.message : 'Could not create the prompt');
                }
              }}
            >
              + Create a new optimizer prompt
            </button>
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
