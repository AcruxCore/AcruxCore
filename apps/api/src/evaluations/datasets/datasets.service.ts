import { Prisma } from '@prisma/client';
import { DatasetsRepository } from './datasets.repository';
import {
  AddExampleDto,
  BuildFromFeedbackDto,
  CreateDatasetDto,
  DatasetDto,
  DatasetExampleDto,
  MAX_EXAMPLE_INPUT_BYTES,
  UpdateDatasetDto,
} from './datasets.types';
import { NotFoundError, UnprocessableError } from '../../shared/errors';

/** One skipped feedback row and why it was not turned into an example. */
export interface SkippedFeedback {
  feedbackId: string;
  reason: string;
}

/** Result of `buildFromFeedback`: the created dataset plus a skip report. */
export interface BuildFromFeedbackResult {
  dataset: DatasetDto;
  exampleCount: number;
  skipped: SkippedFeedback[];
}

type DatasetWithCount = Prisma.DatasetGetPayload<{ include: { _count: { select: { examples: true } } } }>;

/**
 * Business logic for the datasets domain: building datasets from feedback rows
 * and the plain CRUD surface over datasets and their examples. All methods are
 * team-scoped — the service (not the thin repository) is what guarantees a
 * caller can never read or mutate another team's data.
 */
export class DatasetsService {
  constructor(private readonly repo: DatasetsRepository) {}

  /**
   * Builds a new dataset from a set of trace feedback rows: one example per
   * eligible feedback row, `input` = the source span's captured prompt
   * variables, `criteria` = the feedback comment.
   *
   * Algorithm:
   * 1. Load the requested feedback rows scoped to the team; any id absent from
   *    the result is skipped with reason "feedback not found".
   * 2. For each found row, resolve its source span's payload. If there is no
   *    qualifying span or its captured variables are null (payload capture was
   *    off), skip with reason "no captured variables (payload capture was off)".
   * 3. If the captured variables serialize to more than `MAX_EXAMPLE_INPUT_BYTES`,
   *    skip with reason "input exceeds N bytes" — same size cap `addExample`
   *    enforces via Zod, applied here too since this bulk path builds `input`
   *    server-side from a production trace payload rather than accepting it
   *    from the caller, so no schema `.refine()` ever runs over it. This is a
   *    bulk operation over many, independently-sourced feedback rows, and the
   *    function already tolerates other kinds of per-row ineligibility
   *    ("feedback not found", "no captured variables") by skipping just that
   *    row and still building the rest of the batch — an oversized payload is
   *    treated the same way for consistency, rather than failing the whole
   *    batch or silently truncating someone else's data.
   * 4. Build one eligible example per remaining row.
   * 5. If zero examples are eligible, throw `UnprocessableError` (422) — there
   *    is nothing useful to build.
   * 6. Otherwise create the dataset and its examples atomically.
   *
   * @param teamId - Isolation boundary.
   * @param userId - The caller's user id (nullable for team-scoped API keys); becomes `createdBy`.
   * @param dto - Validated payload: dataset name, optional overall_feedback, and the feedback ids to draw from.
   * @returns The created dataset, the count of examples built, and the skip report.
   * @throws {UnprocessableError} If zero of the requested feedback ids yielded an eligible example.
   */
  async buildFromFeedback(
    teamId: string,
    userId: string | null,
    dto: BuildFromFeedbackDto,
  ): Promise<BuildFromFeedbackResult> {
    const found = await this.repo.findFeedbackByIds(teamId, dto.feedback_ids);
    const foundById = new Map(found.map((fb) => [fb.id, fb]));

    const skipped: SkippedFeedback[] = [];
    const examples: Array<{
      input: Prisma.InputJsonValue;
      criteria?: string;
      sourceTraceId?: string;
      sourceFeedbackId?: string;
      sourcePromptVersionId?: string;
    }> = [];

    // Dedupe: a repeated feedback id in the request must not produce two
    // identical examples from the same feedback row.
    for (const feedbackId of new Set(dto.feedback_ids)) {
      const fb = foundById.get(feedbackId);
      if (!fb) {
        skipped.push({ feedbackId, reason: 'feedback not found' });
        continue;
      }

      const sourcePayload = await this.repo.findSourceSpanPayload(teamId, {
        traceId: fb.traceId,
        spanId: fb.spanId,
      });
      if (!sourcePayload || sourcePayload.variables == null) {
        skipped.push({ feedbackId, reason: 'no captured variables (payload capture was off)' });
        continue;
      }

      // Finding #24 also applies to this bulk-import path: the captured
      // variables came straight off a production trace payload, never through
      // AddExampleSchema's `.refine()`, so the same size ceiling has to be
      // re-checked by hand here before the value is persisted.
      const inputBytes = Buffer.byteLength(JSON.stringify(sourcePayload.variables), 'utf8');
      if (inputBytes > MAX_EXAMPLE_INPUT_BYTES) {
        skipped.push({ feedbackId, reason: `input exceeds ${MAX_EXAMPLE_INPUT_BYTES} bytes (${inputBytes} bytes)` });
        continue;
      }

      examples.push({
        input: sourcePayload.variables as Prisma.InputJsonValue,
        ...(fb.comment ? { criteria: fb.comment } : {}),
        sourceTraceId: fb.traceId,
        sourceFeedbackId: fb.id,
        ...(sourcePayload.promptVersionId ? { sourcePromptVersionId: sourcePayload.promptVersionId } : {}),
      });
    }

    if (examples.length === 0) {
      throw new UnprocessableError('No eligible feedback rows — enable payload capture and collect new traffic');
    }

    const { dataset, examplesCreated } = await this.repo.createDatasetWithExamples(
      teamId,
      userId,
      { name: dto.name, ...(dto.overall_feedback ? { overallFeedback: dto.overall_feedback } : {}) },
      examples,
    );

    return { dataset: this.toDto(dataset), exampleCount: examplesCreated, skipped };
  }

