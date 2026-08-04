import { Prisma } from '@prisma/client';
import prisma from '../../shared/db/client';
import type { ReportGridCell, EvalResultRow } from './report.types';
import type { RunListFilters, RunVariantAggregate } from './runs.types';

/** An experiment run row including its produced results. */
export type ExperimentRunWithResults = Prisma.ExperimentRunGetPayload<{ include: { results: true } }>;

/**
 * An eval_result row plus the two judge inputs reached through its relations:
 * its example's per-example `criteria`, and that example's parent dataset's
 * dataset-level `overallFeedback`.
 */
export type EvalResultWithJudgeInputs = Prisma.EvalResultGetPayload<{
  include: { example: { include: { dataset: { select: { overallFeedback: true } } } } };
}>;

/**
 * An eval_result row plus its example's `input`/`criteria`, for the cell
 * drill-down endpoint (`GET /runs/:id/cells/:cellKey`).
 */
export type EvalResultWithExample = Prisma.EvalResultGetPayload<{
  include: { example: { select: { input: true; criteria: true } } };
}>;

/** A run's grid + produced results, shaped for {@link buildRunReport}'s input. */
export interface RunReportInputs {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  grid: ReportGridCell[];
  results: EvalResultRow[];
}

/** One (variant × model) cell as frozen into `ExperimentRun.grid` at run-start (`RunsService.resolveGrid`). */
interface RawGridCell {
  cellKey: string;
  variantKind: string;
  promptVersionId: string | null;
  variantLabel: string;
  model: string;
  /** Frozen by `RunsService.resolveGrid`/the E6 optimizer. Absent on runs
   * created before that field shipped — hence optional here (see the fallback
   * in `getRunWithResults`). */
  isProductionBaseline?: boolean;
}

/**
 * One run of the history list as read from storage: the run row plus the names
 * reached through its experiment, and the frozen grid/example count the DTO's
 * "shape" fields are derived from. `exampleSnapshot` itself is never selected —
 * a run's snapshot holds every example's full input (and prior-turn history),
 * so the count comes from `jsonb_array_length` in SQL instead of loading it.
 */
export interface RunListRow {
  id: string;
  status: string;
  experimentId: string;
  experimentName: string | null;
  datasetId: string;
  datasetName: string;
  promptId: string | null;
  promptName: string | null;
  grid: RawGridCell[];
  exampleCount: number;
  createdBy: string | null;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
}

/** One page of the run-history list plus the full filtered count. */
export interface RunListPage {
  runs: RunListRow[];
  aggregates: RunVariantAggregate[];
  total: number;
}

/** Raw shape of the `jsonb_array_length` example-count query. */
interface ExampleCountRow {
  runId: string;
  exampleCount: number;
}

/**
 * Data access for the `experiment_runs` and `eval_results` tables. The only
 * files in this domain (alongside `experiments.repository.ts`) that touch
 * Prisma. `setRunStatus`, `writeResult`, and `writeResultError` are called
 * from queue processors (not HTTP handlers) — team-scoping for those already
 * happened when the run was created/looked up, so they are not re-scoped here.
 */
export class RunsRepository {
  /**
   * Creates a queued run with the frozen example snapshot + resolved grid.
   *
   * @param teamId - Isolation boundary.
   * @param experimentId - Parent experiment UUID.
   * @param data - Frozen example set (`exampleSnapshot`), resolved cell grid
   *   (`grid`), and the acting user (`createdBy`, null for a team-scoped API key
   *   caller — the run-finished notification falls back to the experiment's
   *   creator and then to the team's owners).
   * @returns The created run row (status defaults to `queued`).
   */
  async createRun(
    teamId: string,
    experimentId: string,
    data: {
      exampleSnapshot: Prisma.InputJsonValue;
      grid: Prisma.InputJsonValue;
      createdBy?: string | null;
    },
  ): Promise<Prisma.ExperimentRunGetPayload<{}>> {
    return prisma.experimentRun.create({
      data: {
        teamId,
        experimentId,
        status: 'queued',
        exampleSnapshot: data.exampleSnapshot,
        grid: data.grid,
        createdBy: data.createdBy ?? null,
      },
    });
  }

