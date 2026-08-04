import { Prisma } from '@prisma/client';
import { ExperimentsRepository, ExperimentWithRuns } from './experiments.repository';
import {
  CreateExperimentDto,
  CreateExperimentResult,
  ExperimentConfig,
  ExperimentDto,
  MAX_EXPERIMENT_GRID_SIZE,
} from './experiments.types';
import { DatasetsRepository } from '../datasets/datasets.repository';
import { DatasetsService } from '../datasets/datasets.service';
import { NotFoundError, ValidationError } from '../../shared/errors';

/**
 * Business logic for the experiments domain: creating an experiment (a
 * dataset + prompt-version×model grid to sweep), and listing/reading them.
 * Run-starting logic (freezing the example snapshot, resolving the grid,
 * enqueuing cell jobs) is added in a later task — this service only persists
 * the experiment definition.
 */
export class ExperimentsService {
  constructor(
    private readonly repo: ExperimentsRepository,
    private readonly datasetsRepo: DatasetsRepository,
  ) {}

  /**
   * Creates an experiment after validating that the referenced dataset
   * belongs to the caller's team.
   *
   * @param teamId - Isolation boundary.
   * @param createdBy - The caller's user id (nullable for team-scoped API keys); becomes `createdBy`.
   * @param dto - Validated payload: dataset id, optional prompt id/name, and the version/model sweep.
   * @returns The created experiment, plus a non-blocking `promptMismatchWarning`
   *   when `prompt_id` is given and some of the dataset's examples were sourced
   *   from a different prompt (design "Prompt-mismatch warning").
   * @throws {NotFoundError} If the dataset does not exist or belongs to another team.
   * @throws {ValidationError} If `version_ids.length * models.length * datasetExampleCount`
   *   exceeds `MAX_EXPERIMENT_GRID_SIZE` — each cell is a real, paid provider call.
   */
  async create(teamId: string, createdBy: string | null, dto: CreateExperimentDto): Promise<CreateExperimentResult> {
    const dataset = await this.datasetsRepo.getDatasetById(teamId, dto.dataset_id);
    if (!dataset) throw new NotFoundError('Dataset not found.');

    const gridSize = dto.version_ids.length * dto.models.length * dataset._count.examples;
    if (gridSize > MAX_EXPERIMENT_GRID_SIZE) {
      throw new ValidationError(
        `This experiment's grid would enqueue ${gridSize} runs, which exceeds the ${MAX_EXPERIMENT_GRID_SIZE}-run ceiling. Reduce the number of versions, models, or dataset examples.`,
      );
    }

    const promptMismatchWarning = dto.prompt_id
      ? await new DatasetsService(this.datasetsRepo).checkPromptMismatch(dataset.examples, dto.prompt_id, teamId)
      : null;

    const config: ExperimentConfig = {
      versionIds: dto.version_ids,
      models: dto.models,
      ...(dto.alias ? { alias: dto.alias } : {}),
    };
    const created = await this.repo.create(teamId, createdBy, {
      datasetId: dto.dataset_id,
      ...(dto.prompt_id ? { promptId: dto.prompt_id } : {}),
      ...(dto.name ? { name: dto.name } : {}),
      config: config as unknown as Prisma.InputJsonValue,
    });
    return { ...this.toDto(created), ...(promptMismatchWarning ? { promptMismatchWarning } : {}) };
  }

  /**
   * Lists a team's experiments, newest first.
   *
   * @param teamId - Isolation boundary.
   * @returns Array of experiments with their runs.
   */
  async list(teamId: string): Promise<ExperimentDto[]> {
    const rows = await this.repo.list(teamId);
    return rows.map((r) => this.toDto(r));
  }

  /**
   * Gets one experiment with its runs.
   *
   * @param teamId - Isolation boundary.
   * @param id - Experiment UUID.
   * @returns The experiment with its runs.
   * @throws {NotFoundError} If the experiment does not exist or belongs to another team.
   */
  async getById(teamId: string, id: string): Promise<ExperimentDto> {
    const experiment = await this.repo.getById(teamId, id);
    if (!experiment) throw new NotFoundError('Experiment not found.');
    return this.toDto(experiment);
  }

  /** Maps a Prisma experiment row (+ runs) to the API DTO. */
  private toDto(row: ExperimentWithRuns): ExperimentDto {
    return {
      id: row.id,
      teamId: row.teamId,
      datasetId: row.datasetId,
      promptId: row.promptId,
      name: row.name,
      config: row.config as unknown as ExperimentConfig,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      runs: row.runs.map((run) => ({
        id: run.id,
        experimentId: run.experimentId,
        status: run.status,
        startedAt: run.startedAt ? run.startedAt.toISOString() : null,
        endedAt: run.endedAt ? run.endedAt.toISOString() : null,
        error: run.error,
        createdAt: run.createdAt.toISOString(),
      })),
    };
  }
}