  /**
   * Creates an empty dataset.
   *
   * @param teamId - Isolation boundary.
   * @param userId - The caller's user id (nullable for team-scoped API keys); becomes `createdBy`.
   * @param dto - Validated payload: name and optional overall_feedback.
   * @returns The created dataset.
   */
  async createDataset(teamId: string, userId: string | null, dto: CreateDatasetDto): Promise<DatasetDto> {
    const dataset = await this.repo.createDataset(teamId, userId, {
      name: dto.name,
      ...(dto.overall_feedback ? { overallFeedback: dto.overall_feedback } : {}),
    });
    return this.toDto(dataset);
  }

  /**
   * Lists a team's non-deleted datasets, newest first.
   *
   * @param teamId - Isolation boundary.
   * @returns Array of datasets with example counts.
   */
  async listDatasets(teamId: string): Promise<DatasetDto[]> {
    const rows = await this.repo.listDatasets(teamId);
    return rows.map((r) => this.toDto(r));
  }

  /**
   * Gets one dataset (with its examples).
   *
   * @param teamId - Isolation boundary.
   * @param id - Dataset UUID.
   * @returns The dataset and its examples.
   * @throws {NotFoundError} If the dataset does not exist or belongs to another team.
   */
  async getDataset(teamId: string, id: string): Promise<DatasetDto & { examples: DatasetExampleDto[] }> {
    const dataset = await this.repo.getDatasetById(teamId, id);
    if (!dataset) throw new NotFoundError('Dataset not found.');
    return { ...this.toDto(dataset), examples: dataset.examples.map((e) => this.exampleToDto(e)) };
  }

  /**
   * Updates a dataset's name and/or overall_feedback.
   *
   * @param teamId - Isolation boundary.
   * @param id - Dataset UUID.
   * @param dto - Validated partial update.
   * @returns The updated dataset.
   * @throws {NotFoundError} If the dataset does not exist or belongs to another team.
   */
  async updateDataset(teamId: string, id: string, dto: UpdateDatasetDto): Promise<DatasetDto> {
    const updated = await this.repo.updateDataset(teamId, id, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.overall_feedback !== undefined ? { overallFeedback: dto.overall_feedback } : {}),
    });
    if (!updated) throw new NotFoundError('Dataset not found.');
    return this.toDto(updated);
  }

  /**
   * Soft-deletes a dataset.
   *
   * @param teamId - Isolation boundary.
   * @param id - Dataset UUID.
   * @throws {NotFoundError} If the dataset does not exist, already deleted, or belongs to another team.
   */
  async deleteDataset(teamId: string, id: string): Promise<void> {
    // Team-scoped existence check first — the repository's soft-delete alone
    // cannot distinguish "not found" from "already deleted" from "cross-team".
    const existing = await this.repo.getDatasetById(teamId, id);
    if (!existing) throw new NotFoundError('Dataset not found.');
    await this.repo.softDeleteDataset(teamId, id);
  }

  /**
   * Adds one example to a dataset.
   *
   * @param teamId - Isolation boundary.
   * @param datasetId - Dataset UUID.
   * @param dto - Validated payload: input (variables) and optional criteria.
   * @returns The created example.
   * @throws {NotFoundError} If the dataset does not exist or belongs to another team.
   */
  async addExample(teamId: string, datasetId: string, dto: AddExampleDto): Promise<DatasetExampleDto> {
    // Team-scoped lookup first: createExample takes a bare datasetId and does
    // not itself verify team ownership (thin-repository pattern) — the service
    // is what makes cross-team writes impossible.
    const dataset = await this.repo.getDatasetById(teamId, datasetId);
    if (!dataset) throw new NotFoundError('Dataset not found.');

    const example = await this.repo.createExample(teamId, datasetId, {
      input: dto.input as Prisma.InputJsonValue,
      ...(dto.criteria ? { criteria: dto.criteria } : {}),
    });
    return this.exampleToDto(example);
  }

  /**
   * Removes one example from a dataset.
   *
   * @param teamId - Isolation boundary.
   * @param datasetId - Dataset UUID.
   * @param exampleId - Example UUID.
   * @throws {NotFoundError} If the dataset or the example is not found in this team.
   */
  async removeExample(teamId: string, datasetId: string, exampleId: string): Promise<void> {
    const dataset = await this.repo.getDatasetById(teamId, datasetId);
    if (!dataset) throw new NotFoundError('Dataset not found.');

    const deleted = await this.repo.deleteExample(teamId, datasetId, exampleId);
    if (deleted === 0) throw new NotFoundError('Example not found.');
  }

  /** Maps a Prisma dataset row (+ example count) to the API DTO. */
  private toDto(row: DatasetWithCount): DatasetDto {
    return {
      id: row.id,
      teamId: row.teamId,
      name: row.name,
      overallFeedback: row.overallFeedback,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      exampleCount: row._count.examples,
    };
  }

  /** Maps a Prisma dataset_example row to the API DTO. */
  private exampleToDto(row: Prisma.DatasetExampleGetPayload<{}>): DatasetExampleDto {
    return {
      id: row.id,
      datasetId: row.datasetId,
      input: row.input as Record<string, unknown>,
      criteria: row.criteria,
      sourceTraceId: row.sourceTraceId,
      sourceFeedbackId: row.sourceFeedbackId,
      sourcePromptVersionId: row.sourcePromptVersionId,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
