import { useEffect, useState } from 'react';
import {
  ApiError,
  useAliases,
  useCreateEvalRule,
  useCreatePrompt,
  useModels,
  usePrompt,
  usePreviewEvalRule,
  useTraceFacets,
  useToDataset,
  useUpdateEvalRule,
} from '@/api';
import type { CreateEvalRuleInput, EvalRule } from '@/api/types';
import { Button, Drawer, Field, Input, MultiSelect, Select, Textarea, useToast } from '@/ui';
import { ModelDialog } from '@/gateway/ModelDialog';
import { PromptPicker } from './PromptPicker';

export interface RuleDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The rule being edited, or omitted to create a new one. */
  rule?: EvalRule;
}

/**
 * Create/edit form for one online-evaluation rule, opened from `RulesPage`
 * (as `'new'`) or from a `RulesTable` row/Edit action (with the clicked
 * `EvalRule`). Mirrors `ToolDialog`'s controlled-field shape inside a
 * `Drawer` instead of a `Dialog`, since the form has more fields than a
 * dialog comfortably holds.
 *
 * Preview only works against a rule that already has a real id — a
 * brand-new, unsaved rule has nothing to score against yet — so the Preview
 * button stays disabled until `rule` is passed in (i.e. after the first
 * save, when the caller re-opens the drawer in edit mode).
 *
 * @param open - Whether the drawer is visible.
 * @param onOpenChange - Called to open/close the drawer.
 * @param rule - The rule to edit, or undefined to create a new one.
 */
