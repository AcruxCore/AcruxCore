import { Prisma } from '@prisma/client';
import { ExperimentsRepository } from '../experiments/experiments.repository';
import { DatasetsRepository } from '../datasets/datasets.repository';
import { RunsRepository } from './runs.repository';
import { PromptsRepository } from '../../prompts/prompts.repository';
import { AliasesService } from '../../prompts/aliases/aliases.service';
import { VersionsRepository } from '../../prompts/versions/versions.repository';
import { MembersRepository } from '../../teams/members/members.repository';
import { getFlowProducer, EVAL_CELLS_QUEUE, EVAL_RUNS_QUEUE, finalizeJobOpts } from '../queue';
import { NotFoundError } from '../../shared/errors';
import { buildRunReport } from './report.aggregate';
import { deriveGridShape, deriveRunKind, foldRunScores } from './run-list.aggregate';
import type { ExperimentConfig } from '../experiments/experiments.types';
import type {
  RunDetailDto,
  RunGridCell,
  RunListItemDto,
  RunListQuery,
  RunListResponse,
  RunSnapshotExample,
  StartRunResult,
  RunCellDetailDto,
} from './runs.types';
import type { RunReport } from './report.types';

/**
 * Business logic for starting and reading experiment runs: freezes the
 * dataset's examples, resolves the full (prompt-version × model) grid —
 * including an automatic baseline per model, resolved via a named alias, or
 * (when none is given) the prompt's `production` alias, falling back to its
 * latest committed version if there is no `production` alias — persists the
 * run, and enqueues a BullMQ Flow (cell jobs as children of a finalize job).
 */
export class RunsService {
  constructor(
    private readonly experimentsRepo: ExperimentsRepository,
    private readonly datasetsRepo: DatasetsRepository,
    private readonly runsRepo: RunsRepository,
    private readonly promptsRepo: PromptsRepository,
    private readonly aliasesService: AliasesService,
    private readonly versionsRepo: VersionsRepository,
    private readonly membersRepo: MembersRepository,
  ) {}

