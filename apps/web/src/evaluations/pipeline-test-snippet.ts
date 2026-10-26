/** What a pipeline-test snippet needs to name. */
export interface PipelineSnippetInput {
  /** The dataset the optimize run graded, so the pipeline runs on the same cases. */
  datasetId: string;
  /** The run's judge model; null for a run from before judges were recorded. */
  judgeModel: string | null;
  /**
   * The model the run scored its variants with. The judge for a run with no recorded
   * judge: it was registered on the team when the run ran, which a fixed default is not.
   */
  runModel: string;
  /** The run's custom judge prompt, or null when the built-in judge graded it. */
  judgePromptId: string | null;
  /** The version of that judge prompt the run graded with, so every pipeline run grades with it too. */
  judgePromptVersion: number | null;
  /**
   * The run graded with a custom judge prompt that can no longer be read (deleted since, or
   * its lookup failed). The snippet then grades with the built-in judge and says so.
   */
  judgePromptLost: boolean;
  /** The prompt's name — what the app renders it by. */
  promptName: string;
  /** The version the candidate was committed as. */
  versionNumber: number;
  /** The candidate's label, used as its run name, e.g. `candidate-B`. */
  label: string;
}

/**
 * The SDK code that runs a team's own app on production and on a committed candidate,
 * side by side, graded by the same judge as the optimize run — the same judge prompt
 * version too, not whatever its `production` alias serves later (phase-5 FAQ Q58).
 *
 * The user's app is `my_agent` / `myAgent`: the snippet cannot know it, and naming it
 * plainly is clearer than a placeholder string.
 *
 * @param input - The dataset, judge model and judge prompt, prompt, version and label to fill in.
 * @returns One snippet per SDK.
 */
export function pipelineTestSnippets(input: PipelineSnippetInput): { python: string; node: string } {
  const judge = input.judgeModel ?? input.runModel;
  const unrecorded = input.judgePromptLost
    ? "This run graded with a judge prompt that can no longer be read, so this uses the built-in judge. Its scores will not compare with the run's."
    : input.judgeModel === null
      ? "This run did not record its judge, so this is the model it scored with. Change it if you like."
      : null;
  const py = JSON.stringify;
  const version = input.judgePromptVersion;
  const pyJudge = input.judgePromptId
    ? `hub.experiments.judge(${py(judge)}, judge_prompt_id=${py(input.judgePromptId)}` +
      (version !== null ? `, judge_prompt_version=${version})` : ')')
    : `hub.experiments.judge(${py(judge)})`;
  const nodeJudge = input.judgePromptId
    ? `hub.experiments.judge(${py(judge)}, { judgePromptId: ${py(input.judgePromptId)}` +
      (version !== null ? `, judgePromptVersion: ${version} })` : ' })')
    : `hub.experiments.judge(${py(judge)})`;
  // Inside a function: a top-level `async with` is a SyntaxError in a .py file.
  const python = [
    'import asyncio',
    '',
    'from acruxcore import AcruxCore',
    '',
    '',
    'async def main():',
    '    async with AcruxCore() as hub:',
    '        comparison = await hub.experiments.compare_local(',
    `            ${py(input.datasetId)},`,
    '            task=my_agent,  # your app: async def my_agent(input, ctx) -> answer',
    ...(unrecorded ? [`            # ${unrecorded}`] : []),
    `            scorers=[${pyJudge}],`,
    '            variants={',
    '                "production": None,',
    `                ${py(input.label)}: {${py(input.promptName)}: ${input.versionNumber}},`,
    '            },',
    '        )',
    '        print(comparison)',
    '',
    '',
    'asyncio.run(main())',
  ].join('\n');
  const node = [
    "import { acruxcore } from '@acruxcoreai/sdk';",
    '',
    'const hub = new acruxcore();',
    'const comparison = await hub.experiments.compareLocal(' + py(input.datasetId) + ', {',
    '  task: myAgent, // your app: async (input, ctx) => answer',
    ...(unrecorded ? [`  // ${unrecorded}`] : []),
    `  scorers: [${nodeJudge}],`,
    '  variants: {',
    '    production: null,',
    `    ${py(input.label)}: { ${py(input.promptName)}: ${input.versionNumber} },`,
    '  },',
    '});',
    'console.log(comparison.compareUrls);',
  ].join('\n');
  return { python, node };
}
