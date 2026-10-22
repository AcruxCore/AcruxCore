import { useState } from 'react';
import { ApiError, useAliases, useCommitVersion, useCreatePrompt, useVersions } from '@/api';
import type { DatasetExample } from '@/api/types';
import { Button, Field, useToast } from '@/ui';
import { PromptPicker } from './PromptPicker';
import { JUDGE_PROMPT_GUIDE_URL, STARTER_JUDGE_MESSAGES, judgeCoverageGap } from './judge-prompt.helpers';

type PickedPrompt = { id: string; name: string } | null;

/**
 * Whether Start must wait on the picked judge prompt. The API refuses to start a
 * run with a judge that has no committed version (400), so the screens that start
 * one disable their Start button while this is true (issue #692).
 *
 * @param value - The picked judge prompt, or null for the built-in judge.
 * @returns False for the built-in judge. For a picked prompt, true until its
 *   versions have loaded and include at least one, so a click made while they
 *   load, or after the request failed, cannot reach the API.
 */
export function useJudgePromptHasNoVersion(value: PickedPrompt): boolean {
  const versions = useVersions(value?.id ?? '');
  return !!value && !(versions.isSuccess && versions.data.length > 0);
}

interface JudgePromptFieldProps {
  /** DOM id for the picker; the label is tied to it. Unique per screen. */
  id: string;
  value: PickedPrompt;
  onChange: (prompt: PickedPrompt) => void;
  /** The name a prompt made by "Create judge prompt" gets, e.g. "Receipts judge". */
  newPromptName: string;
  /** What the judge grades on this screen, e.g. "every result". */
  grades: string;
  /**
   * The dataset an experiment or optimize run grades on. When given, the field warns if the
   * chosen judge reads `{{ criteria }}`/`{{ overallFeedback }}` and some
   * examples have neither. Omitted for online rules, which always carry criteria.
   */
  dataset?: { examples: Pick<DatasetExample, 'criteria'>[]; overallFeedback: string | null };
}

/**
 * The optional "Judge prompt" picker for every screen that grades with a judge:
 * running an experiment, the two optimize dialogs, and the online-rule drawer.
 *
 * A custom judge always runs, even on an example with no criteria (phase-5 FAQ
 * Q43), so the template must carry its own rubric. Two things help the author
 * get that right: "Create judge prompt" makes a prompt whose first version is a
 * starter template with a rubric section, and the guide link explains the rest.
 *
 * @param props - See {@link JudgePromptFieldProps}.
 */
export function JudgePromptField({ id, value, onChange, newPromptName, grades, dataset }: JudgePromptFieldProps) {
  const toast = useToast();
  const createPrompt = useCreatePrompt();
  const commitVersion = useCommitVersion();
  const [creating, setCreating] = useState(false);

  // The version a run would grade with: `production`, else the newest.
  const aliases = useAliases(value?.id ?? '');
  const versions = useVersions(value?.id ?? '');
  const production = aliases.data?.find((a) => a.alias === 'production');
  const judgeVersion = production
    ? versions.data?.find((v) => v.versionNumber === production.versionNumber)
    : versions.data?.[0];
  // Only a loaded empty list earns the warning; the Start buttons also wait while it loads.
  const noVersion = !!value && versions.isSuccess && versions.data.length === 0;
  const gap = dataset && judgeVersion ? judgeCoverageGap(judgeVersion.variables, dataset.examples, dataset.overallFeedback) : null;

  async function handleCreate() {
    setCreating(true);
    try {
      const prompt = await createWithFreeName(newPromptName);
      // Selected before the commit, so a failed commit leaves the new prompt
      // chosen (with its "no committed version" note and edit link) instead of
      // orphaned — a retry would otherwise create "<name> 2", "<name> 3", …
      onChange({ id: prompt.id, name: prompt.name });
      try {
        await commitVersion.mutateAsync({ promptId: prompt.id, messages: STARTER_JUDGE_MESSAGES });
      } catch (e) {
        toast.error(
          `Created "${prompt.name}", but could not add the starter template${e instanceof ApiError ? `: ${e.message}` : ''}. Open it to commit a template.`,
        );
        return;
      }
      toast.success(`Created "${prompt.name}" from the starter template. Edit its rubric before you rely on its scores.`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not create the judge prompt');
    } finally {
      setCreating(false);
    }
  }

  // Prompt names are unique per team, so a second "Receipts judge" becomes "Receipts judge 2".
  async function createWithFreeName(base: string) {
    for (let n = 1; ; n++) {
      try {
        return await createPrompt.mutateAsync({ name: n === 1 ? base : `${base} ${n}` });
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 409) || n >= 20) throw e;
      }
    }
  }

  const variablesText = gap?.variables.map((v) => `{{ ${v} }}`).join(' and ');

  return (
    <Field
      label="Judge prompt"
      htmlFor={id}
      hint={`Optional. Grade ${grades} with your own prompt instead of the built-in judge. It always runs, so keep a rubric in it.`}
    >
      <PromptPicker id={id} value={value} onChange={onChange} placeholder="Built-in judge" />
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        {value ? (
          <a
            href={`/prompts/${value.id}`}
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:underline"
            data-testid={`${id}-edit`}
          >
            Edit its template ↗
          </a>
        ) : (
          <Button type="button" variant="default" disabled={creating} onClick={handleCreate} data-testid={`${id}-create`}>
            {creating ? 'Creating…' : 'Create judge prompt'}
          </Button>
        )}
        <a
          href={JUDGE_PROMPT_GUIDE_URL}
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:underline"
          data-testid={`${id}-guide`}
        >
          How to write a judge prompt ↗
        </a>
      </div>
      {noVersion && (
        <p className="mt-1.5 text-[12px] text-warn" data-testid={`${id}-no-version`}>
          This prompt has no committed version yet. Commit its judge template before you use it.
        </p>
      )}
      {gap && (
        <p className="mt-1.5 text-[12px] text-warn" data-testid={`${id}-coverage-warning`}>
          This judge prompt uses {variablesText}, but {gap.missing} of {gap.total} example{gap.total === 1 ? '' : 's'} have no
          value for {gap.variables.length > 1 ? 'them' : 'it'}. Those examples are still graded, against the rubric in the
          template alone, and each one costs a judge call.
        </p>
      )}
    </Field>
  );
}
