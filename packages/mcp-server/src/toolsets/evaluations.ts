import { z } from 'zod';
import { isTruncated, listSummary, okResult } from '../format';
import {
  bestCandidate,
  summarizeCandidates,
  type CandidateSummary,
  type OptimizeGridCell,
  type OptimizeReportCell,
} from '../optimize-report';
import { resolvePromptRef } from '../refs';
import { defineTool, type AnyToolDefinition, type ToolContext } from './types';

/** A prior-turn message replayed ahead of an example's input during a run. */
const historyMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
});

/** The fields of `GET /runs/:id` the optimizer tools read. */
interface RunDetail {
  id: string;
  kind: 'evaluation' | 'optimize' | 'local';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  error: string | null;
  grid: OptimizeGridCell[];
  results?: { total: number; succeeded: number; errored: number };
}

/** The fields of `GET /runs/:id/report` the optimizer tools read. */
interface RunReportBody {
  cells: OptimizeReportCell[];
  judge?: { model: string | null; promptVersionId?: string | null };
}

/** The fields of `GET /runs/:id/candidates/:candidateId` worth showing before a promote. */
interface CandidateDetailBody {
  promptId: string;
  messages: unknown;
  rationale: string | null;
}

/** One row of `GET /prompts/:id/aliases`. */
interface AliasRow {
  alias: string;
  versionId: string;
  versionNumber: number;
}

/** A candidate's scores joined with its content, as the report tool returns it. */
interface CandidateWithContent extends CandidateSummary {
  rationale: string | null;
  messages?: unknown;
  /** Set when the candidate's content could not be read; its scores are still valid. */
  readError?: string;
}

/**
 * Loads an optimize run and, once it has succeeded, its per-candidate verdicts.
 *
 * Shared by the report tool and the promote tool so the safety check before a promote
 * reads exactly what the report showed.
 *
 * @param client - REST client.
 * @param runId - Run UUID.
 * @returns The run, plus its candidates when the run has succeeded.
 * @throws {Error} When the run is an ordinary evaluation, not an optimize run.
 */
async function loadOptimizeRun(
  client: ToolContext['client'],
  runId: string,
): Promise<{ run: RunDetail; report: RunReportBody | null; candidates: CandidateSummary[] }> {
  const run = await client.get<RunDetail>(`/runs/${runId}`);
  // The API derives `kind` from the grid, and an optimize run's grid stays empty until
  // its rewrites are drafted, so a just-started optimize run reads as "evaluation". An
  // ordinary evaluation run freezes its grid when it starts, so an empty grid can only
  // be an optimize run that has not drafted yet.
  const notDraftedYet = run.grid.length === 0;
  if (run.kind !== 'optimize' && !notDraftedYet) {
    throw new Error(
      `Run ${runId} is an evaluation run, not an optimize run. Read it with get_experiment_run.`,
    );
  }
  if (run.status !== 'succeeded') return { run, report: null, candidates: [] };

  const report = await client.get<RunReportBody>(`/runs/${runId}/report`);
  return { run, report, candidates: summarizeCandidates(run.grid, report.cells) };
}

/**
 * Finds what an optimize run scored its rewrites against.
 *
 * @param run - A succeeded optimize run.
 * @returns The baseline version's id and the alias it was resolved through, or null for
 *   the alias when the run fell back to the latest version (labelled `v<N>`).
 * @throws {Error} When the grid has no baseline cell, which a succeeded run always has.
 */
function baselineOf(run: RunDetail): { versionId: string; alias: string | null } {
  const cell = run.grid.find((row) => row.isProductionBaseline && row.promptVersionId);
  if (!cell?.promptVersionId) {
    throw new Error(`Run ${run.id} has no baseline version, so a promote cannot be checked.`);
  }
  // The optimizer labels the baseline with its alias, or `v<N>` when no alias existed.
  const alias = /^v\d+$/.test(cell.variantLabel) ? null : cell.variantLabel;
  return { versionId: cell.promptVersionId, alias };
}

