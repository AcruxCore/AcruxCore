import { Prisma } from '@prisma/client';
import { ExperimentsRepository } from '../experiments/experiments.repository';
import { DatasetsRepository } from '../datasets/datasets.repository';
import { RunsRepository } from './runs.repository';
import { PromptsRepository } from '../../prompts/prompts.repository';
import { AliasesRepository } from '../../prompts/aliases/aliases.repository';
import { VersionsRepository } from '../../prompts/versions/versions.repository';
import { getFlowProducer, EVAL_CELLS_QUEUE, EVAL_RUNS_QUEUE, finalizeJobOpts } from '../queue';
import { NotFoundError } from '../../shared/errors';
import { buildRunReport } from './report.aggregate';
import type { ExperimentConfig } from '../experiments/experiments.types';
import type { RunDetailDto, RunGridCell, RunSnapshotExample, StartRunResult, RunCellDetailDto } from './runs.types';
import type { RunReport } from './report.types';

/**
 * Business logic for starting and reading experiment runs: freezes the
 * dataset's examples, resolves the full (prompt-version × model) grid —
 * including an automatic production-alias baseline per model — persists the
 * run, and enqueues a BullMQ Flow (cell jobs as children of a finalize job).
 */
export class RunsService {
  constructor(
    private readonly experimentsRepo: ExperimentsRepository,
    private readonly datasetsRepo: DatasetsRepository,
    private readonly runsRepo: RunsRepository,
    private readonly promptsRepo: PromptsRepository,
    private readonly aliasesRepo: AliasesRepository,
    private readonly versionsRepo: VersionsRepository,
  ) {}

  /**
   * Starts a new run for an experiment: freezes the dataset's examples into
   * `exampleSnapshot`, resolves the `grid` (explicit `config.versionIds` ×
   * `config.models`, plus one production-baseline cell per model when the
   * experiment's `promptId`'s current `production` version is not already
   * covered by an explicit cell), persists the run, and enqueues a BullMQ
   * Flow — one finalize job (parent) with one cell job (child) per
   * `grid × exampleSnapshot` pair.
   *
   * @param teamId - Isolation boundary.
   * @param userId - The acting user's id. Currently unused (no audit event is
   *   recorded for run starts) but kept for interface parity with other
   *   mutating service methods and for future use.
   * @param experimentId - UUID of the experiment to run.
   * @returns The created run's id and its initial `queued` status.
   * @throws {NotFoundError} If the experiment, its dataset, or any explicit
   *   `config.versionIds` entry does not resolve for this team.
   */
  async startRun(teamId: string, userId: string | null, experimentId: string): Promise<StartRunResult> {
    // How many times each cell (one gateway call) is attempted before it is
    // recorded as a terminal error. Default 3; tunable for flakier providers.
    const cellAttempts = Number(process.env.EVAL_CELL_JOB_ATTEMPTS ?? 3);

    const experiment = await this.experimentsRepo.getById(teamId, experimentId);
    if (!experiment) throw new NotFoundError('Experiment not found.');

    const dataset = await this.datasetsRepo.getDatasetById(teamId, experiment.datasetId);
    if (!dataset) throw new NotFoundError('Dataset not found.');

    const exampleSnapshot: RunSnapshotExample[] = dataset.examples.map((example) => ({
      exampleId: example.id,
      input: example.input as Record<string, unknown>,
      criteria: example.criteria,
    }));

    const config = experiment.config as unknown as ExperimentConfig;
    const grid = await this.resolveGrid(teamId, experiment.promptId, config);

    const run = await this.runsRepo.createRun(teamId, experimentId, {
      exampleSnapshot: exampleSnapshot as unknown as Prisma.InputJsonValue,
      grid: grid as unknown as Prisma.InputJsonValue,
      // Recorded so the run-finished email can reach whoever is waiting on it.
      // Null for a team-scoped API key caller, which has no acting user.
      createdBy: userId,
    });

    await getFlowProducer().add({
      name: 'finalize',
      queueName: EVAL_RUNS_QUEUE,
      data: { teamId, runId: run.id },
      opts: finalizeJobOpts(grid.length * exampleSnapshot.length),
      children: grid.flatMap((cell) =>
        exampleSnapshot.map((example) => ({
          name: 'cell',
          queueName: EVAL_CELLS_QUEUE,
          data: {
            teamId,
            runId: run.id,
            cellKey: cell.cellKey,
            promptVersionId: cell.promptVersionId,
            variantLabel: cell.variantLabel,
            variantKind: cell.variantKind,
            model: cell.model,
            exampleId: example.exampleId,
            // Freeze the dataset-level directive onto the cell job so
            // cell.processor can forward it to the judge job — the judge then
            // grades against this frozen value, not the live mutable dataset
            // (FAQ Q5 reproducibility).
            overallFeedback: dataset.overallFeedback,
          },
          opts: {
            // Retries-with-backoff for flaky provider calls (FAQ Q13): a cell
            // is a single gateway/LLM call, which can fail transiently (rate
            // limit, 5xx, timeout). Retry a few times with exponential backoff
            // before giving the cell up as terminally failed. Tunable via
            // EVAL_CELL_JOB_ATTEMPTS for slower/flakier providers.
            attempts: cellAttempts,
            backoff: { type: 'exponential', delay: 1000 },
            // CRITICAL: without a failure policy, a permanently-failed cell
            // child is never removed from this finalize parent's BullMQ
            // dependency set, so the parent stays in `waiting-children`
            // forever and the run hangs at `queued` (BullMQ only clears a
            // failed child from the parent when one of
            // ignoreDependencyOnFailure / removeDependencyOnFailure /
            // failParentOnFailure is set). `ignoreDependencyOnFailure` is the
            // right choice: one failed cell must NOT fail the whole run — the
            // worker's `'failed'` handler writes a terminal error `eval_result`
            // row, and `processFinalize` counts that row and still finalizes
            // (marking the run `failed` only if EVERY cell errored). There is
            // a benign race where finalize runs before the error row is
            // written, sees fewer results than expected, throws, and self-heals
            // on the finalize job's own retry (see the parent `opts` above).
            ignoreDependencyOnFailure: true,
          },
        })),
      ),
    });

    return { runId: run.id, status: 'queued' };
  }

