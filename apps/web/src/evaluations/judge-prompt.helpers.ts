import type { DatasetExample, Message } from '@/api/types';

/** The docs guide every "Create judge prompt" button and judge-prompt hint links to. */
export const JUDGE_PROMPT_GUIDE_URL = 'https://docs.acruxcore.com/docs/guides/write-a-custom-judge-prompt';

/**
 * The template a new judge prompt starts from.
 *
 * A custom judge always runs, even on an example with no criteria (phase-5 FAQ
 * Q43), so the template carries its own rubric. The `{# … #}` lines are
 * nunjucks comments: they guide the author and are stripped before the judge
 * model sees the prompt. A missing value is an empty string on an experiment
 * run but the word `none` on an online rule (FAQ Q43), so each `{% if %}`
 * checks for both and the block drops out either way. The same prompt can
 * serve both, which is why the check is in the template and not per caller.
 * The score/reason JSON format is not
 * here: the platform appends it to every judge prompt.
 */
export const STARTER_JUDGE_MESSAGES: Message[] = [
  {
    role: 'system',
    content: `{# Keep a rubric in this prompt. It is what the judge grades against when an example has no criteria. Replace the three lines below with your own checks. Guide: ${JUDGE_PROMPT_GUIDE_URL} #}
You grade one reply written by an AI assistant. Give a score from 0 to 100.

Rubric:
- 100: the reply does everything the task asks, in the format it asks for.
- 50: the reply is partly right, or right but in the wrong format.
- 0: the reply is wrong, empty, or off-topic.
{% if criteria and criteria != 'none' %}
What this example expects:
{{ criteria }}
{% endif %}{% if overallFeedback and overallFeedback != 'none' %}
Guidance for every example:
{{ overallFeedback }}
{% endif %}`,
  },
  {
    role: 'user',
    content: `{% if history %}Earlier turns of the conversation, as JSON:
{{ history }}

{% endif %}Reply to grade:
<<<OUTPUT_START>>>
{{ output }}
<<<OUTPUT_END>>>`,
  },
];

/** The judge-template variables that come from the dataset rather than from the result. */
const DATASET_VARIABLES = ['criteria', 'overallFeedback'] as const;

/** What {@link judgeCoverageGap} found. */
export interface JudgeCoverageGap {
  /** The dataset-sourced variables the judge template reads, e.g. `['criteria']`. */
  variables: string[];
  /** How many examples give the template none of those variables. */
  missing: number;
  /** All examples in the dataset. */
  total: number;
}

/**
 * Finds the examples a custom judge will grade without the dataset values its
 * template reads.
 *
 * A custom judge always runs, so a template that reads `{{ criteria }}` on an
 * example with no criteria grades against an empty string and still costs a
 * model call. The experiment page shows this as a warning before the run
 * starts. An example counts as missing when every dataset variable the
 * template reads is empty for it; `overallFeedback` is the same for every
 * example, so a dataset that has it covers them all when the template reads it.
 *
 * @param templateVariables - The variables of the judge version the run will use.
 * @param examples - Every example in the dataset.
 * @param overallFeedback - The dataset's overall feedback, or null.
 * @returns The gap, or null when the template reads no dataset variable or
 *   every example has a value for one it reads.
 */
export function judgeCoverageGap(
  templateVariables: string[],
  examples: Pick<DatasetExample, 'criteria'>[],
  overallFeedback: string | null,
): JudgeCoverageGap | null {
  const variables = DATASET_VARIABLES.filter((v) => templateVariables.includes(v));
  if (variables.length === 0) return null;
  if (variables.includes('overallFeedback') && overallFeedback?.trim()) return null;
  const readsCriteria = variables.includes('criteria');
  const missing = examples.filter((e) => !readsCriteria || !e.criteria?.trim()).length;
  return missing === 0 ? null : { variables: [...variables], missing, total: examples.length };
}