/** Formats a score delta as `+12.5` / `-3.0`, or `n/a` when it could not be computed. */
function formatDelta(delta: number | null): string {
  if (delta === null) return 'n/a';
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`;
}

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
      'asynchronously, so poll get_experiment_run for results. `judge_model` scores every ' +
      'answer and must be registered in the gateway (see list_models). `judge_prompt` ' +
      'grades with one of your prompts instead of the built-in judge.',
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
      judge_model: z.string().min(1).describe('Gateway model that scores every answer. Required.'),
      judge_prompt: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Name or UUID of a team prompt that grades instead of the built-in judge. The run ' +
            'uses its production version (else its latest). Default: the built-in judge.',
        ),
    },
    async handler(args, { client, config }) {
      const body: Record<string, unknown> = {
        dataset_id: args.dataset_id,
        version_ids: args.version_ids,
        models: args.models,
        judge_model: args.judge_model,
      };
      if (args.judge_prompt !== undefined) {
        body.judge_prompt_id = await resolvePromptRef(client, args.judge_prompt);
      }
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
      'in-flight run has nothing to compare. For an optimize run, get_optimize_report ' +
      'gives the same scores per candidate, with the ids promote_optimize_candidate needs.',
    inputSchema: {
      run_id: z.string().uuid().describe('Run UUID.'),
      include_report: z.boolean().optional().describe('Also fetch the comparison report.'),
    },
    async handler({ run_id, include_report }, { client, config }) {
      const run = await client.get<{ status?: string; results?: { total?: number } }>(
        `/runs/${run_id}`,
      );
      let report: unknown = undefined;
      if (include_report) {
        report = await client.get(`/runs/${run_id}/report`);
      }
      return okResult(
        `Run ${run_id} is ${run.status} with ${run.results?.total ?? 0} result(s).`,
        { run, report },
        config.maxTextBytes,
      );
    },
  }),
  defineTool({
    name: 'optimize_prompt',
    title: 'Start an optimizer run for a prompt',
    toolset: 'evaluations',
    readOnlyHint: false,
    description:
      'Ask the optimizer to improve a prompt against a dataset. An optimizer model drafts ' +
      '`draft_count` rewrites of the version behind `alias` (default "production"), ' +
      'then every rewrite and that baseline run over the dataset on each of `models`, and ' +
      '`judge_model` scores every answer. Returns the run id as soon as the run is queued — ' +
      'drafting and scoring take minutes, so poll get_optimize_report. Nothing is promoted ' +
      'automatically: a rewrite only ships when promote_optimize_candidate is called. The ' +
      'dataset\'s examples need `criteria`, or the built-in judge has nothing to grade ' +
      'against. `judge_prompt` grades with one of your prompts instead, and the optimizer ' +
      'reads it too, so the rewrites aim at that rubric. ' +
      'Every model named here must be registered in the gateway (see list_models).',
    inputSchema: {
      prompt: z.string().min(1).describe('Prompt name or UUID to improve.'),
      dataset_id: z.string().uuid().describe('Dataset whose examples the rewrites are scored on.'),
      models: z
        .array(z.string().min(1))
        .min(1)
        .describe('Gateway model public names to test each rewrite and the baseline on.'),
      judge_model: z.string().min(1).describe('Gateway model that scores every answer. Required.'),
      optimizer_model: z
        .string()
        .min(1)
        .optional()
        .describe('Gateway model that writes the rewrites. Default: the first entry of `models`.'),
      draft_count: z
        .number()
        .int()
        .min(1)
        .max(6)
        .optional()
        .describe('How many rewrites to draft, 1 to 6. Default 3.'),
      alias: z
        .string()
        .min(1)
        .optional()
        .describe('Alias whose version is the baseline to beat. Default "production".'),
      optimizer_prompt: z
        .string()
        .optional()
        .describe('Name or UUID of a team prompt to use as the optimizer\'s instructions.'),
      judge_prompt: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Name or UUID of a team prompt that grades instead of the built-in judge. The run ' +
            'uses its production version (else its latest). Default: the built-in judge.',
        ),
    },
    async handler(args, { client, config }) {
      const promptId = await resolvePromptRef(client, args.prompt);
      const body: Record<string, unknown> = {
        dataset_id: args.dataset_id,
        models: args.models,
        judge_model: args.judge_model,
      };
      if (args.optimizer_model !== undefined) body.optimizer_model = args.optimizer_model;
      if (args.draft_count !== undefined) body.draft_count = args.draft_count;
      if (args.alias !== undefined) body.alias = args.alias;
      if (args.optimizer_prompt !== undefined) {
        body.optimizer_prompt_id = await resolvePromptRef(client, args.optimizer_prompt);
      }
      if (args.judge_prompt !== undefined) {
        body.judge_prompt_id = await resolvePromptRef(client, args.judge_prompt);
      }

      const result = await client.post<{
        run_id: string;
        status: string;
        optimizer_model: string;
        prompt_mismatch_warning?: unknown;
      }>(`/prompts/${promptId}/optimize`, body);

      const warning = result.prompt_mismatch_warning
        ? ' Warning: some dataset examples were built from a different prompt — see prompt_mismatch_warning.'
        : '';
      return okResult(
        `Optimize run ${result.run_id} is ${result.status}; ${result.optimizer_model} drafts ` +
          `the rewrites, then they are scored against the ${args.alias ?? 'production'} ` +
          `baseline. Poll get_optimize_report with this run id.${warning}`,
        result,
        config.maxTextBytes,
      );
    },
  }),

  defineTool({
    name: 'get_optimize_report',
    title: 'Read an optimizer run\'s candidates and scores',
    toolset: 'evaluations',
    readOnlyHint: true,
    description:
      'Read an optimize run started by optimize_prompt. While it is queued or running this ' +
      'returns only its status — call again later. Once it has succeeded it lists every ' +
      'drafted rewrite with its candidate id, the optimizer\'s rationale, the rewritten ' +
      'messages, and its average score next to the baseline\'s on each model. ' +
      '`beatsBaseline` is true only for a rewrite that improved on at least one model and ' +
      'was improved or flat on every other; `recommended` is the one among those with the ' +
      'largest gain, or null when no rewrite beat the baseline. When the rewrites are too ' +
      'long to fit in one result, their messages are left out (`messagesOmitted`); pass ' +
      '`candidate_id` to read one rewrite in full.',
    inputSchema: {
      run_id: z.string().uuid().describe('Optimize run UUID, from optimize_prompt.'),
      candidate_id: z
        .string()
        .uuid()
        .optional()
        .describe('Return only this candidate, with its full messages.'),
    },
    async handler({ run_id, candidate_id }, { client, config }) {
      const { run, report, candidates } = await loadOptimizeRun(client, run_id);

      if (run.status === 'queued' || run.status === 'running') {
        return okResult(
          `Optimize run ${run_id} is ${run.status}. No scores yet — call get_optimize_report again shortly.`,
          { runId: run_id, status: run.status },
          config.maxTextBytes,
        );
      }
      if (run.status === 'failed') {
        return okResult(
          `Optimize run ${run_id} failed: ${run.error ?? 'no reason recorded'}. Nothing to promote.`,
          { runId: run_id, status: run.status, error: run.error },
          config.maxTextBytes,
        );
      }

      if (candidate_id !== undefined) {
        const candidate = candidates.find((row) => row.candidateId === candidate_id);
        if (!candidate) {
          throw new Error(`Candidate ${candidate_id} is not a rewrite from run ${run_id}.`);
        }
        const detail = await client.get<CandidateDetailBody>(
          `/runs/${run_id}/candidates/${candidate_id}`,
        );
        return okResult(
          `${candidate.label} (candidate_id ${candidate_id}) from optimize run ${run_id}; ` +
            `beatsBaseline: ${candidate.beatsBaseline}.`,
          {
            runId: run_id,
            candidate: { ...candidate, rationale: detail.rationale, messages: detail.messages },
          },
          config.maxTextBytes,
        );
      }

      // One unreadable candidate must not hide every other candidate's scores.
      const reads = await Promise.allSettled(
        candidates.map((candidate) =>
          client.get<CandidateDetailBody>(`/runs/${run_id}/candidates/${candidate.candidateId}`),
        ),
      );
      const withContent: CandidateWithContent[] = candidates.map((candidate, index) => {
        const read = reads[index]!;
        return read.status === 'fulfilled'
          ? { ...candidate, rationale: read.value.rationale, messages: read.value.messages }
          : {
              ...candidate,
              rationale: null,
              messages: null,
              readError: read.reason instanceof Error ? read.reason.message : String(read.reason),
            };
      });
      const best = bestCandidate(candidates);
      const winners = candidates.filter((candidate) => candidate.beatsBaseline).length;

      const summary = best
        ? `Optimize run ${run_id} succeeded. ${winners} of ${candidates.length} rewrite(s) beat ` +
          `the baseline. Recommended: ${best.label} (candidate_id ${best.candidateId}), ` +
          best.scores.map((score) => `${formatDelta(score.scoreDelta)} on ${score.model}`).join(', ') +
          '. Promote it with promote_optimize_candidate only if the user agrees.'
        : `Optimize run ${run_id} succeeded, but none of its ${candidates.length} rewrite(s) ` +
          'beat the baseline. Nothing is worth promoting; keep the current version.';

      const payload = {
        runId: run_id,
        status: run.status,
        judgeModel: report?.judge?.model ?? null,
        // Null means the built-in judge graded the run.
        judgePromptVersionId: report?.judge?.promptVersionId ?? null,
        recommended: best?.candidateId ?? null,
        baseline: (report?.cells ?? [])
          .filter((cell) => cell.isProductionBaseline)
          .map((cell) => ({
            label: cell.variantLabel,
            model: cell.model,
            avgScore: cell.avgScore,
            passRate: cell.passRate,
          })),
        candidates: withContent,
      };
      const full = okResult(summary, payload, config.maxTextBytes);
      if (!isTruncated(full)) return full;

      // Cutting the JSON would drop the last candidates' ids and leave invalid JSON, so
      // drop every rewrite's messages instead and keep all the ids and scores.
      return okResult(
        `${summary} The rewrites are too long to show together, so their messages are left ` +
          'out; call get_optimize_report again with candidate_id to read one.',
        {
          ...payload,
          messagesOmitted: true,
          candidates: withContent.map(({ messages: _messages, ...rest }) => rest),
        },
        config.maxTextBytes,
      );
    },
  }),

  defineTool({
    name: 'promote_optimize_candidate',
    title: 'Ship an optimizer rewrite as a new prompt version',
    toolset: 'evaluations',
    readOnlyHint: false,
    destructiveHint: true,
    description:
      'Commit one rewrite from a succeeded optimize run as a new prompt version and move ' +
      '`alias` to it, so live traffic on that alias starts using it. `alias` defaults to the ' +
      'alias the run was scored against (production when the run used the latest version). ' +
      'Take `candidate_id` from get_optimize_report. Refuses a rewrite that did not beat the ' +
      'baseline, and refuses when the alias now points at a version other than the one the ' +
      'run scored against; set `promote_without_improvement` only when the user has ' +
      'explicitly asked to ship that rewrite anyway. Undo by moving the alias back with ' +
      'promote_prompt_alias.',
    inputSchema: {
      run_id: z.string().uuid().describe('Optimize run UUID.'),
      candidate_id: z.string().uuid().describe('Candidate id from get_optimize_report.'),
      alias: z
        .string()
        .min(1)
        .optional()
        .describe('Alias to move. Default: the alias the run was scored against.'),
      promote_without_improvement: z
        .boolean()
        .optional()
        .describe(
          'Ship a rewrite that did not beat the baseline, or replace a version the run never ' +
            'scored. Only on the user\'s explicit say-so.',
        ),
    },
    async handler(args, { client, config }) {
      const { run, candidates } = await loadOptimizeRun(client, args.run_id);
      if (run.status !== 'succeeded') {
        throw new Error(
          `Optimize run ${args.run_id} is ${run.status}, so its rewrites are not fully scored. ` +
            'Promote only from a succeeded run.',
        );
      }

      const candidate = candidates.find((row) => row.candidateId === args.candidate_id);
      if (!candidate) {
        throw new Error(
          `Candidate ${args.candidate_id} is not a rewrite from run ${args.run_id}. ` +
            'Take the id from get_optimize_report.',
        );
      }
      if (!candidate.beatsBaseline && !args.promote_without_improvement) {
        const scores = candidate.scores
          .map((score) => `${formatDelta(score.scoreDelta)} (${score.verdict}) on ${score.model}`)
          .join(', ');
        throw new Error(
          `Refused: ${candidate.label} did not beat the baseline (${scores}). Promoting it ` +
            'would ship a prompt that scored no better than the current one. Set ' +
            'promote_without_improvement to true only if the user explicitly asked for this rewrite.',
        );
      }

      // A win only means something against the version that was scored. If the alias
      // points elsewhere now (it moved after the run, or it is a different alias), the
      // rewrite was never compared with what it would replace.
      const baseline = baselineOf(run);
      const alias = args.alias ?? baseline.alias ?? 'production';
      const detail = await client.get<CandidateDetailBody>(
        `/runs/${args.run_id}/candidates/${args.candidate_id}`,
      );
      const aliases = await client.get<AliasRow[]>(`/prompts/${detail.promptId}/aliases`);
      const live = aliases.find((row) => row.alias === alias);
      if (live && live.versionId !== baseline.versionId && !args.promote_without_improvement) {
        throw new Error(
          `Refused: alias "${alias}" now points at version ${live.versionNumber}, but run ` +
            `${args.run_id} scored its rewrites against a different version. Nothing compared ` +
            `${candidate.label} with version ${live.versionNumber}. Start a new optimize run ` +
            'against this alias, or set promote_without_improvement to true only if the user ' +
            'explicitly asked to replace it anyway.',
        );
      }

      const result = await client.post<{
        version: { id: string; versionNumber: number };
        alias: { alias: string };
      }>(`/runs/${args.run_id}/promote`, { prompt_candidate_id: args.candidate_id, alias });

      return okResult(
        `Promoted ${candidate.label} as version ${result.version.versionNumber}; alias ` +
          `"${result.alias.alias}" now points at it.`,
        result,
        config.maxTextBytes,
      );
    },
  }),
];