  /**
   * Reads one run's status/timestamps plus a summary of its produced results.
   *
   * @param teamId - Isolation boundary.
   * @param runId - UUID of the run.
   * @returns The run's status/timestamps, its grid, and a `{ total, succeeded, errored }` results summary.
   * @throws {NotFoundError} If the run does not exist for this team.
   */
  async getRun(teamId: string, runId: string): Promise<RunDetailDto> {
    const run = await this.runsRepo.getRunById(teamId, runId);
    if (!run) throw new NotFoundError('Run not found.');

    const grid = run.grid as unknown as RunGridCell[];
    const errored = run.results.filter((r) => r.errorMessage !== null).length;

    return {
      id: run.id,
      experimentId: run.experimentId,
      status: run.status,
      startedAt: run.startedAt ? run.startedAt.toISOString() : null,
      endedAt: run.endedAt ? run.endedAt.toISOString() : null,
      error: run.error,
      createdAt: run.createdAt.toISOString(),
      grid,
      exampleCount: (run.exampleSnapshot as unknown[]).length,
      results: {
        total: run.results.length,
        succeeded: run.results.length - errored,
        errored,
      },
    };
  }

  /**
   * Builds the comparison report for a run: the full (variant × model)
   * matrix of per-cell averages, each non-baseline cell's regression delta
   * vs. the same-model production-baseline cell, a leaderboard, and an
   * advisory winner. Computed on read from the run's `eval_result` rows via
   * the pure `buildRunReport` aggregator (E5 Task 1) — there is no dedicated
   * report table, so a run still mid-flight (some grid cells not yet
   * produced/judged) returns a partial report rather than an error.
   *
   * @param teamId - Isolation boundary.
   * @param runId - UUID of the run.
   * @returns The computed {@link RunReport}.
   * @throws {NotFoundError} If the run does not exist for this team.
   */
  async getReport(teamId: string, runId: string): Promise<RunReport> {
    const data = await this.runsRepo.getRunWithResults(teamId, runId);
    if (!data) throw new NotFoundError('Run not found.');

    return buildRunReport({
      run: { id: data.id, status: data.status, grid: data.grid },
      results: data.results,
    });
  }

