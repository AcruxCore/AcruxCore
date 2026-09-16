import { Prisma } from '@prisma/client';
import { DatasetsRepository } from './datasets.repository';
import {
  AddExampleDto,
  AddExamplesFromFeedbackDto,
  BuildFromFeedbackDto,
  CreateDatasetDto,
  DatasetDto,
  DatasetExampleDto,
  MAX_EXAMPLE_INPUT_BYTES,
  MAX_FEEDBACK_IDS_PER_BUILD,
  MAX_HISTORY_BYTES,
  MAX_HISTORY_TRACES,
  MismatchedPromptInfo,
  PromptMismatchWarning,
  SourcePromptInfo,
  UpdateDatasetDto,
  UpdateExampleDto,
} from './datasets.types';
import { buildTraceExchange, capHistoryBytes } from './history.builder';
import { NotFoundError, UnprocessableError } from '../../shared/errors';
import { audit } from '../../shared/audit';
import prisma from '../../shared/db/client';
import { FeedbackRepository, toFeedbackFilters } from '../../traces/feedback';
import type { FeedbackFilterQuery } from '../../traces/feedback';
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
/**
 * One example ready to insert, built from a feedback row. Matches the insert
 * shape both `createDatasetWithExamples` and `appendExamples` take.
 */
interface FeedbackExampleInput {
  input: Prisma.InputJsonValue;
  criteria?: string;
  history?: Prisma.InputJsonValue;
  sourceTraceId?: string;
  sourceFeedbackId?: string;
  sourcePromptVersionId?: string;
}

/**
 * Why a feedback row could not become an example, in the reader's terms.
 *
 * These used to be one string blaming payload capture, which was the wrong
 * cause for two of the three (phase-5-faq Q31). They are now short noun phrases
 * naming what is missing, and none of them names a setting: a reason a person
 * reads in a red box has to fit on one line and say the thing, and pointing at
 * the capture setting sent people to fix something that was already correct.
 *
 * Each reads correctly on its own and after "all N were skipped because …".
 */
const SOURCE_PAYLOAD_SKIP_REASONS: Record<'no-prompt-span' | 'no-payload' | 'no-variables', string> = {
  'no-prompt-span': 'the prompt is not stored in AcruxCore',
  'no-payload': 'nothing was captured for this run',
  'no-variables': 'no prompt variables were captured',
};

export interface SkippedFeedback {
  feedbackId: string;
  reason: string;
}

/**
 * Turns a skip report into the sentence a 422 should carry.
 *
 * The old message named one cause — "enable payload capture" — for three
 * different failures, and was wrong for the two most common ones. Someone whose
 * agent keeps its prompt in code would turn capture on, wait for new traffic,
 * and hit exactly the same wall, because capture was never the problem.
 *
 * @param skipped - Every row that did not become an example, with its reason.
 * @returns A message naming the real cause, or each cause with its count when
 *   the rows failed for more than one.
 */