  /**
   * Starts a new run for an experiment: freezes the dataset's examples into
   * `exampleSnapshot`, resolves the `grid` (explicit `config.versionIds` ×
   * `config.models`, plus one resolved-baseline cell per model — via
   * `config.alias`, or `production` falling back to the latest committed
   * version when no alias is given — when it is not already covered by an
   * explicit cell), persists the run, and enqueues a
   * BullMQ Flow — one finalize job (parent) with one cell job (child) per
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
      history: example.history as unknown as RunSnapshotExample['history'],
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
   * Lists the team's runs newest-first for the run-history screen, with each
   * run's evaluated dataset/prompt, the shape of its frozen grid, and the
   * scores it produced.
   *
   * The scores are computed on read from `eval_results` (there is no per-run
   * summary table, exactly as with {@link getReport}), so a run still in flight
   * lists the partial numbers it has produced so far rather than nothing.
   *
   * @param teamId - Isolation boundary.
   * @param query - Validated query params: optional `status`/`dataset_id`/
   *   `prompt_id` filters plus `page`/`limit`.
   * @returns The `{ data, total, page, limit }` envelope this platform's list
   *   endpoints share.
   */
  async listRuns(teamId: string, query: RunListQuery): Promise<RunListResponse> {
    const page = await this.runsRepo.listRuns(teamId, {
      ...(query.status ? { status: query.status } : {}),
      ...(query.dataset_id ? { datasetId: query.dataset_id } : {}),
      ...(query.prompt_id ? { promptId: query.prompt_id } : {}),
      page: query.page,
      limit: query.limit,
    });

    // One lookup for every distinct starter on the page, rather than per row.
    // Runs started by a team-scoped API key have no acting user (`createdBy`
    // null) and keep `startedBy: null`.
    const starterIds = [...new Set(page.runs.map((r) => r.createdBy).filter((id): id is string => id !== null))];
    const starters = await this.membersRepo.findEmailsByUserIds(starterIds);
    const starterById = new Map(starters.map((s) => [s.userId, s]));

    const data: RunListItemDto[] = page.runs.map((run) => {
      const scores = foldRunScores(page.aggregates.filter((a) => a.runId === run.id));
      const shape = deriveGridShape(run.grid);
      const starter = run.createdBy ? starterById.get(run.createdBy) : undefined;

      return {
        id: run.id,
        status: run.status,
        kind: deriveRunKind(run.grid),
        experimentId: run.experimentId,
        experimentName: run.experimentName,
        datasetId: run.datasetId,
        datasetName: run.datasetName,
        promptId: run.promptId,
        promptName: run.promptName,
        variantCount: shape.variantCount,
        modelCount: shape.modelCount,
        exampleCount: run.exampleCount,
        results: scores.results,
        avgScore: scores.avgScore,
        passRate: scores.passRate,
        topVariantLabel: scores.topVariantLabel,
        startedBy: starter ? { id: starter.userId, name: starter.name, email: starter.email } : null,
        createdAt: run.createdAt.toISOString(),
        startedAt: run.startedAt ? run.startedAt.toISOString() : null,
        endedAt: run.endedAt ? run.endedAt.toISOString() : null,
        durationMs:
          run.startedAt && run.endedAt ? run.endedAt.getTime() - run.startedAt.getTime() : null,
      };
    });

    return { data, total: page.total, page: query.page, limit: query.limit };
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
    const frozenHistory = new Map(snapshot.map((e) => [e.exampleId, e.history]));

    return {
      cellKey,
      variantLabel: variantLabel ?? '',
      model,
      examples: rows.map((row) => ({
        exampleId: row.datasetExampleId,
        input: row.example.input as Record<string, unknown>,
        criteria: frozenCriteria.get(row.datasetExampleId) ?? row.example.criteria,
        history: frozenHistory.get(row.datasetExampleId) ?? null,
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
   * additional baseline cell per model for the resolved comparison baseline
   * (`config.alias`'s current version, or — when `config.alias` is omitted —
   * `production`'s current version, falling back to the prompt's latest
   * committed version if it has no `production` alias; see
   * `AliasesService.resolveBaselineVersion`), unless that version id is
   * already among `config.versionIds`. Every explicit version id is verified
   * to belong to `teamId` before being placed in the grid — a queue payload
   * must never carry an id from another team (the same defense-in-depth rule
   * `processCell` enforces on the consuming side).
   *
   * @param teamId - Isolation boundary.
   * @param promptId - The experiment's prompt under test, or null if none was set.
   * @param config - The experiment's resolved sweep (`versionIds`, `models`, optional `alias`).
   * @returns The resolved grid cells (explicit + baseline).
   * @throws {NotFoundError} If an explicit version id does not resolve for this team.
   */
  private async resolveGrid(
    teamId: string,
    promptId: string | null,
    config: ExperimentConfig,
  ): Promise<RunGridCell[]> {
    const cells: RunGridCell[] = [];

    // Resolve the run's comparison baseline up front, so an explicit cell
    // that *is* the baseline version can be flagged as such (see
    // RunGridCell.isProductionBaseline). Null if no prompt is set, or the
    // prompt has no committed versions yet and no alias was requested.
    let baselineVersionId: string | null = null;
    let baselineLabel = 'production';
    if (promptId) {
      const prompt = await this.promptsRepo.findById(promptId, teamId);
      if (prompt) {
        const baseline = await this.aliasesService.resolveBaselineVersion(teamId, promptId, config.alias);
        if (baseline) {
          baselineVersionId = baseline.versionId;
          baselineLabel = baseline.alias ?? `v${baseline.versionNumber}`;
        }
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
          // An explicitly-listed version that happens to be the resolved
          // baseline IS the baseline, even though it is labeled v<N>.
          isProductionBaseline: versionId === baselineVersionId,
        });
      }
    }

    // Add a dedicated baseline cell per model only when the baseline version
    // is not already covered by an explicit cell above.
    if (baselineVersionId && !config.versionIds.includes(baselineVersionId)) {
      for (const model of config.models) {
        cells.push({
          cellKey: `${baselineLabel}|${model}`,
          variantKind: 'version',
          promptVersionId: baselineVersionId,
          variantLabel: baselineLabel,
          model,
          isProductionBaseline: true,
        });
      }
    }

    return cells;
  }
}