export function RuleDrawer({ open, onOpenChange, rule }: RuleDrawerProps) {
  const toast = useToast();
  const create = useCreateEvalRule();
  const update = useUpdateEvalRule(rule?.id ?? '');
  const preview = usePreviewEvalRule(rule?.id ?? '');
  const toDataset = useToDataset(rule?.id ?? '');
  const { data: models } = useModels();
  const { data: facets } = useTraceFacets();
  const createPrompt = useCreatePrompt();

  const [name, setName] = useState('');
  const [criteria, setCriteria] = useState('');
  const [judgeModel, setJudgeModel] = useState('');
  const [showCreateModel, setShowCreateModel] = useState(false);
  const [judgePrompt, setJudgePrompt] = useState<{ id: string; name: string } | null>(null);
  const [samplePercent, setSamplePercent] = useState('10');
  const [dailyLimit, setDailyLimit] = useState('');
  const [alertBelow, setAlertBelow] = useState('');
  const [filterPrompt, setFilterPrompt] = useState<{ id: string; name: string } | null>(null);
  const [filterAlias, setFilterAlias] = useState('');
  const [model, setModel] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [sessionOnly, setSessionOnly] = useState(false);
  const [datasetName, setDatasetName] = useState('');
  const [threshold, setThreshold] = useState('50');

  // Existing rules only carry ids in `filter.promptId`/`judgePromptId` — fetch
  // the names once so the pickers can show something other than a bare UUID
  // when the drawer re-opens in edit mode.
  const { data: filterPromptDetail } = usePrompt(rule?.filter.promptId ?? '');
  const { data: judgePromptDetail } = usePrompt(rule?.judgePromptId ?? '');

  const { data: filterAliases } = useAliases(filterPrompt?.id ?? '');

  // Reset the form (and any stale preview results) every time the drawer
  // opens, seeding it from `rule` in edit mode or blank defaults for a new one.
  useEffect(() => {
    if (!open) return;
    setName(rule?.name ?? '');
    setCriteria(rule?.criteria ?? '');
    setJudgeModel(rule?.judgeModel ?? '');
    setJudgePrompt(
      rule?.judgePromptId && judgePromptDetail?.id === rule.judgePromptId
        ? { id: judgePromptDetail.id, name: judgePromptDetail.name }
        : null,
    );
    setSamplePercent(rule ? `${Math.round(rule.sampleRate * 100)}` : '10');
    setDailyLimit(rule?.dailyLimit != null ? `${rule.dailyLimit}` : '');
    setAlertBelow(rule?.alertBelow != null ? `${rule.alertBelow}` : '');
    setFilterPrompt(
      rule?.filter.promptId && filterPromptDetail?.id === rule.filter.promptId
        ? { id: filterPromptDetail.id, name: filterPromptDetail.name }
        : null,
    );
    setFilterAlias(rule?.filter.promptAlias ?? '');
    setModel(rule?.filter.model ?? '');
    setTags(rule?.filter.tags ?? []);
    setSessionOnly(rule?.filter.sessionOnly ?? false);
    setDatasetName(rule ? `${rule.name} — low scorers` : '');
    setThreshold('50');
    preview.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rule, filterPromptDetail, judgePromptDetail]);

  // Clearing the chosen prompt clears its alias too — an alias is meaningless
  // without the prompt it belongs to.
  function handleFilterPromptChange(next: { id: string; name: string } | null) {
    setFilterPrompt(next);
    setFilterAlias('');
  }

  const trimmedName = name.trim();
  const trimmedCriteria = criteria.trim();
  const samplePercentNum = Number(samplePercent);
  const sampleRateValid = Number.isFinite(samplePercentNum) && samplePercentNum >= 1 && samplePercentNum <= 100;
  const alertBelowNum = alertBelow.trim() === '' ? null : Number(alertBelow);
  const alertBelowValid = alertBelowNum === null || (Number.isFinite(alertBelowNum) && alertBelowNum >= 0 && alertBelowNum <= 100);
  const dailyLimitNum = dailyLimit.trim() === '' ? null : Number(dailyLimit);
  const dailyLimitValid = dailyLimitNum === null || (Number.isFinite(dailyLimitNum) && dailyLimitNum > 0);
  const canSubmit =
    trimmedName.length > 0 &&
    trimmedCriteria.length > 0 &&
    judgeModel.trim().length > 0 &&
    sampleRateValid &&
    alertBelowValid &&
    dailyLimitValid;

  const pending = create.isPending || update.isPending;

  async function handleSubmit() {
    const body: CreateEvalRuleInput = {
      name: trimmedName,
      criteria: trimmedCriteria,
      judgeModel: judgeModel.trim(),
      judgePromptId: judgePrompt?.id ?? null,
      sampleRate: samplePercentNum / 100,
      dailyLimit: dailyLimitNum,
      alertBelow: alertBelowNum,
      filter: {
        promptId: filterPrompt?.id ?? undefined,
        promptAlias: filterPrompt && filterAlias ? filterAlias : undefined,
        model: model.trim() || undefined,
        tags: tags.length > 0 ? tags : undefined,
        sessionOnly: sessionOnly || undefined,
      },
    };

    try {
      if (rule) {
        await update.mutateAsync(body);
        toast.success(`Rule "${trimmedName}" updated`);
      } else {
        await create.mutateAsync(body);
        toast.success(`Rule "${trimmedName}" created`);
      }
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save the rule');
    }
  }

  function handlePreview() {
    preview.mutate(10, {
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not run the preview'),
    });
  }

  const trimmedDatasetName = datasetName.trim();
  const thresholdNum = Number(threshold);
  const thresholdValid = Number.isFinite(thresholdNum) && thresholdNum >= 0 && thresholdNum <= 100;
  const canBuildDataset = trimmedDatasetName.length > 0 && thresholdValid;

  function handleToDataset() {
    toDataset.mutate(
      { datasetName: trimmedDatasetName, threshold: thresholdNum },
      {
        onSuccess: (result) => {
          toast.success(
            result.exampleCount > 0
              ? `Built "${trimmedDatasetName}" with ${result.exampleCount} examples`
              : `Built "${trimmedDatasetName}" — no scores were below ${thresholdNum} yet`,
          );
        },
        onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not build the dataset'),
      },
    );
  }

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title={rule ? 'Edit rule' : 'New rule'}
      description="Scores matching live traffic automatically, without waiting for someone to run an experiment."
    >
      <div className="flex flex-col gap-3">
        <Field label="Name" htmlFor="rule-name">
          <Input
            id="rule-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Refund tone check"
          />
        </Field>

        <Field
          label="Criteria"
          htmlFor="rule-criteria"
          hint="This is a standing instruction the judge grades every matched reply against — not feedback on one answer."
        >
          <Textarea
            id="rule-criteria"
            rows={3}
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            placeholder="The reply stays polite and never promises a refund outright."
          />
        </Field>

        <Field label="Judge model" htmlFor="rule-judge-model" hint="The model that grades every matched reply.">
          {models && models.length > 0 ? (
            <Select
              id="rule-judge-model"
              value={judgeModel}
              onChange={(e) => setJudgeModel(e.target.value)}
              data-testid="rule-judge-model"
            >
              <option value="" disabled>
                Select a model…
              </option>
              {models.map((m) => (
                <option key={m.id} value={m.publicName}>
                  {m.publicName}
                </option>
              ))}
            </Select>
          ) : (
            <div className="flex items-center gap-2 rounded-md border border-line-soft bg-bg p-2.5">
              <p className="flex-1 text-[12px] text-faint">No models registered yet.</p>
              <Button
                type="button"
                variant="default"
                onClick={() => setShowCreateModel(true)}
                data-testid="rule-create-model-button"
              >
                Create model
              </Button>
            </div>
          )}
        </Field>

        <Field
          label="Judge prompt"
          htmlFor="rule-judge-prompt"
          hint="Optional — grade against your own prompt instead of the built-in judge."
        >
          <PromptPicker
            id="rule-judge-prompt"
            value={judgePrompt}
            onChange={setJudgePrompt}
            placeholder="Built-in judge"
          />
          {!judgePrompt && (
            <button
              type="button"
              className="mt-1.5 self-start text-[12px] text-accent hover:underline"
              onClick={async () => {
                try {
                  const created = await createPrompt.mutateAsync({ name: `Judge: ${trimmedName || 'untitled rule'}` });
                  setJudgePrompt({ id: created.id, name: created.name });
                  toast.success('Prompt created — write its judge template, then commit a version.');
                } catch (e) {
                  toast.error(e instanceof ApiError ? e.message : 'Could not create the prompt');
                }
              }}
            >
              + Create a new judge prompt
            </button>
          )}
        </Field>

        <Field
          label="Sample rate"
          htmlFor="rule-sample-rate"
          error={!sampleRateValid ? 'Enter a whole percentage between 1 and 100.' : undefined}
        >
          <div className="flex items-center gap-2">
            <Input
              id="rule-sample-rate"
              type="number"
              min={1}
              max={100}
              value={samplePercent}
              onChange={(e) => setSamplePercent(e.target.value)}
              className="w-24"
            />
            <span className="text-[13px] text-muted">% of matching spans</span>
          </div>
          <p className="text-[12px] text-faint">Lower sampling costs less — each sampled span costs one judge call.</p>
        </Field>

        <Field label="Daily limit" htmlFor="rule-daily-limit" error={!dailyLimitValid ? 'Enter a positive number.' : undefined} hint="Optional — caps judge calls per day for this rule.">
          <Input
            id="rule-daily-limit"
            type="number"
            min={1}
            value={dailyLimit}
            onChange={(e) => setDailyLimit(e.target.value)}
            placeholder="unlimited"
          />
        </Field>

        <Field
          label="Alert below"
          htmlFor="rule-alert-below"
          error={!alertBelowValid ? 'Enter a score between 0 and 100.' : undefined}
          hint="Optional — notify the team when the mean score drops below this."
        >
          <Input
            id="rule-alert-below"
            type="number"
            min={0}
            max={100}
            value={alertBelow}
            onChange={(e) => setAlertBelow(e.target.value)}
            placeholder="none"
          />
        </Field>

        <div className="mt-1 border-t border-line-soft pt-3">
          <p className="text-[13px] font-medium text-ink">Match filter</p>
          <p className="text-[12px] text-faint">All conditions apply together. Leave a field blank to match any value.</p>
        </div>

        <Field label="Prompt" htmlFor="rule-filter-prompt" hint="Match only spans produced by this prompt.">
          <PromptPicker
            id="rule-filter-prompt"
            value={filterPrompt}
            onChange={handleFilterPromptChange}
            placeholder="any"
          />
        </Field>

        {filterPrompt && (
          <Field label="Alias" htmlFor="rule-filter-alias" hint="Match only this prompt's current alias.">
            <Select
              id="rule-filter-alias"
              value={filterAlias}
              onChange={(e) => setFilterAlias(e.target.value)}
              data-testid="rule-filter-alias"
            >
              <option value="">any</option>
              {(filterAliases ?? []).map((a) => (
                <option key={a.id} value={a.alias}>
                  {a.alias}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field
          label="Model"
          htmlFor="rule-model"
          hint="The upstream model the provider actually served — not the public name you registered for it."
        >
          <Select id="rule-model" value={model} onChange={(e) => setModel(e.target.value)} data-testid="rule-model">
            <option value="">any</option>
            {(facets?.models ?? []).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Tags" htmlFor="rule-tags">
          <MultiSelect
            id="rule-tags"
            value={tags}
            onChange={setTags}
            options={(facets?.tags ?? []).map((t) => ({ value: t }))}
            placeholder="any"
            emptyMessage="No tagged traces yet."
          />
        </Field>

        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input
            type="checkbox"
            checked={sessionOnly}
            onChange={(e) => setSessionOnly(e.target.checked)}
            data-testid="rule-session-only"
          />
          Session spans only
        </label>

        <div className="mt-2 border-t border-line-soft pt-3">
          <div className="flex items-center gap-2">
            <Button
              variant="default"
              disabled={!rule || preview.isPending}
              title={!rule ? 'save the rule first' : undefined}
              onClick={handlePreview}
              data-testid="rule-preview-button"
            >
              {preview.isPending ? 'Previewing…' : 'Preview'}
            </Button>
            <span className="text-[12px] text-faint">Dry-runs against the 10 most recent matching spans.</span>
          </div>

          {preview.isSuccess && (
            <ul className="mt-3 flex flex-col gap-2" data-testid="rule-preview-results">
              {preview.data.length === 0 ? (
                <li className="text-[13px] text-muted">No matching spans yet.</li>
              ) : (
                preview.data.map((verdict) => (
                  <li key={verdict.spanId} className="rounded-md border border-line-soft px-3 py-2 text-[13px]">
                    <span className="font-mono font-medium text-ink">
                      {verdict.score === null ? '—' : Math.round(verdict.score)}
                    </span>
                    {verdict.reason && <span className="ml-2 text-muted">{verdict.reason}</span>}
                  </li>
                ))
              )}
            </ul>
          )}
        </div>

        {rule && (
          <div className="mt-2 border-t border-line-soft pt-3">
            <p className="text-[13px] font-medium text-ink">Build dataset from low scorers</p>
            <p className="text-[12px] text-faint">
              Pulls this rule's persisted verdicts scoring below the threshold into a new dataset.
            </p>

            <div className="mt-3 flex flex-col gap-3">
              <Field label="Dataset name" htmlFor="rule-dataset-name">
                <Input
                  id="rule-dataset-name"
                  value={datasetName}
                  onChange={(e) => setDatasetName(e.target.value)}
                  placeholder={`${rule.name} — low scorers`}
                />
              </Field>

              <Field
                label="Threshold"
                htmlFor="rule-dataset-threshold"
                error={!thresholdValid ? 'Enter a score between 0 and 100.' : undefined}
                hint="Verdicts scoring below this join the dataset."
              >
                <Input
                  id="rule-dataset-threshold"
                  type="number"
                  min={0}
                  max={100}
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                  className="w-24"
                />
              </Field>

              <Button
                variant="default"
                disabled={!canBuildDataset || toDataset.isPending}
                onClick={handleToDataset}
                data-testid="rule-to-dataset-button"
                className="self-start"
              >
                {toDataset.isPending ? 'Building…' : 'Build dataset'}
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="mt-4 flex justify-end gap-2 border-t border-line-soft pt-4">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={pending || !canSubmit} onClick={handleSubmit} data-testid="rule-save-button">
          {pending ? 'Saving…' : rule ? 'Save changes' : 'Create rule'}
        </Button>
      </div>
      <ModelDialog open={showCreateModel} onOpenChange={setShowCreateModel} />
    </Drawer>
  );
}