  /**
   * Drills into one grid cell's per-example outputs, judge reasoning, and
   * traces.
   *
   * @param teamId - Isolation boundary.
   * @param runId - UUID of the run.
   * @param cellKey - The cell's `${variantLabel}|${model}` key — the same
   *   format `resolveGrid` mints into `ExperimentRun.grid[].cellKey` — already
   *   url-decoded by the controller.
   * @returns The cell's per-example rows (empty if the cell has produced
   *   nothing yet, or `cellKey` does not match any grid cell).
   * @throws {NotFoundError} If the run does not exist for this team.
   */
  async getCell(teamId: string, runId: string, cellKey: string): Promise<RunCellDetailDto> {
    const run = await this.runsRepo.getRunById(teamId, runId);
    if (!run) throw new NotFoundError('Run not found.');

    // cellKey is always `${variantLabel}|${model}` (RunsService.resolveGrid).
    // variantLabel itself never contains '|' ('v<N>' or 'production'), so
    // splitting on the first occurrence and rejoining the remainder handles
    // a model name that (hypothetically) contained one too.
    const [variantLabel, ...modelParts] = cellKey.split('|');
    const model = modelParts.join('|');

    const rows = await this.runsRepo.getCellResults(teamId, runId, variantLabel ?? '', model);

    // Show the criteria the run was actually GRADED against — the value frozen
    // into the snapshot at run-start — not the (possibly since-edited) live
    // dataset value. Falls back to the live value for runs created before the
    // snapshot carried criteria (or if an example isn't in the snapshot).
    const snapshot = run.exampleSnapshot as unknown as RunSnapshotExample[];
    const frozenCriteria = new Map(snapshot.map((e) => [e.exampleId, e.criteria]));

    return {
      cellKey,
      variantLabel: variantLabel ?? '',
      model,
      examples: rows.map((row) => ({
        exampleId: row.datasetExampleId,
        input: row.example.input as Record<string, unknown>,
        criteria: frozenCriteria.get(row.datasetExampleId) ?? row.example.criteria,
        output: row.output,
        score: row.score,
        passed: row.passed,
        reason: row.reason,
        traceId: row.traceId,
        judgeTraceId: row.judgeTraceId,
      })),
    };
  }

  /**
   * Resolves the full (prompt-version × model) grid for a run: one cell per
   * explicit `config.versionIds × config.models` pair, plus — when the
   * experiment names a `promptId` that resolves for this team — one
   * additional `variantLabel: 'production'` cell per model for the prompt's
   * current `production` alias version, unless that version id is already
   * among `config.versionIds`. Every explicit version id is verified to
   * belong to `teamId` before being placed in the grid — a queue payload must
   * never carry an id from another team (the same defense-in-depth rule
   * `processCell` enforces on the consuming side).
   *
   * @param teamId - Isolation boundary.
   * @param promptId - The experiment's prompt under test, or null if none was set.
   * @param config - The experiment's resolved sweep (`versionIds`, `models`).
   * @returns The resolved grid cells (explicit + baseline).
   * @throws {NotFoundError} If an explicit version id does not resolve for this team.
   */
  private async resolveGrid(
    teamId: string,
    promptId: string | null,
    config: ExperimentConfig,
  ): Promise<RunGridCell[]> {
    const cells: RunGridCell[] = [];

    // Resolve the prompt's current production version up front, so an explicit
    // cell that *is* the production version can be flagged as the baseline
    // (see RunGridCell.isProductionBaseline). Null if no prompt/alias resolves.
    let productionVersionId: string | null = null;
    if (promptId) {
      const prompt = await this.promptsRepo.findById(promptId, teamId);
      if (prompt) {
        const production = await this.aliasesRepo.findByAlias(promptId, 'production');
        productionVersionId = production?.versionId ?? null;
      }
    }

    for (const versionId of config.versionIds) {
      const version = await this.versionsRepo.findByIdForTeam(versionId, teamId);
      if (!version) throw new NotFoundError(`Prompt version ${versionId} not found.`);

      const variantLabel = `v${version.versionNumber}`;
      for (const model of config.models) {
        cells.push({
          cellKey: `${variantLabel}|${model}`,
          variantKind: 'version',
          promptVersionId: versionId,
          variantLabel,
          model,
          // An explicitly-listed version that happens to be the current
          // production version IS the baseline, even though it is labeled v<N>.
          isProductionBaseline: versionId === productionVersionId,
        });
      }
    }

    // Add a dedicated production-baseline cell per model only when the
    // production version is not already covered by an explicit cell above.
    if (productionVersionId && !config.versionIds.includes(productionVersionId)) {
      for (const model of config.models) {
        cells.push({
          cellKey: `production|${model}`,
          variantKind: 'version',
          promptVersionId: productionVersionId,
          variantLabel: 'production',
          model,
          isProductionBaseline: true,
        });
      }
    }

    return cells;
  }
}
