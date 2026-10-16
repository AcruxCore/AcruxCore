import { Prisma } from '@prisma/client';
import { LocalRunsRepository, LocalRunHeader, LocalResultRow } from './local-runs.repository';
import { DatasetsRepository } from '../datasets/datasets.repository';
import { loadEmailConfig } from '../../email/email.config';
import { appLink } from '../../email/email.service';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import type { RunGridCell, RunSnapshotExample } from '../runs/runs.types';
import {
  CreateLocalExperimentDto,
  CreateLocalExperimentResponse,
  DEFAULT_LOCAL_MODEL_LABEL,
  FinishLocalRunDto,
  LOCAL_VARIANT_KIND,
  LocalExperimentConfig,
  StoredLocalScore,
  SubmitLocalResultsDto,
  SubmitLocalResultsResponse,
} from './local-runs.types';

/** The score at or above which a scorer that gave no `passed` counts as a pass. */
const DEFAULT_PASS_THRESHOLD = 50;

/**
 * The local-experiment flow (phase-5 FAQ Q46): the caller's SDK runs its own
 * app and scorers, and this service stores what it sends as an ordinary run —
 * one grid cell of kind `local` — so the run list, the report and Compare per
 * example read it without a code path of their own.
 */
export class LocalRunsService {
  constructor(
    private readonly repo: LocalRunsRepository,
    private readonly datasetsRepo: DatasetsRepository,
  ) {}

  /**
   * Creates a local experiment and its running run, and freezes the dataset's
   * examples into the run. The frozen examples come back in the response, so
   * the SDK runs exactly the set the run will accept results for.
   *
   * @param teamId - Isolation boundary.
   * @param createdBy - The acting user, or null for a team-scoped API key.
   * @param dto - Validated payload: dataset, run name, optional model label,
   *   primary score and metadata.
   * @returns The experiment and run ids, the cell key, the run's dashboard URL
   *   and the frozen examples.
   * @throws {NotFoundError} If the dataset is not this team's.
   * @throws {ValidationError} If the dataset has no examples — a run over
   *   nothing would finish with nothing to show.
   */
  async createLocalExperiment(
    teamId: string,
    createdBy: string | null,
    dto: CreateLocalExperimentDto,
  ): Promise<CreateLocalExperimentResponse> {
    const dataset = await this.datasetsRepo.getDatasetById(teamId, dto.dataset_id);
    if (!dataset) throw new NotFoundError('Dataset not found.');
    if (dataset.examples.length === 0) {
      throw new ValidationError('This dataset has no examples. Add examples before running an experiment on it.');
    }

    const model = dto.model ?? DEFAULT_LOCAL_MODEL_LABEL;
    const cell: RunGridCell = {
      cellKey: `${dto.name}|${model}`,
      variantKind: LOCAL_VARIANT_KIND,
      variantLabel: dto.name,
      model,
      isProductionBaseline: false,
    };
    const snapshot: RunSnapshotExample[] = dataset.examples.map((example) => ({
      exampleId: example.id,
      input: example.input as Record<string, unknown>,
      criteria: example.criteria,
      history: example.history as unknown as RunSnapshotExample['history'],
      expected: example.expected ?? null,
    }));
    const config: LocalExperimentConfig = {
      kind: 'local',
      model,
      ...(dto.primary_score ? { primaryScore: dto.primary_score } : {}),
      ...(dto.metadata ? { metadata: dto.metadata } : {}),
    };

    const { experimentId, runId } = await this.repo.createExperimentWithRun(teamId, createdBy, {
      datasetId: dataset.id,
      name: dto.name,
      config: config as unknown as Prisma.InputJsonValue,
      exampleSnapshot: snapshot as unknown as Prisma.InputJsonValue,
      grid: [cell] as unknown as Prisma.InputJsonValue,
    });

    return {
      experiment_id: experimentId,
      run_id: runId,
      cell_key: cell.cellKey,
      url: runUrl(runId),
      examples: snapshot.map((e) => ({
        id: e.exampleId,
        input: e.input,
        criteria: e.criteria,
        expected: e.expected ?? null,
        // The earlier turns of a session-built example (FAQ Q19), so the caller's
        // app can replay them the way a server-side run does.
        history: e.history ?? null,
      })),
    };
  }