function describeNoEligibleRows(skipped: SkippedFeedback[]): string {
  if (skipped.length === 0) {
    return 'No feedback rows matched — there is nothing to build a dataset from.';
  }

  const counts = new Map<string, number>();
  for (const row of skipped) counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1);

  if (counts.size === 1) {
    const [[reason, count]] = [...counts.entries()];
    return count === 1
      ? `No eligible feedback rows — ${reason}.`
      : `No eligible feedback rows — all ${count} were skipped because ${reason}.`;
  }

  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${count} because ${reason}`);
  return `No eligible feedback rows — ${parts.join('; ')}.`;
}

/** Result of appending feedback rows to an existing dataset. */
export interface AddExamplesFromFeedbackResult {
  /** How many examples this call actually created. */
  added: number;
  /** The dataset's total example count afterwards. */
  exampleCount: number;
  /** Per-id report of everything that did not become an example. */
  skipped: SkippedFeedback[];
  /**
   * How many feedback rows the criteria matched in total, present only for a
   * `filter` request. Above {@link MAX_FEEDBACK_IDS_PER_BUILD} the request
   * processes the newest that many, and this is what makes that visible instead
   * of silently dropping the rest.
   */
  matched?: number;
}

/** Result of `buildFromFeedback`: the created dataset plus a skip report. */
export interface BuildFromFeedbackResult {
  dataset: DatasetDto;
  exampleCount: number;
  skipped: SkippedFeedback[];
  /** How many rows the criteria matched; `filter` requests only. See
   * {@link AddExamplesFromFeedbackResult.matched}. */
  matched?: number;
}

type DatasetWithCount = Prisma.DatasetGetPayload<{ include: { _count: { select: { examples: true } } } }>;

/**
 * Business logic for the datasets domain: building datasets from feedback rows
 * and the plain CRUD surface over datasets and their examples. All methods are
 * team-scoped — the service (not the thin repository) is what guarantees a
 * caller can never read or mutate another team's data.
 */
export class DatasetsService {
  /**
   * Selecting feedback by criteria is the feedback domain's own filter language,
   * so this reads through that repository rather than restating its SQL here —
   * the same way the trace query service reuses it.
   */
  private readonly feedbackRepo = new FeedbackRepository();

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
   *    off), skip with the reason that actually applies — see
   *    {@link SOURCE_PAYLOAD_SKIP_REASONS}.
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
    const { ids, matched } = await this.resolveFeedbackIds(teamId, dto);
    const { examples, skipped } = await this.collectExamplesFromFeedback(teamId, ids);

    if (examples.length === 0) {
      throw new UnprocessableError(describeNoEligibleRows(skipped));
    }

    const { dataset, examplesCreated } = await this.repo.createDatasetWithExamples(
      teamId,
      userId,
      { name: dto.name, ...(dto.overall_feedback ? { overallFeedback: dto.overall_feedback } : {}) },
      examples,
    );

    await this.auditDataset(teamId, userId, 'dataset_created', dataset.id, dataset.name);

    return {
      dataset: this.toDto(dataset),
      exampleCount: examplesCreated,
      skipped,
      ...(matched !== undefined ? { matched } : {}),
    };
  }

  /**
   * Writes one dataset row to the audit trail.
   *
   * Awaited rather than fired and forgotten, unlike `secrets`: the trail is the
   * only record of who destroyed a dataset, and `audit()` never throws, so
   * waiting for it costs one insert and cannot fail the caller's write.
   *
   * `userId` is nullable on every caller because `createdBy` accepts a
   * team-scoped API key, but `actor_id` is a non-null column. Every route that
   * reaches here is gated at `editor` or above, which a team-scoped key cannot
   * satisfy, so the null branch is unreachable today — it is here so that
   * opening a route later fails loudly in review rather than at the FK.
   *
   * @param teamId - Team the dataset belongs to.
   * @param userId - Acting user, or null for a team-scoped key.
   * @param event - `dataset_created` or `dataset_deleted`.
   * @param datasetId - The dataset the row refers to.
   * @param name - The dataset's name at the time of the action.
   */
  private async auditDataset(
    teamId: string,
    userId: string | null,
    event: 'dataset_created' | 'dataset_deleted',
    datasetId: string,
    name: string,
  ): Promise<void> {
    if (userId === null) return;
    await audit(prisma, { teamId, actorId: userId, event, metadata: { datasetId, name } });
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
    await this.auditDataset(teamId, userId, 'dataset_created', dataset.id, dataset.name);
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
    const sourcePrompts = await this.resolveSourcePrompts(teamId, dataset.examples);
    return {
      ...this.toDto(dataset),
      examples: dataset.examples.map((e) => this.exampleToDto(e, sourcePrompts)),
    };
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
  async deleteDataset(teamId: string, id: string, userId: string | null): Promise<void> {
    // Team-scoped existence check first — the repository's soft-delete alone
    // cannot distinguish "not found" from "already deleted" from "cross-team".
    const existing = await this.repo.getDatasetById(teamId, id);
    if (!existing) throw new NotFoundError('Dataset not found.');
    await this.repo.softDeleteDataset(teamId, id);
    // The name is recorded here and not on read: after the soft-delete the row is
    // filtered out of every list, so the trail is the only place left that says
    // which dataset the id refers to.
    await this.auditDataset(teamId, userId, 'dataset_deleted', id, existing.name);
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
   * Resolves a from-feedback request's selector into the feedback ids to build
   * from.
   *
   * An explicit `feedback_ids` list is used as sent. A `filter` is resolved
   * against the same vocabulary the trace list and feedback feed speak, newest
   * first, capped at {@link MAX_FEEDBACK_IDS_PER_BUILD} — the build runs
   * synchronously and each row costs several reads, so the cap is what keeps a
   * broad filter from holding a request open indefinitely.
   *
   * @param teamId - Isolation boundary.
   * @param selector - The validated body; exactly one of the two fields is set.
   * @returns The ids to build from, and (filter mode only) how many rows the
   *   criteria matched in total.
   */
  private async resolveFeedbackIds(
    teamId: string,
    selector: { feedback_ids?: string[]; filter?: FeedbackFilterQuery },
  ): Promise<{ ids: string[]; matched?: number }> {
    if (selector.feedback_ids) return { ids: selector.feedback_ids };

    const { ids, total } = await this.feedbackRepo.listIdsForTeam(
      teamId,
      toFeedbackFilters(selector.filter!),
      MAX_FEEDBACK_IDS_PER_BUILD,
    );
    return { ids, matched: total };
  }

  /**
   * Turns feedback ids into dataset examples, reporting per-id why any of them
   * could not become one.
   *
   * Shared by the build-a-new-dataset path and the append-to-an-existing-dataset
   * path so the two can never disagree about what an example built from feedback
   * looks like — the captured variables as `input`, the feedback comment as the
   * per-example rubric, and the reconstructed session history frozen in place
   * (FAQ Q19).
   *
   * Never throws on an individual row: an id that is missing, has no captured
   * payload, or is oversized lands in `skipped` and the rest still build. The
   * caller decides what an empty result means.
   *
   * @param teamId - Isolation boundary; a feedback id from another team simply
   *   does not resolve and is reported as "feedback not found".
   * @param feedbackIds - Candidate feedback ids. Duplicates are collapsed, so
   *   the same id twice yields one example.
   * @returns The examples to insert, and the skip report.
   */
  private async collectExamplesFromFeedback(
    teamId: string,
    feedbackIds: string[],
  ): Promise<{ examples: FeedbackExampleInput[]; skipped: SkippedFeedback[] }> {
    const found = await this.repo.findFeedbackByIds(teamId, feedbackIds);
    const foundById = new Map(found.map((fb) => [fb.id, fb]));

    const skipped: SkippedFeedback[] = [];
    const historyCache = newHistoryCache();
    const examples: FeedbackExampleInput[] = [];

    // Dedupe: a repeated feedback id in the request must not produce two
    // identical examples from the same feedback row.
    for (const feedbackId of new Set(feedbackIds)) {
      const fb = foundById.get(feedbackId);
      if (!fb) {
        skipped.push({ feedbackId, reason: 'feedback not found' });
        continue;
      }

      const sourcePayload = await this.repo.findSourceSpanPayload(teamId, {
        traceId: fb.traceId,
        spanId: fb.spanId,
      });
      if (!sourcePayload.ok) {
        skipped.push({ feedbackId, reason: SOURCE_PAYLOAD_SKIP_REASONS[sourcePayload.reason] });
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

    return { examples, skipped };
  }

  /**
   * Appends feedback rows to a dataset that already exists.
   *
   * The counterpart to {@link buildFromFeedback}: same example construction,
   * different destination. This is the path a person takes on their second and
   * every later pass over the feedback list, so re-selecting a row they already
   * filed must not duplicate it — an id whose example is already in this dataset
   * is reported as skipped rather than inserted again.
   *
   * Unlike `buildFromFeedback` this does **not** throw when nothing is eligible.
   * There is no half-created dataset to avoid here, and "you selected three rows
   * and all three were already in the dataset" is a normal outcome, not an error.
   * A caller distinguishes the two by `added`.
   *
   * @param teamId - Isolation boundary.
   * @param datasetId - Dataset UUID to append to.
   * @param dto - Validated payload: the feedback ids to draw from.
   * @returns How many were added, the dataset's new total, and the skip report.
   * @throws {NotFoundError} If the dataset does not exist or belongs to another team.
   */
  async addExamplesFromFeedback(
    teamId: string,
    datasetId: string,
    dto: AddExamplesFromFeedbackDto,
  ): Promise<AddExamplesFromFeedbackResult> {
    const dataset = await this.repo.getDatasetById(teamId, datasetId);
    if (!dataset) throw new NotFoundError('Dataset not found.');

    const { ids, matched } = await this.resolveFeedbackIds(teamId, dto);
    const { examples, skipped } = await this.collectExamplesFromFeedback(teamId, ids);

    const alreadyPresent = await this.repo.findFeedbackIdsAlreadyInDataset(datasetId, ids);
    const fresh = examples.filter((example) => {
      if (example.sourceFeedbackId && alreadyPresent.has(example.sourceFeedbackId)) {
        skipped.push({ feedbackId: example.sourceFeedbackId, reason: 'already in this dataset' });
        return false;
      }
      return true;
    });

    const { added, insertedFeedbackIds, exampleCount } = await this.repo.appendExamples(
      teamId,
      datasetId,
      fresh,
    );

    // A row that passed the check above but did not land was inserted by a
    // concurrent append between the two — the unique index dropped ours. Report
    // it the same way as one that was already there, because for the caller it
    // now is: the feedback has an example in this dataset, just not theirs.
    for (const example of fresh) {
      if (example.sourceFeedbackId && !insertedFeedbackIds.has(example.sourceFeedbackId)) {
        skipped.push({ feedbackId: example.sourceFeedbackId, reason: 'already in this dataset' });
      }
    }

    return { added, exampleCount, skipped, ...(matched !== undefined ? { matched } : {}) };
  }

  /**
   * Edits one example's criteria in place.
   *
   * Criteria is the per-example rubric the judge grades against, and a row built
   * from feedback inherits the raw feedback comment — which is a complaint, not a
   * rubric, and grades correct answers badly when reused verbatim (phase-5-faq
   * Q17). Rewording it is therefore ordinary curation, not an edge case.
   *
   * Only criteria is editable: `input` and `history` are the frozen record of
   * what actually ran, and rewriting them would silently invalidate every past
   * run that graded against them.
   *
   * @param teamId - Isolation boundary.
   * @param datasetId - Dataset UUID the example must belong to.
   * @param exampleId - Example UUID.
   * @param dto - Validated partial update; `criteria: null` clears the rubric.
   * @returns The updated example.
   * @throws {NotFoundError} If the dataset, or the example within it, is not in this team.
   */
  async updateExample(
    teamId: string,
    datasetId: string,
    exampleId: string,
    dto: UpdateExampleDto,
  ): Promise<DatasetExampleDto> {
    const dataset = await this.repo.getDatasetById(teamId, datasetId);
    if (!dataset) throw new NotFoundError('Dataset not found.');

    const updated = await this.repo.updateExample(teamId, datasetId, exampleId, {
      ...(dto.criteria !== undefined ? { criteria: dto.criteria } : {}),
    });
    if (!updated) throw new NotFoundError('Example not found.');

    const sourcePrompts = await this.resolveSourcePrompts(teamId, [updated]);
    return this.exampleToDto(updated, sourcePrompts);
  }

  /**
   * Resolves the examples' `sourcePromptVersionId`s to readable prompt names and
   * version numbers, in one query for the whole page rather than one per row.
   *
   * @param teamId - Isolation boundary, so a version belonging to another team
   *   can never surface its prompt's name here.
   * @param examples - The rows about to be serialised.
   * @returns Version id to {@link SourcePromptInfo}. A version deleted since the
   *   example was captured is simply absent, and the row renders without lineage.
   */
  private async resolveSourcePrompts(
    teamId: string,
    examples: Array<{ sourcePromptVersionId: string | null }>,
  ): Promise<Map<string, SourcePromptInfo>> {
    const versionIds = [
      ...new Set(
        examples.map((e) => e.sourcePromptVersionId).filter((id): id is string => id !== null),
      ),
    ];
    const resolved = await this.repo.resolveVersionPrompts(versionIds, teamId);
    return new Map(
      [...resolved].map(([versionId, info]) => [
        versionId,
        {
          promptId: info.promptId,
          name: info.promptName,
          versionNumber: info.versionNumber,
          lastUserMessage: info.lastUserMessage,
        },
      ]),
    );
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
  private exampleToDto(
    row: Prisma.DatasetExampleGetPayload<{}>,
    sourcePrompts?: Map<string, SourcePromptInfo>,
  ): DatasetExampleDto {
    return {
      id: row.id,
      datasetId: row.datasetId,
      input: row.input as Record<string, unknown>,
      criteria: row.criteria,
      history: row.history as unknown as ChatMessage[] | null,
      sourceTraceId: row.sourceTraceId,
      sourceFeedbackId: row.sourceFeedbackId,
      sourcePromptVersionId: row.sourcePromptVersionId,
      sourcePrompt:
        (row.sourcePromptVersionId ? sourcePrompts?.get(row.sourcePromptVersionId) : undefined) ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