  /**
   * Lists a team's runs newest-first for the run-history screen (`GET /runs`),
   * with the names reached through each run's experiment and the result
   * aggregates behind its scores.
   *
   * Three queries, none of which grows with the team's history: the filtered
   * count, the page of runs, and one grouped aggregate restricted to the
   * page's run ids (plus a `jsonb_array_length` read for the frozen example
   * counts, folded into the page query's ids as well). Aggregating only the
   * page is what keeps this affordable — a team with 10k runs pays the same as
   * a team with 20.
   *
   * @param teamId - Isolation boundary.
   * @param filters - Optional `status`/`datasetId`/`promptId` narrowing, plus
   *   the 1-based `page` and `limit` (already capped by the Zod schema).
   * @returns The page's runs, the per-(run × variant) aggregates for them, and
   *   the total number of runs matching the filters.
   */
  async listRuns(teamId: string, filters: RunListFilters): Promise<RunListPage> {
    const where: Prisma.ExperimentRunWhereInput = {
      teamId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.datasetId || filters.promptId
        ? {
            experiment: {
              ...(filters.datasetId ? { datasetId: filters.datasetId } : {}),
              ...(filters.promptId ? { promptId: filters.promptId } : {}),
            },
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.experimentRun.count({ where }),
      prisma.experimentRun.findMany({
        where,
        select: {
          id: true,
          status: true,
          experimentId: true,
          grid: true,
          createdBy: true,
          createdAt: true,
          startedAt: true,
          endedAt: true,
          experiment: {
            select: {
              name: true,
              datasetId: true,
              promptId: true,
              dataset: { select: { name: true } },
              prompt: { select: { name: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
    ]);

    if (rows.length === 0) return { runs: [], aggregates: [], total };

    const runIds = rows.map((r) => r.id);
    const [exampleCounts, aggregates] = await Promise.all([
      this.exampleCountsForRuns(runIds),
      this.variantAggregatesForRuns(teamId, runIds),
    ]);
    const countByRun = new Map(exampleCounts.map((c) => [c.runId, c.exampleCount]));

    return {
      runs: rows.map((r) => ({
        id: r.id,
        status: r.status,
        experimentId: r.experimentId,
        experimentName: r.experiment.name,
        datasetId: r.experiment.datasetId,
        datasetName: r.experiment.dataset.name,
        promptId: r.experiment.promptId,
        promptName: r.experiment.prompt?.name ?? null,
        grid: r.grid as unknown as RawGridCell[],
        exampleCount: countByRun.get(r.id) ?? 0,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
      })),
      aggregates,
      total,
    };
  }

  /**
   * Reads the frozen example count for each of the given runs without loading
   * the snapshots themselves — `jsonb_array_length` is not expressible in the
   * query builder, hence `Prisma.sql`.
   *
   * @param runIds - Run UUIDs (non-empty; already team-scoped by the caller).
   * @returns One row per run id, with the length of its `example_snapshot` array.
   */
  private async exampleCountsForRuns(runIds: string[]): Promise<ExampleCountRow[]> {
    return prisma.$queryRaw<ExampleCountRow[]>(Prisma.sql`
      SELECT id AS "runId", jsonb_array_length(example_snapshot)::int AS "exampleCount"
      FROM experiment_runs
      WHERE id IN (${Prisma.join(runIds.map((id) => Prisma.sql`${id}::uuid`))})
    `);
  }

  /**
   * Groups the given runs' `eval_results` by (run, variant label), counting
   * errored/scored/passed rows and summing scores in one pass. Raw SQL because
   * the `COUNT(*) FILTER (WHERE …)` conditional aggregates are not expressible
   * through Prisma's `groupBy` (which would need one query per condition).
   *
   * @param teamId - Isolation boundary (re-applied here, not just on the run page).
   * @param runIds - Run UUIDs (non-empty).
   * @returns One aggregate row per (run, variant) pair that has produced results.
   *   A run that has produced none is simply absent.
   */
  private async variantAggregatesForRuns(teamId: string, runIds: string[]): Promise<RunVariantAggregate[]> {
    return prisma.$queryRaw<RunVariantAggregate[]>(Prisma.sql`
      SELECT
        experiment_run_id AS "runId",
        variant_label AS "variantLabel",
        COUNT(*)::int AS "total",
        COUNT(*) FILTER (WHERE error_message IS NOT NULL)::int AS "errored",
        COUNT(score)::int AS "scored",
        COALESCE(SUM(score), 0)::int AS "scoreSum",
        COUNT(*) FILTER (WHERE passed IS TRUE)::int AS "passed"
      FROM eval_results
      WHERE team_id = ${teamId}::uuid
        AND experiment_run_id IN (${Prisma.join(runIds.map((id) => Prisma.sql`${id}::uuid`))})
      GROUP BY experiment_run_id, variant_label
    `);
  }

  /**
   * Loads everything the run-finished notification needs, in one query.
   *
   * Kept separate from {@link getRunById} because that method eagerly includes
   * every `eval_result` row — a large run's full result set — and a notification
   * needs only counts, the experiment's name, and the two candidate recipients.
   *
   * @param runId - Run UUID. Already team-scoped by the caller.
   * @returns The run's notification context, or null when the run is gone.
   */
  async getRunNotificationContext(runId: string): Promise<{
    teamId: string;
    teamName: string;
    createdBy: string | null;
    startedAt: Date | null;
    endedAt: Date | null;
    experimentName: string | null;
    experimentCreatedBy: string | null;
    succeededCells: number;
    erroredCells: number;
  } | null> {
    const run = await prisma.experimentRun.findUnique({
      where: { id: runId },
      select: {
        teamId: true,
        createdBy: true,
        startedAt: true,
        endedAt: true,
        team: { select: { name: true } },
        experiment: { select: { name: true, createdBy: true } },
      },
    });
    if (!run) return null;

    const [erroredCells, totalCells] = await Promise.all([
      prisma.evalResult.count({ where: { experimentRunId: runId, errorMessage: { not: null } } }),
      prisma.evalResult.count({ where: { experimentRunId: runId } }),
    ]);

    return {
      teamId: run.teamId,
      teamName: run.team.name,
      createdBy: run.createdBy,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      experimentName: run.experiment.name,
      experimentCreatedBy: run.experiment.createdBy,
      succeededCells: totalCells - erroredCells,
      erroredCells,
    };
  }

  /**
   * Reads a run scoped to team, including its produced results.
   *
   * @param teamId - Isolation boundary.
   * @param id - Run UUID.
   * @returns The run with its results, or null if not found or in another team.
   */
  async getRunById(teamId: string, id: string): Promise<ExperimentRunWithResults | null> {
    return prisma.experimentRun.findFirst({
      where: { id, teamId },
      include: {
        results: true,
      },
    });
  }

  /**
   * Transitions a run's status, stamping whichever of startedAt/endedAt/error
   * are given. Not team-scoped: called from queue processors, which only ever
   * hold a run id that was already resolved team-scoped upstream.
   *
   * @param runId - Run UUID.
   * @param status - New lifecycle status.
   * @param patch - Optional fields to stamp alongside the status change.
   * @returns The updated run row.
   */
  /**
   * Marks a run `running` and stamps `startedAt` — but ONLY if it is still
   * `queued`. Called from every cell job as it begins (`processCell`), which
   * run concurrently: the `status: 'queued'` guard makes this a
   * transition-once operation, so a later cell can never re-stamp `startedAt`
   * (it would land the *last* cell's start time, not the first) and a run
   * that has already finalized to `succeeded`/`failed` is never dragged back
   * to `running`. Not team-scoped, matching `setRunStatus`: the caller holds a
   * run id already resolved team-scoped upstream.
   *
   * @param runId - Run UUID.
   * @returns The number of rows updated: `1` on the first cell (the run was
   *   still queued and was transitioned), `0` on every subsequent cell.
   */
  async markRunning(runId: string): Promise<number> {
    const { count } = await prisma.experimentRun.updateMany({
      where: { id: runId, status: 'queued' },
      data: { status: 'running', startedAt: new Date() },
    });
    return count;
  }

  async setRunStatus(
    runId: string,
    status: 'queued' | 'running' | 'succeeded' | 'failed',
    patch?: { startedAt?: Date; endedAt?: Date; error?: string },
  ): Promise<Prisma.ExperimentRunGetPayload<{}>> {
    return prisma.experimentRun.update({
      where: { id: runId },
      data: {
        status,
        ...(patch?.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
        ...(patch?.endedAt !== undefined ? { endedAt: patch.endedAt } : {}),
        ...(patch?.error !== undefined ? { error: patch.error } : {}),
      },
    });
  }

  /**
   * Overwrites a run's `grid` — used only by `processOptimize` (E6), which
   * cannot resolve the (candidate + production) x model grid until AFTER the
   * optimizer's own gateway call returns (unlike `startRun`, which resolves
   * its grid synchronously before the run row is even created). The run is
   * created with a placeholder `grid: []` at HTTP-request time
   * (`OptimizeService.startOptimize`); this fills it in once candidates are
   * drafted and persisted. Not team-scoped, matching `setRunStatus`: called
   * from a queue processor that already holds a team-scoped run id.
   *
   * @param runId - Run UUID.
   * @param grid - The resolved grid cells (`RunGridCell[]`, cast by the caller).
   * @returns The updated run row.
   */
  async setRunGrid(runId: string, grid: Prisma.InputJsonValue): Promise<Prisma.ExperimentRunGetPayload<{}>> {
    return prisma.experimentRun.update({
      where: { id: runId },
      data: { grid },
    });
  }

  /**
   * Lists a run's produced `eval_results` rows, team-scoped.
   *
   * @param teamId - Isolation boundary.
   * @param runId - Run UUID.
   * @returns Array of result rows for the run.
   */
  async listResultsForRun(teamId: string, runId: string): Promise<Prisma.EvalResultGetPayload<{}>[]> {
    return prisma.evalResult.findMany({
      where: { teamId, experimentRunId: runId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Writes a produced cell output (successful generation). Exactly one of
   * `promptVersionId`/`promptCandidateId` is set, mirroring `CellJobData`
   * (E6): a `'version'` cell (an explicit version or the production
   * baseline) carries `promptVersionId`; a `'candidate'` cell carries
   * `promptCandidateId` instead.
   *
   * @param data - Result identity (team/run/example/variant/model) plus the produced output and originating trace id.
   * @returns The created result row.
   */
  async writeResult(data: {
    teamId: string;
    experimentRunId: string;
    datasetExampleId: string;
    variantKind: string;
    promptVersionId?: string;
    promptCandidateId?: string;
    variantLabel: string;
    model: string;
    output: Prisma.InputJsonValue;
    traceId?: string;
  }): Promise<Prisma.EvalResultGetPayload<{}>> {
    return prisma.evalResult.create({
      data: {
        teamId: data.teamId,
        experimentRunId: data.experimentRunId,
        datasetExampleId: data.datasetExampleId,
        variantKind: data.variantKind,
        promptVersionId: data.promptVersionId ?? null,
        promptCandidateId: data.promptCandidateId ?? null,
        variantLabel: data.variantLabel,
        model: data.model,
        output: data.output,
        traceId: data.traceId ?? null,
      },
    });
  }

  /**
   * Records a cell that failed after retries. `EvalResult.output` is left as
   * SQL NULL (omitted, not `Prisma.JsonNull` — that would store a JSON
   * literal `null` rather than an absent value) and `errorMessage` carries
   * the failure reason.
   *
   * @param data - Result identity (team/run/example/variant/model) plus the error message.
   * @returns The created result row.
   */
  async writeResultError(data: {
    teamId: string;
    experimentRunId: string;
    datasetExampleId: string;
    variantKind: string;
    promptVersionId?: string;
    variantLabel: string;
    model: string;
    errorMessage: string;
  }): Promise<Prisma.EvalResultGetPayload<{}>> {
    return prisma.evalResult.create({
      data: {
        teamId: data.teamId,
        experimentRunId: data.experimentRunId,
        datasetExampleId: data.datasetExampleId,
        variantKind: data.variantKind,
        promptVersionId: data.promptVersionId ?? null,
        variantLabel: data.variantLabel,
        model: data.model,
        errorMessage: data.errorMessage,
      },
    });
  }

  /**
   * Reads one `eval_result` row scoped to team, including the two judge inputs
   * reached through its relations: the produced example's per-example
   * `criteria`, and that example's parent dataset's `overallFeedback`.
   *
   * @param teamId - Isolation boundary.
   * @param id - Result UUID.
   * @returns The result with its judge inputs, or null if not found or in another team.
   */
  async getResultById(teamId: string, id: string): Promise<EvalResultWithJudgeInputs | null> {
    return prisma.evalResult.findFirst({
      where: { id, teamId },
      include: {
        example: {
          include: {
            dataset: { select: { overallFeedback: true } },
          },
        },
      },
    });
  }

  /**
   * Writes a judge verdict (or an unscored placeholder on parse failure) onto
   * an `eval_result` row. Not team-scoped: called by `JudgeService`, which
   * only ever holds a result id already resolved team-scoped via
   * `getResultById`.
   *
   * @param resultId - Result UUID.
   * @param verdict - Judge outcome: `score`/`passed`/`reason` (all null when
   *   unscored) plus the `judgeTraceId` of the evaluate call that produced it.
   * @returns The updated result row.
   */
  async writeVerdict(
    resultId: string,
    verdict: { score: number | null; passed: boolean | null; reason: string | null; judgeTraceId: string | null },
  ): Promise<Prisma.EvalResultGetPayload<{}>> {
    return prisma.evalResult.update({
      where: { id: resultId },
      data: {
        score: verdict.score,
        passed: verdict.passed,
        reason: verdict.reason,
        judgeTraceId: verdict.judgeTraceId,
      },
    });
  }

  /**
   * Reads a run's grid + all produced `eval_result` rows, team-scoped and
   * shaped for the pure report aggregator (`buildRunReport`, E5 Task 1).
   *
   * `ExperimentRun.grid` (frozen by `RunsService.resolveGrid` at run-start)
   * carries an explicit `isProductionBaseline` flag per cell, which this reads
   * directly — the flag must be frozen, not re-derived from `variantLabel ===
   * 'production'`, because a run can name the production version *explicitly*
   * in `version_ids`, giving it a `v<N>` label yet still making it the
   * baseline. For runs created before that flag shipped (grids without it),
   * this falls back to the old `variantLabel === 'production'` heuristic. The
   * same per-cell flag is stamped onto each result row too (by its own
   * `variantLabel|model`), even though `buildRunReport` only reads it off the
   * grid cells — kept for parity with `EvalResultRow`'s optional field.
   *
   * @param teamId - Isolation boundary.
   * @param runId - Run UUID.
   * @returns `{ id, status, grid, results }` ready to pass into
   *   `buildRunReport`, or `null` if the run does not exist or belongs to
   *   another team.
   */
  async getRunWithResults(teamId: string, runId: string): Promise<RunReportInputs | null> {
    const run = await prisma.experimentRun.findFirst({
      where: { id: runId, teamId },
      include: { results: true },
    });
    if (!run) return null;

    const rawGrid = run.grid as unknown as RawGridCell[];
    const grid: ReportGridCell[] = rawGrid.map((cell) => ({
      cellKey: cell.cellKey,
      variantKind: cell.variantKind,
      promptVersionId: cell.promptVersionId,
      variantLabel: cell.variantLabel,
      model: cell.model,
      // Read the frozen flag; fall back to the label heuristic for pre-flag runs.
      isProductionBaseline: cell.isProductionBaseline ?? cell.variantLabel === 'production',
    }));
    const productionCellKeys = new Set(grid.filter((cell) => cell.isProductionBaseline).map((cell) => cell.cellKey));

    const results: EvalResultRow[] = run.results.map((row) => ({
      datasetExampleId: row.datasetExampleId,
      variantLabel: row.variantLabel,
      variantKind: row.variantKind,
      model: row.model,
      isProductionBaseline: productionCellKeys.has(`${row.variantLabel}|${row.model}`),
      score: row.score,
      passed: row.passed,
    }));

    return { id: run.id, status: run.status, grid, results };
  }

  /**
   * Reads one grid cell's produced `eval_result` rows, team-scoped, each
   * joined to its example's `input`/`criteria` — the cell drill-down
   * endpoint's data source (`GET /runs/:id/cells/:cellKey`).
   *
   * @param teamId - Isolation boundary.
   * @param runId - Run UUID.
   * @param variantLabel - The cell's prompt-variant label (`v<N>` or `'production'`).
   * @param model - The cell's model.
   * @returns The cell's result rows in creation order, each with its
   *   example's `input`/`criteria`. Empty array if the run/cell has produced
   *   nothing yet, or the run does not belong to `teamId`.
   */
  async getCellResults(
    teamId: string,
    runId: string,
    variantLabel: string,
    model: string,
  ): Promise<EvalResultWithExample[]> {
    return prisma.evalResult.findMany({
      where: { teamId, experimentRunId: runId, variantLabel, model },
      include: { example: { select: { input: true, criteria: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }
}
