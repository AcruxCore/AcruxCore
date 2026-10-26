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

/** What one judge call needs from its run: never the whole example snapshot. */
export interface LocalJudgeContext {
  grid: Prisma.JsonValue;
  /** `{ overallFeedback, judgePromptVersions }` frozen on the run; null on runs created before it was. */
  gradingSnapshot: Prisma.JsonValue;
  /** The one snapshot example with the asked-for id, or null if the run has none. */
  example: Prisma.JsonValue;
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
      gradingSnapshot: Prisma.InputJsonValue;
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
          kind: 'local',
          startedAt: new Date(),
          exampleSnapshot: data.exampleSnapshot,
          grid: data.grid,
          gradingSnapshot: data.gradingSnapshot,
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
      select: {
        id: true,
        status: true,
        grid: true,
        exampleSnapshot: true,
        experiment: { select: { config: true } },
      },
    });
    if (!run) return null;
    const { experiment, ...header } = run;
    return { ...header, experimentConfig: experiment.config };
  }

  /**
   * Reads what a judge call needs, picking the one example out of the run's
   * snapshot inside Postgres. A judge call grades one output, and an SDK makes
   * one call per example per variant; loading the whole snapshot each time made
   * a call cost 21 ms on a 1-example run and 240 ms on a 10,000-example one.
   *
   * @param teamId - Isolation boundary.
   * @param runId - Run UUID.
   * @param exampleId - The snapshot example to return.
   * @returns The run's grid, grading snapshot and that example, or null when the
   *   run is not this team's.
   */
  async findJudgeContext(teamId: string, runId: string, exampleId: string): Promise<LocalJudgeContext | null> {
    const [row] = await prisma.$queryRaw<Array<{ grid: Prisma.JsonValue; grading_snapshot: Prisma.JsonValue; example: Prisma.JsonValue }>>`
      SELECT r.grid, r.grading_snapshot,
        (SELECT e FROM jsonb_array_elements(r.example_snapshot) AS e WHERE e->>'exampleId' = ${exampleId} LIMIT 1) AS example
      FROM experiment_runs r
      WHERE r.id = ${runId}::uuid AND r.team_id = ${teamId}::uuid`;
    return row ? { grid: row.grid, gradingSnapshot: row.grading_snapshot, example: row.example } : null;
  }

  /**
   * The current overall feedback of a run's dataset — the judge's fallback for
   * a local run created before overall feedback was frozen onto the run.
   *
   * @param teamId - Isolation boundary.
   * @param runId - Run UUID.
   * @returns The dataset's overall feedback, or null if it has none.
   */
  async findDatasetOverallFeedback(teamId: string, runId: string): Promise<string | null> {
    const run = await prisma.experimentRun.findFirst({
      where: { id: runId, teamId },
      select: { experiment: { select: { dataset: { select: { overallFeedback: true } } } } },
    });
    return run?.experiment.dataset.overallFeedback ?? null;
  }

  /**
   * Freezes the judge prompt version a run grades with, the first time the run
   * is graded with that judge prompt. Later calls get the frozen version back
   * even after a newer one is promoted, so every output of the run is graded by
   * the same rubric (phase-5 FAQ Q5). Stored in `grading_snapshot` under
   * `judgePromptVersions`, keyed by judge prompt id, since the SDK names the
   * judge prompt on each judge call rather than when the run starts.
   *
   * @param teamId - Isolation boundary.
   * @param runId - Run UUID; the caller has checked it is this team's local run.
   * @param judgePromptId - The judge prompt the caller named.
   * @param versionId - The version that judge prompt resolves to right now; kept
   *   only if the run has none frozen for it yet.
   * @returns The version the run grades with for this judge prompt.
   */
  async freezeJudgePromptVersion(
    teamId: string,
    runId: string,
    judgePromptId: string,
    versionId: string,
  ): Promise<string> {
    // One statement, so two first calls racing each other still agree: the
    // second one finds the key already set and keeps it.
    const [row] = await prisma.$queryRaw<Array<{ version_id: string }>>`
      UPDATE experiment_runs
      SET grading_snapshot = COALESCE(grading_snapshot, '{}'::jsonb) || jsonb_build_object(
        'judgePromptVersions',
        COALESCE(grading_snapshot->'judgePromptVersions', '{}'::jsonb)
          || jsonb_build_object(${judgePromptId}::text, ${versionId}::text)
      )
      WHERE id = ${runId}::uuid AND team_id = ${teamId}::uuid
        AND (grading_snapshot->'judgePromptVersions'->>${judgePromptId}::text) IS NULL
      RETURNING grading_snapshot->'judgePromptVersions'->>${judgePromptId}::text AS version_id`;
    if (row) return row.version_id;

    const run = await prisma.experimentRun.findFirst({ where: { id: runId, teamId }, select: { gradingSnapshot: true } });
    const frozen = run?.gradingSnapshot as { judgePromptVersions?: Record<string, string> } | null | undefined;
    return frozen?.judgePromptVersions?.[judgePromptId] ?? versionId;
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