  /**
   * Stores a batch of results the SDK produced. A result for an example that
   * already has one replaces it, so a retried batch never duplicates rows.
   *
   * The run's primary score (named at create time, else each result's first
   * score) is copied into the result's `score`/`passed`/`reason` columns — the
   * fields the report, the run list and the compare view already read.
   *
   * @param teamId - Isolation boundary.
   * @param runId - Run UUID.
   * @param dto - 1 to 100 results.
   * @returns How many results were written, and the run's progress.
   * @throws {NotFoundError} If the run is not this team's.
   * @throws {ConflictError} `RUN_NOT_LOCAL` for a server-side run, `RUN_NOT_RUNNING`
   *   for a run that has already finished.
   * @throws {ValidationError} If an example id is not in the run, or appears twice in
   *   the batch, or a scored result lacks the run's named primary score.
   */
  async submitResults(teamId: string, runId: string, dto: SubmitLocalResultsDto): Promise<SubmitLocalResultsResponse> {
    const { run, cell } = await this.requireRunningLocalRun(teamId, runId);
    const snapshot = run.exampleSnapshot as unknown as RunSnapshotExample[];
    const known = new Set(snapshot.map((e) => e.exampleId));

    const seen = new Set<string>();
    for (const [index, result] of dto.results.entries()) {
      if (!known.has(result.example_id)) {
        throw new ValidationError(`results[${index}].example_id ${result.example_id} is not an example of this run.`);
      }
      if (seen.has(result.example_id)) {
        throw new ValidationError(`results[${index}].example_id ${result.example_id} appears twice in this batch.`);
      }
      seen.add(result.example_id);
    }

    const primaryName = (run.experimentConfig as unknown as LocalExperimentConfig).primaryScore;
    if (primaryName) {
      // A named primary score that a result does not carry would store that result
      // as unscored, and the report, run list and Compare would show the whole run
      // as unscored without any error. Refuse it so the caller sees the mismatch.
      for (const [index, result] of dto.results.entries()) {
        if (result.scores.length > 0 && !result.scores.some((s) => s.name === primaryName)) {
          throw new ValidationError(
            `results[${index}] has no score named "${primaryName}", the run's primary score. ` +
              `Its scores are: ${result.scores.map((s) => s.name).join(', ')}.`,
          );
        }
      }
    }
    const rows: LocalResultRow[] = dto.results.map((result) => {
      const scores: StoredLocalScore[] = result.scores.map((s) => ({
        name: s.name,
        // Whole numbers, like the `score` column the primary score is copied into, so
        // the matrix (that column) and the Scores table (these) show the same mean.
        score: s.score === null ? null : Math.round(s.score),
        passed: s.passed ?? (s.score === null ? null : s.score >= DEFAULT_PASS_THRESHOLD),
        reason: s.reason ?? null,
      }));
      const primary = primaryName ? scores.find((s) => s.name === primaryName) : scores[0];
      return {
        datasetExampleId: result.example_id,
        variantLabel: cell.variantLabel,
        model: cell.model,
        // SQL NULL when the task produced nothing, as the server-side cell writes it.
        // Both SDKs send `output: null` for an errored example, so null counts too.
        output: result.output == null ? Prisma.DbNull : (result.output as Prisma.InputJsonValue),
        traceId: result.trace_id ?? null,
        errorMessage: result.error ?? null,
        score: primary?.score ?? null,
        passed: primary?.passed ?? null,
        reason: primary?.reason ?? null,
        scores: scores as unknown as Prisma.InputJsonValue,
      };
    });

    const completed = await this.repo.replaceResults(teamId, runId, rows);
    return { written: rows.length, completed, total: snapshot.length };
  }

  /**
   * Closes a local run. It ends `failed` when the caller reports an error (the
   * SDK's own loop broke) or when every result errored, the same rule a
   * server-side run's finalize applies; otherwise `succeeded`. No email is
   * sent: the person who started a local run is watching its terminal.
   *
   * @param teamId - Isolation boundary.
   * @param runId - Run UUID.
   * @param dto - Optional error that marks the run failed.
   * @throws {NotFoundError} If the run is not this team's.
   * @throws {ConflictError} `RUN_NOT_LOCAL` for a server-side run, `RUN_NOT_RUNNING`
   *   for a run that has already finished.
   */
  async finishRun(teamId: string, runId: string, dto: FinishLocalRunDto): Promise<void> {
    await this.requireRunningLocalRun(teamId, runId);
    const { total, errored } = await this.repo.countResults(teamId, runId);

    let error: string | null = dto.error ?? null;
    if (!error && total === 0) error = 'The run finished without uploading any results.';
    if (!error && errored === total) error = `Every one of the ${total} examples failed in the task.`;

    const finished = await this.repo.finishRun(teamId, runId, error ? 'failed' : 'succeeded', error);
    if (finished === 0) throw notRunning();
  }

  /** Loads a run and checks it is a local run that is still accepting results. */
  private async requireRunningLocalRun(teamId: string, runId: string): Promise<{ run: LocalRunHeader; cell: RunGridCell }> {
    const run = await this.repo.findRun(teamId, runId);
    if (!run) throw new NotFoundError('Run not found.');
    const cell = (run.grid as unknown as RunGridCell[]).find((c) => c.variantKind === LOCAL_VARIANT_KIND);
    if (!cell) {
      throw new ConflictError(
        'RUN_NOT_LOCAL',
        'This run was started on the server, so its results come from the run engine. Only a local run accepts uploaded results.',
      );
    }
    if (run.status !== 'running') throw notRunning();
    return { run, cell };
  }
}

/** The 409 for a write to a run that has already ended. */
function notRunning(): AppError {
  return new ConflictError(
    'RUN_NOT_RUNNING',
    'This run has already finished, so it no longer accepts results. Start a new run.',
  );
}

/** The run's dashboard page, or null when the server has no `APP_URL` to build it from. */
function runUrl(runId: string): string | null {
  return loadEmailConfig().appUrl ? appLink(`/evaluations/runs/${runId}`) : null;
}
