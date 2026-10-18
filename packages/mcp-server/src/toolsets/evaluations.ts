import { z } from 'zod';
import { listSummary, okResult } from '../format';
import { resolvePromptRef } from '../refs';
import { defineTool, type AnyToolDefinition } from './types';

/** A prior-turn message replayed ahead of an example's input during a run. */
const historyMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
});

/**
 * Tools for evaluation: datasets of examples, experiments that sweep a grid of
 * (version x model) over them, and the runs that produce scores.
 *
 * The chain is fixed and the descriptions say so, because skipping a link is the common
 * mistake: a **dataset** holds examples, an **experiment** pairs a dataset with the grid
 * to sweep, and a **run** executes it asynchronously in the worker. Creating an
 * experiment scores nothing until a run is started, and a run returns immediately —
 * results arrive later.
 */
export const evaluationTools: AnyToolDefinition[] = [
  defineTool({
    name: 'list_datasets',
    title: 'List evaluation datasets',
    toolset: 'evaluations',
    readOnlyHint: true,
    description: 'List the team\'s evaluation datasets with their example counts.',
    inputSchema: {
      page: z.number().int().positive().optional().describe('1-based page number.'),
      limit: z.number().int().positive().max(100).optional().describe('Results per page, max 100.'),
    },
    async handler(args, { client, config }) {
      const result = await client.get<{ data?: unknown[]; total?: number }>('/datasets', args);
      return okResult(listSummary('datasets', result), result, config.maxTextBytes);
    },
  }),

  defineTool({
    name: 'get_dataset',
    title: 'Get one dataset with its examples',
    toolset: 'evaluations',
    readOnlyHint: true,
    description:
      'Read one dataset: its name, dataset-level rubric (overallFeedback) and its ' +
      'examples, each with the input variables and the per-example criteria a judge ' +
      'scores against.',
    inputSchema: { dataset_id: z.string().uuid().describe('Dataset UUID.') },
    async handler({ dataset_id }, { client, config }) {
      const result = await client.get<{ name?: string; examples?: unknown[] }>(
        `/datasets/${dataset_id}`,
      );
      return okResult(
        `Dataset "${result.name}" — ${result.examples?.length ?? 0} example(s).`,
        result,
        config.maxTextBytes,
      );
    },
  }),

  defineTool({
    name: 'create_dataset',
    title: 'Create an evaluation dataset',
    toolset: 'evaluations',
    readOnlyHint: false,
    description:
      'Create an empty dataset. Add examples afterwards with add_dataset_example. ' +
      '`overall_feedback` is a rubric applied on top of each example\'s own criteria — ' +
      'write it as an instruction to the judge, not as a complaint about an answer.',
    inputSchema: {
      name: z.string().min(1).describe('Dataset name.'),
      overall_feedback: z
        .string()
        .optional()
        .describe('Dataset-level rubric, e.g. "Keep responses concise and polite".'),
    },
    async handler({ name, overall_feedback }, { client, config }) {
      const result = await client.post<{ id: string; name: string }>('/datasets', {
        name,
        overall_feedback,
      });
      return okResult(
        `Created dataset "${result.name}" (${result.id}). It has no examples yet.`,
        result,
        config.maxTextBytes,
      );
    },
  }),

  defineTool({
    name: 'add_dataset_example',
    title: 'Add an example to a dataset',
    toolset: 'evaluations',
    readOnlyHint: false,
    description:
      'Add one example. `input` is the variable bag the prompt is rendered with; ' +
      '`criteria` is what the judge checks this particular answer against. `history` ' +
      'supplies prior conversation turns to replay before the input — omit it for a ' +
      'single-turn example.',
    inputSchema: {
      dataset_id: z.string().uuid().describe('Dataset UUID.'),
      input: z.record(z.unknown()).describe('Template variables for this example, e.g. {"name":"Bob"}.'),
      criteria: z.string().optional().describe('What a correct answer must do.'),
      history: z
        .array(historyMessageSchema)
        .optional()
        .describe('Prior turns to replay first. Max 20 messages.'),
    },
    async handler({ dataset_id, ...body }, { client, config }) {
      const result = await client.post<{ id: string }>(`/datasets/${dataset_id}/examples`, body);
      return okResult(`Added example ${result.id}.`, result, config.maxTextBytes);
    },
  }),

  defineTool({
    name: 'run_experiment',
    title: 'Create and start an experiment run',
    toolset: 'evaluations',
    readOnlyHint: false,
    description:
      'Create an experiment over a dataset and immediately start a run of it. The grid ' +
      'is every (version x model) pair you list. When `prompt` is given, a baseline cell ' +
      'for its production alias is added automatically unless that version is already in ' +
      'the grid. Returns as soon as the run is queued — the worker executes it ' +
      'asynchronously, so poll get_experiment_run for results. Note the judge model ' +
      '(gpt-4o-mini by default) must itself be registered in the gateway or every score ' +
      'fails.',
    inputSchema: {
      dataset_id: z.string().uuid().describe('Dataset to evaluate against.'),
      version_ids: z
        .array(z.string().uuid())
        .min(1)
        .describe('Prompt-version UUIDs to sweep. At least one.'),
      models: z.array(z.string().min(1)).min(1).describe('Gateway model public names to sweep.'),
      prompt: z
        .string()
        .optional()
        .describe('Prompt name or UUID under test — enables the automatic baseline cell.'),
      name: z.string().optional().describe('Experiment name, for the run history.'),
      alias: z
        .string()
        .optional()
        .describe('Which alias the automatic baseline points at. Default "production".'),
    },
    async handler(args, { client, config }) {
      const body: Record<string, unknown> = {
        dataset_id: args.dataset_id,
        version_ids: args.version_ids,
        models: args.models,
      };
      if (args.name !== undefined) body.name = args.name;
      if (args.alias !== undefined) body.alias = args.alias;
      if (args.prompt !== undefined) body.prompt_id = await resolvePromptRef(client, args.prompt);

      const experiment = await client.post<{ id: string; promptMismatchWarning?: string }>(
        '/experiments',
        body,
      );
      const run = await client.post<{ run_id: string; status: string }>(
        `/experiments/${experiment.id}/runs`,
      );

      const warning = experiment.promptMismatchWarning
        ? ` Warning: ${experiment.promptMismatchWarning}`
        : '';
      return okResult(
        `Experiment ${experiment.id} created and run ${run.run_id} is ${run.status}. ` +
          `Results arrive asynchronously — poll get_experiment_run.${warning}`,
        { experiment, run },
        config.maxTextBytes,
      );
    },
  }),

  defineTool({
    name: 'list_experiment_runs',
    title: 'List evaluation runs',
    toolset: 'evaluations',
    readOnlyHint: true,
    description:
      'The run history, newest first. Each row carries the dataset and prompt evaluated, ' +
      'the grid shape, and the scores — avgScore, passRate and topVariantLabel are null ' +
      'rather than 0 until at least one result has been judged, so an unscored run is ' +
      'never mistaken for one that scored badly. `kind` is "optimize" for optimizer ' +
      'sweeps and "evaluation" otherwise.',
    inputSchema: {
      status: z
        .enum(['queued', 'running', 'succeeded', 'failed'])
        .optional()
        .describe('Lifecycle filter.'),
      dataset_id: z.string().uuid().optional().describe('Only runs over this dataset.'),
      prompt_id: z.string().uuid().optional().describe('Only runs whose experiment named this prompt.'),
      page: z.number().int().positive().optional().describe('1-based page number.'),
      limit: z.number().int().positive().max(100).optional().describe('Rows per page, max 100.'),
    },
    async handler(args, { client, config }) {
      const result = await client.get<{ data?: unknown[]; total?: number }>('/runs', args);
      return okResult(listSummary('runs', result), result, config.maxTextBytes);
    },
  }),

  defineTool({
    name: 'get_experiment_run',
    title: 'Get a run, optionally with its comparison report',
    toolset: 'evaluations',
    readOnlyHint: true,
    description:
      'Read one run\'s status and results. With include_report=true it also fetches the ' +
      'comparison report: the full (variant x model) matrix with per-cell averages, each ' +
      'cell\'s delta against the same-model production baseline, a leaderboard and an ' +
      'advisory winner. Ask for the report only once the run has succeeded — an ' +
      'in-flight run has nothing to compare.',
    inputSchema: {
      run_id: z.string().uuid().describe('Run UUID.'),
      include_report: z.boolean().optional().describe('Also fetch the comparison report.'),
    },
    async handler({ run_id, include_report }, { client, config }) {
      const run = await client.get<{ status?: string; results?: unknown[] }>(`/runs/${run_id}`);
      let report: unknown = undefined;
      if (include_report) {
        report = await client.get(`/runs/${run_id}/report`);
      }
      return okResult(
        `Run ${run_id} is ${run.status} with ${run.results?.length ?? 0} result(s).`,
        { run, report },
        config.maxTextBytes,
      );
    },
  }),
];
