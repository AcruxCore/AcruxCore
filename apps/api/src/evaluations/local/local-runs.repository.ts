import { Prisma } from '@prisma/client';
import prisma from '../../shared/db/client';

/** The run fields a local-run write needs to check before it touches results. */
export interface LocalRunHeader {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  grid: Prisma.JsonValue;
  exampleSnapshot: Prisma.JsonValue;
  /** The parent experiment's `config`, which names the run's primary score. */
  experimentConfig: Prisma.JsonValue;
}

/** One `eval_results` row to write for a local run. */
export interface LocalResultRow {
  datasetExampleId: string;
  variantLabel: string;
  model: string;
  output: Prisma.InputJsonValue | typeof Prisma.DbNull;
  traceId: string | null;
  errorMessage: string | null;
  score: number | null;
  passed: boolean | null;
  reason: string | null;
  scores: Prisma.InputJsonValue;
}

/**
 * Every query of the local-experiment flow (phase-5 FAQ Q46). A local run is
 * an ordinary `experiment_runs` row, so the reads elsewhere stay in
 * `RunsRepository`; this file holds only the writes the SDK drives.
 */
export class LocalRunsRepository {
  /**
   * Creates a local experiment and its one run in one transaction, so a
   * failure never leaves an experiment with no run. The run starts `running`:
   * the caller's SDK begins producing results as soon as this returns.
   *
   * @param teamId - Isolation boundary. Dataset ownership is the caller's job.
   * @param createdBy - The acting user, or null for a team-scoped API key.
   * @param data - Experiment name and config, plus the run's frozen snapshot and grid.
   * @returns The new experiment and run ids.
   */
  async createExperimentWithRun(
    teamId: string,
    createdBy: string | null,
    data: {
      datasetId: string;
      name: string;
      config: Prisma.InputJsonValue;
      exampleSnapshot: Prisma.InputJsonValue;
      grid: Prisma.InputJsonValue;
    },
  ): Promise<{ experimentId: string; runId: string }> {
    return prisma.$transaction(async (tx) => {
      const experiment = await tx.experiment.create({
        data: { teamId, datasetId: data.datasetId, name: data.name, config: data.config, createdBy },
      });
      const run = await tx.experimentRun.create({
        data: {
          teamId,
          experimentId: experiment.id,
          status: 'running',
          startedAt: new Date(),
          exampleSnapshot: data.exampleSnapshot,
          grid: data.grid,
          createdBy,
        },
      });
      return { experimentId: experiment.id, runId: run.id };
    });
  }

  /**
   * Reads the fields a results write or a finish checks.
   *
   * @param teamId - Isolation boundary.
   * @param runId - Run UUID.
   * @returns The run header, or null when the run is not this team's.
   */
  async findRun(teamId: string, runId: string): Promise<LocalRunHeader | null> {
    const run = await prisma.experimentRun.findFirst({
      where: { id: runId, teamId },
      select: { id: true, status: true, grid: true, exampleSnapshot: true, experiment: { select: { config: true } } },
    });
    if (!run) return null;
    const { experiment, ...header } = run;
    return { ...header, experimentConfig: experiment.config };
  }

  /**
   * Writes a batch of results, replacing any earlier result for the same
   * example. Replace-not-append is what makes a retried upload safe: the SDK
   * resends a batch whose response it never saw, and the run still holds one
   * row per example — also when the retry arrives while the first try is still
   * being written, because the run row is locked for the transaction.
   *
   * @param teamId - Isolation boundary.
   * @param runId - Run UUID; the caller has checked it is a running local run.
   * @param rows - One row per example; example ids are unique within the batch.
   * @returns How many examples of the run have a result after the write.
   */
  async replaceResults(teamId: string, runId: string, rows: LocalResultRow[]): Promise<number> {
    return prisma.$transaction(async (tx) => {
      // Serialize writes to one run. Without the lock, two uploads of the same batch
      // (a retry that races the first try) each delete nothing under READ COMMITTED
      // and both insert, leaving two rows per example. There is no unique index on
      // (run, example) to stop that: a server-side run holds one row per cell.
      await tx.$queryRaw`SELECT id FROM experiment_runs WHERE id = ${runId}::uuid AND team_id = ${teamId}::uuid FOR UPDATE`;
      await tx.evalResult.deleteMany({
        where: { teamId, experimentRunId: runId, datasetExampleId: { in: rows.map((r) => r.datasetExampleId) } },
      });
      await tx.evalResult.createMany({
        data: rows.map((row) => ({
          teamId,
          experimentRunId: runId,
          datasetExampleId: row.datasetExampleId,
          variantKind: 'local',
          variantLabel: row.variantLabel,
          model: row.model,
          output: row.output,
          traceId: row.traceId,
          errorMessage: row.errorMessage,
          score: row.score,
          passed: row.passed,
          reason: row.reason,
          scores: row.scores,
        })),
      });
      return tx.evalResult.count({ where: { teamId, experimentRunId: runId } });
    });
  }

  /**
   * Counts a run's results and how many of them errored, to decide the
   * status `finish` sets.
   *
   * @param teamId - Isolation boundary.
   * @param runId - Run UUID.
   * @returns Total and errored result counts.
   */
  async countResults(teamId: string, runId: string): Promise<{ total: number; errored: number }> {
    const [total, errored] = await Promise.all([
      prisma.evalResult.count({ where: { teamId, experimentRunId: runId } }),
      prisma.evalResult.count({ where: { teamId, experimentRunId: runId, errorMessage: { not: null } } }),
    ]);
    return { total, errored };
  }

  /**
   * Moves a running run to its terminal status. Conditional on `running`, so a
   * finish that races the stale-run sweep (or a second finish) cannot rewrite a
   * run that has already ended.
   *
   * @param teamId - Isolation boundary.
   * @param runId - Run UUID.
   * @param status - `succeeded` or `failed`.
   * @param error - The reason shown on a failed run, or null.
   * @returns `1` when the run was finished by this call, `0` when it had already ended.
   */
  async finishRun(
    teamId: string,
    runId: string,
    status: 'succeeded' | 'failed',
    error: string | null,
  ): Promise<number> {
    const { count } = await prisma.experimentRun.updateMany({
      where: { id: runId, teamId, status: 'running' },
      data: { status, error, endedAt: new Date() },
    });
    return count;
  }
}
