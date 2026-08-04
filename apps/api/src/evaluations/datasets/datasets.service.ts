import { Prisma } from '@prisma/client';
import { DatasetsRepository } from './datasets.repository';
import {
  AddExampleDto,
  BuildFromFeedbackDto,
  CreateDatasetDto,
  DatasetDto,
  DatasetExampleDto,
  MAX_EXAMPLE_INPUT_BYTES,
  MAX_HISTORY_BYTES,
  MAX_HISTORY_TRACES,
  MismatchedPromptInfo,
  PromptMismatchWarning,
  UpdateDatasetDto,
} from './datasets.types';
import { buildTraceExchange, capHistoryBytes } from './history.builder';
import { NotFoundError, UnprocessableError } from '../../shared/errors';
import type { ChatMessage } from '../../gateway/providers/types';

/**
 * Per-request memo for session-history reconstruction. `buildFromFeedback`
 * runs over many feedback rows and several of them typically sit in the SAME
 * session — without this, each row re-reads the same prior traces and the same
 * span payloads, turning one request into hundreds of sequential round trips.
 * Scoped to a single call, so it can never serve stale data across requests.
 */
interface HistoryCache {
  /** traceId → its `{ sessionId, startedAt }`, or null when absent for the team. */
  traces: Map<string, { sessionId: string | null; startedAt: Date } | null>;
  /** `sessionId|beforeStartedAt` → the prior traces of that session. */
  priorTraces: Map<string, Array<{ id: string; startedAt: Date }>>;
  /** traceId → the exchange reconstructed from that trace's own llm spans. */
  exchanges: Map<string, ChatMessage[]>;
}

/** Fresh, empty {@link HistoryCache} for one `buildFromFeedback` call. */
function newHistoryCache(): HistoryCache {
  return { traces: new Map(), priorTraces: new Map(), exchanges: new Map() };
}

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
   * Reconstructs the conversation history leading up to a feedback trace,
   * when that trace belongs to a session (FAQ Q19). Walks the session
   * backward (`listPriorSessionTraces`, capped at `MAX_HISTORY_TRACES`),
   * reconstructs each prior trace's own exchange (`buildTraceExchange`),
   * concatenates them oldest first, and caps the serialized size
   * (`capHistoryBytes`). Frozen once here — never re-derived live.
   *
   * Every read is memoized in `cache` for the duration of the request, since
   * feedback rows from one conversation share the same prior traces.
   *
   * Best-effort by design: history is extra context on an example, never the
   * example itself, so a reconstruction that fails (an `llm` span whose
   * captured payload is shaped in a way nothing here anticipated, a read that
   * errors) logs and yields null rather than failing the dataset build the
   * caller actually asked for.
   *
   * @param teamId - Isolation boundary.
   * @param traceId - The feedback's trace id.
   * @param cache - Per-request memo, from {@link newHistoryCache}.
   * @returns The reconstructed history, or null if the trace has no session,
   *   no prior trace yielded a usable exchange, or reconstruction failed.
   */
  private async buildHistoryForTrace(
    teamId: string,
    traceId: string,
    cache: HistoryCache,
  ): Promise<ChatMessage[] | null> {
    try {
      if (!cache.traces.has(traceId)) {
        cache.traces.set(traceId, await this.repo.getTraceById(teamId, traceId));
      }
      const trace = cache.traces.get(traceId)!;
      if (!trace || !trace.sessionId) return null;

      const priorKey = `${trace.sessionId}|${trace.startedAt.toISOString()}`;
      if (!cache.priorTraces.has(priorKey)) {
        cache.priorTraces.set(
          priorKey,
          await this.repo.listPriorSessionTraces(teamId, trace.sessionId, trace.startedAt, MAX_HISTORY_TRACES),
        );
      }
      const priorTraces = cache.priorTraces.get(priorKey)!;
      if (priorTraces.length === 0) return null;

      const exchanges: ChatMessage[] = [];
      for (const prior of priorTraces) {
        if (!cache.exchanges.has(prior.id)) {
          const spans = await this.repo.listLlmSpansForTrace(teamId, prior.id);
          cache.exchanges.set(prior.id, buildTraceExchange(spans));
        }
        exchanges.push(...cache.exchanges.get(prior.id)!);
      }
      if (exchanges.length === 0) return null;

      const capped = capHistoryBytes(exchanges, MAX_HISTORY_BYTES);
      return capped.length > 0 ? capped : null;
    } catch (err) {
      console.error('[datasets] session-history reconstruction failed', { traceId, err });
      return null;
    }
  }

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
    const historyCache = newHistoryCache();
    const examples: Array<{
      input: Prisma.InputJsonValue;
      criteria?: string;
      history?: Prisma.InputJsonValue;
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

      // Session-scoped history (FAQ Q19): automatic whenever the feedback's
      // trace belongs to a session — never re-derived later, frozen here.
      const history = await this.buildHistoryForTrace(teamId, fb.traceId, historyCache);

      examples.push({
        input: sourcePayload.variables as Prisma.InputJsonValue,
        ...(fb.comment ? { criteria: fb.comment } : {}),
        ...(history ? { history: history as unknown as Prisma.InputJsonValue } : {}),
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
      ...(dto.history ? { history: dto.history as unknown as Prisma.InputJsonValue } : {}),
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

  /**
   * Checks whether any of a dataset's examples were sourced from a prompt
   * other than the one a run is about to target (design
   * "Prompt-mismatch warning"). Informational only — never throws, never
   * blocks; the caller always starts the run regardless of the result.
   *
   * @param examples - The dataset's examples (only `sourcePromptVersionId` is read).
   * @param targetPromptId - The prompt the run is about to target.
   * @param teamId - Isolation boundary, threaded into `resolveVersionPrompts`
   *   so a version belonging to another team can never surface its prompt's
   *   name in this (informational, unauthenticated-by-role) response.
   * @returns The warning (grouped by the OTHER prompt, with a per-prompt
   *   example count), or null if every example either matches the target
   *   prompt or carries no resolvable lineage (manually added, or its source
   *   version was since deleted).
   */
  async checkPromptMismatch(
    examples: Array<{ sourcePromptVersionId: string | null }>,
    targetPromptId: string,
    teamId: string,
  ): Promise<PromptMismatchWarning | null> {
    const versionIds = [
      ...new Set(
        examples.map((e) => e.sourcePromptVersionId).filter((id): id is string => id !== null),
      ),
    ];
    if (versionIds.length === 0) return null;

    const versionPrompts = await this.repo.resolveVersionPrompts(versionIds, teamId);
    const counts = new Map<string, MismatchedPromptInfo>();
    for (const example of examples) {
      if (!example.sourcePromptVersionId) continue;
      const info = versionPrompts.get(example.sourcePromptVersionId);
      if (!info || info.promptId === targetPromptId) continue;
      const existing = counts.get(info.promptId);
      if (existing) existing.exampleCount += 1;
      else counts.set(info.promptId, { promptId: info.promptId, name: info.promptName, exampleCount: 1 });
    }
    return counts.size > 0 ? { mismatchedPrompts: [...counts.values()] } : null;
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
      history: row.history as unknown as ChatMessage[] | null,
      sourceTraceId: row.sourceTraceId,
      sourceFeedbackId: row.sourceFeedbackId,
      sourcePromptVersionId: row.sourcePromptVersionId,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
