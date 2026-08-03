import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ApiError,
  useCreateExperiment,
  useDataset,
  useModels,
  usePrompts,
  useStartRun,
  useVersions,
} from '@/api';
import { Button, Empty, Field, Input, PageSpinner, Select } from '@/ui';

/** Toggles membership of `id` in a `Set`, returning a new set (never mutates in place). */
function toggled(set: Set<string>, id: string, checked: boolean): Set<string> {
  const next = new Set(set);
  if (checked) next.add(id);
  else next.delete(id);
  return next;
}

/**
 * The `/evaluations/datasets/:id/run` screen: configure and start an
 * experiment against this dataset — pick the prompt under test, the specific
 * versions to sweep, and the models to run each version against. There is no
 * multi-select primitive in the `ui/` kit, so versions and models are plain
 * checkbox lists (the same pattern the feedback list page uses for row
 * selection).
 */
export function ExperimentConfigPage() {
  const { id: datasetId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const dataset = useDataset(datasetId ?? null);

  const [promptSearch, setPromptSearch] = useState('');
  const [promptId, setPromptId] = useState('');
  const [versionIds, setVersionIds] = useState<Set<string>>(new Set());
  const [models, setModels] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const prompts = usePrompts({ search: promptSearch || undefined });
  const versions = useVersions(promptId);
  const gatewayModels = useModels();

  const createExperiment = useCreateExperiment();
  const startRun = useStartRun();
  const submitting = createExperiment.isPending || startRun.isPending;

  function selectPrompt(next: string) {
    setPromptId(next);
    setVersionIds(new Set());
  }

  async function handleSubmit() {
    if (!datasetId) return;
    if (!promptId) {
      setError('Pick a prompt.');
      return;
    }
    if (versionIds.size === 0) {
      setError('Pick at least one prompt version.');
      return;
    }
    if (models.size === 0) {
      setError('Pick at least one model.');
      return;
    }
    setError(null);
    try {
      const experiment = await createExperiment.mutateAsync({
        dataset_id: datasetId,
        prompt_id: promptId,
        name: name.trim() || undefined,
        version_ids: [...versionIds],
        models: [...models],
      });
      const { run_id } = await startRun.mutateAsync(experiment.id);
      navigate(`/evaluations/runs/${run_id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not start the run.');
    }
  }

  if (dataset.isLoading) return <PageSpinner />;
  if (dataset.isError || !dataset.data) {
    return <Empty title="Dataset not found" description="This dataset does not exist or is not in your team." />;
  }

  return (
    <div className="flex flex-col gap-5">
      <Link to={`/evaluations/datasets/${dataset.data.id}`} className="text-[12px] text-muted hover:text-ink">
        ← {dataset.data.name}
      </Link>

      <header>
        <h1 className="text-[20px] font-semibold tracking-tight">Run experiment</h1>
        <p className="mt-1 text-[13px] text-muted">
          Sweep prompt versions and models against "{dataset.data.name}" ({dataset.data.exampleCount} example
          {dataset.data.exampleCount === 1 ? '' : 's'}).
        </p>
      </header>

      <div className="flex max-w-2xl flex-col gap-5">
        <Field label="Experiment name" htmlFor="experiment-name" hint="Optional.">
          <Input
            id="experiment-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. greeting sweep"
          />
        </Field>

        <Field label="Prompt" htmlFor="experiment-prompt-search" hint="The prompt whose versions you want to compare.">
          <div className="flex flex-col gap-2">
            <Input
              id="experiment-prompt-search"
              value={promptSearch}
              onChange={(e) => setPromptSearch(e.target.value)}
              placeholder="Search prompts…"
            />
            <Select
              aria-label="Prompt"
              value={promptId}
              onChange={(e) => selectPrompt(e.target.value)}
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
          <Field label="Versions" hint="At least one. The run adds an automatic production baseline for comparison.">
            {versions.isLoading ? (
              <PageSpinner />
            ) : versions.isError ? (
              <Empty title="Couldn’t load versions" description="Something went wrong. Try again." />
            ) : (versions.data?.data ?? []).length === 0 ? (
              <Empty title="No versions yet" description="This prompt has no committed versions." />
            ) : (
              <ul className="flex flex-col gap-1.5 rounded-md border border-line-soft bg-elevated p-2.5" data-testid="version-checkboxes">
                {(versions.data?.data ?? []).map((v) => (
                  <li key={v.id} className="flex items-center gap-2 text-[13px]">
                    <input
                      type="checkbox"
                      id={`version-${v.id}`}
                      checked={versionIds.has(v.id)}
                      onChange={(e) => setVersionIds((cur) => toggled(cur, v.id, e.target.checked))}
                      className="h-4 w-4 accent-varhi"
                    />
                    <label htmlFor={`version-${v.id}`} className="flex-1 cursor-pointer">
                      <span className="font-mono">v{v.versionNumber}</span>
                      {v.variables.length > 0 && (
                        <span className="ml-2 text-[12px] text-faint">{v.variables.join(', ')}</span>
                      )}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </Field>
        )}

        <Field label="Models" hint="At least one — every selected version is run against every selected model.">
          {gatewayModels.isLoading ? (
            <PageSpinner />
          ) : gatewayModels.isError ? (
            <Empty title="Couldn’t load models" description="Something went wrong. Try again." />
          ) : (gatewayModels.data ?? []).length === 0 ? (
            <Empty title="No models registered" description="Register a model under Gateway → Models first." />
          ) : (
            <ul className="flex flex-col gap-1.5 rounded-md border border-line-soft bg-elevated p-2.5" data-testid="model-checkboxes">
              {(gatewayModels.data ?? []).map((m) => (
                <li key={m.id} className="flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    id={`model-${m.id}`}
                    checked={models.has(m.publicName)}
                    onChange={(e) => setModels((cur) => toggled(cur, m.publicName, e.target.checked))}
                    className="h-4 w-4 accent-varhi"
                  />
                  <label htmlFor={`model-${m.id}`} className="flex-1 cursor-pointer">
                    <span className="font-mono">{m.publicName}</span>
                    <span className="ml-2 text-[12px] text-faint">{m.provider}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </Field>

        {error && <p className="text-[13px] text-danger">{error}</p>}

        <div>
          <Button variant="primary" disabled={submitting} onClick={handleSubmit}>
            {submitting ? 'Starting…' : 'Start run'}
          </Button>
        </div>
      </div>
    </div>
  );
}
