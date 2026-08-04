import { Prisma } from '@prisma/client';
import prisma from '../../shared/db/client';

/**
 * Data access for the `datasets` and `dataset_examples` tables. The only file
 * in this domain that touches Prisma. All queries are team-scoped for isolation.
 */
export class DatasetsRepository {
  /**
   * Creates an empty dataset for a team.
   *
   * @param teamId - Isolation boundary.
   * @param createdBy - User ID (nullable for team-scoped API key creation).
   * @param data - Dataset fields: name and optional overallFeedback.
   * @returns The created dataset row.
   */
  async createDataset(
    teamId: string,
    createdBy: string | null,
    data: { name: string; overallFeedback?: string },
  ): Promise<Prisma.DatasetGetPayload<{ include: { _count: { select: { examples: true } } } }>> {
    return prisma.dataset.create({
      data: {
        teamId,
        name: data.name,
        overallFeedback: data.overallFeedback ?? null,
        createdBy,
      },
      include: {
        _count: {
          select: {
            examples: true,
          },
        },
      },
    });
  }

  /**
   * Lists a team's non-deleted datasets, newest first, with example counts.
   *
   * @param teamId - Isolation boundary.
   * @returns Array of datasets with example counts.
   */
  async listDatasets(
    teamId: string,
  ): Promise<
    Array<Prisma.DatasetGetPayload<{ include: { _count: { select: { examples: true } } } }>>
  > {
    return prisma.dataset.findMany({
      where: { teamId, deletedAt: null },
      include: {
        _count: {
          select: {
            examples: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Gets one non-deleted dataset with its examples, or null if missing or deleted.
   *
   * @param teamId - Isolation boundary.
   * @param id - Dataset UUID.
   * @returns The dataset with examples, or null if not found or in another team.
   */
  async getDatasetById(
    teamId: string,
    id: string,
  ): Promise<
    (Prisma.DatasetGetPayload<{ include: { examples: true } }> & {
      _count: { examples: number };
    }) | null
  > {
    return prisma.dataset.findFirst({
      where: { id, teamId, deletedAt: null },
      include: {
        examples: {
          orderBy: { createdAt: 'asc' },
        },
        _count: {
          select: {
            examples: true,
          },
        },
      },
    });
  }

  /**
   * Updates a dataset's name and/or overall_feedback. Scoped to team + dataset id.
   * Returns null if the dataset was not found or belongs to another team.
   *
   * @param teamId - Isolation boundary.
   * @param id - Dataset UUID.
   * @param data - Fields to update (any may be omitted); null clears overallFeedback.
   * @returns The updated dataset row, or null if not found.
   */
  async updateDataset(
    teamId: string,
    id: string,
    data: { name?: string; overallFeedback?: string | null },
  ): Promise<
    (Prisma.DatasetGetPayload<{ include: { _count: { select: { examples: true } } } }>) | null
  > {
    // First update
    const updated = await prisma.dataset.updateMany({
      where: { id, teamId, deletedAt: null },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.overallFeedback !== undefined ? { overallFeedback: data.overallFeedback } : {}),
      },
    });

    if (updated.count === 0) {
      return null;
    }

    // Re-read and return with counts
    return prisma.dataset.findFirst({
      where: { id, teamId, deletedAt: null },
      include: {
        _count: {
          select: {
            examples: true,
          },
        },
      },
    });
  }

  /**
   * Soft-deletes a dataset by setting deletedAt to the current timestamp.
   * Scoped to team + dataset id.
   *
   * @param teamId - Isolation boundary.
   * @param id - Dataset UUID.
   * @returns The number of rows updated (0 or 1).
   */
  async softDeleteDataset(teamId: string, id: string): Promise<number> {
    const result = await prisma.dataset.updateMany({
      where: { id, teamId, deletedAt: null },
      data: {
        deletedAt: new Date(),
      },
    });
    return result.count;
  }

  /**
   * Adds one example to a dataset. Scoped to team + dataset id.
   * Optionally runs inside a transaction for atomic creation with other operations.
   *
   * @param teamId - Isolation boundary.
   * @param datasetId - Dataset UUID.
   * @param data - Example fields: input (required), criteria, and source lineage.
   * @param tx - Optional transaction client.
   * @returns The created example row.
   */
  async createExample(
    teamId: string,
    datasetId: string,
    data: {
      input: Prisma.InputJsonValue;
      criteria?: string;
      history?: Prisma.InputJsonValue;
      sourceTraceId?: string;
      sourceFeedbackId?: string;
      sourcePromptVersionId?: string;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<Prisma.DatasetExampleGetPayload<{}>> {
    const client = tx ?? prisma;
    return client.datasetExample.create({
      data: {
        teamId,
        datasetId,
        input: data.input,
        criteria: data.criteria ?? null,
        // `DbNull`, not `JsonNull`: "this example has no history" is the absence
        // of a value, so the column must hold SQL NULL. `JsonNull` would store
        // the JSON literal `null`, which reads back the same in JS but makes
        // `history IS NULL` false for every row.
        history: data.history ?? Prisma.DbNull,
        sourceTraceId: data.sourceTraceId ?? null,
        sourceFeedbackId: data.sourceFeedbackId ?? null,
        sourcePromptVersionId: data.sourcePromptVersionId ?? null,
      },
    });
  }

  /**
   * Removes one example from a dataset. Scoped to team + dataset + example id.
   *
   * @param teamId - Isolation boundary.
   * @param datasetId - Dataset UUID (for scoping).
   * @param exampleId - Example UUID.
   * @returns The number of rows deleted (0 or 1).
   */
  async deleteExample(teamId: string, datasetId: string, exampleId: string): Promise<number> {
    const result = await prisma.datasetExample.deleteMany({
      where: { id: exampleId, datasetId, teamId },
    });
    return result.count;
  }

  /**
   * Loads feedback rows for a team by id list. Only rows belonging to the team
   * are returned; feedback from other teams is filtered out.
   *
   * @param teamId - Isolation boundary.
   * @param ids - Array of feedback UUIDs.
   * @returns Array of feedback rows (may be smaller than input if some ids don't exist).
   */
  async findFeedbackByIds(teamId: string, ids: string[]): Promise<Prisma.TraceFeedbackGetPayload<{}> []> {
    return prisma.traceFeedback.findMany({
      where: { id: { in: ids }, teamId },
    });
  }

  /**
   * Resolves the source LLM span's captured variables and promptVersionId for a
   * feedback row. Used when building a dataset from feedback to capture the input
   * context and the prompt version that was active.
   *
   * If feedback.spanId is set, looks up that specific span. Otherwise, finds the
   * trace's first LLM span (kind='llm') that has a non-null promptVersionId.
   * Returns null when no span payload exists or no appropriate span is found.
   *
   * @param teamId - Isolation boundary.
   * @param feedback - Feedback object with traceId (required) and spanId (nullable).
   * @returns Object with variables and promptVersionId, or null if not found.
   */
  async findSourceSpanPayload(
    teamId: string,
    feedback: { traceId: string; spanId: string | null },
  ): Promise<{ variables: Prisma.JsonValue | null; promptVersionId: string | null } | null> {
    let span: Prisma.SpanGetPayload<{ include: { payload: true } }> | null;

    if (feedback.spanId) {
      // Specific span requested
      span = await prisma.span.findFirst({
        where: {
          id: feedback.spanId,
          traceId: feedback.traceId,
          teamId,
        },
        include: {
          payload: true,
        },
      });
    } else {
      // Find the trace's LLM span with a non-null promptVersionId
      span = await prisma.span.findFirst({
        where: {
          traceId: feedback.traceId,
          teamId,
          kind: 'llm',
          promptVersionId: { not: null },
        },
        include: {
          payload: true,
        },
        orderBy: { createdAt: 'asc' },
      });
    }

    if (!span) {
      return null;
    }

    return {
      variables: span.payload?.variables ?? null,
      promptVersionId: span.promptVersionId,
    };
  }

  /**
   * Resolves each given prompt-version id to its parent prompt's id + name.
   * Used by `DatasetsService.checkPromptMismatch` to tell whether a dataset
   * example's lineage points at a different prompt than a run's target.
   *
   * @param versionIds - Prompt-version UUIDs to resolve (deduped by caller).
   * @param teamId - Isolation boundary. A version whose prompt belongs to a
   *   different team is treated as if it doesn't exist — this result feeds
   *   straight into an API response (the mismatch warning's prompt name), so
   *   it must never leak another team's data.
   * @returns Map of versionId -> { promptId, promptName }. A version that no
   *   longer exists (deleted), or belongs to another team, is simply absent
   *   from the map.
   */
  async resolveVersionPrompts(
    versionIds: string[],
    teamId: string,
  ): Promise<Map<string, { promptId: string; promptName: string }>> {
    if (versionIds.length === 0) return new Map();
    const rows = await prisma.promptVersion.findMany({
      where: { id: { in: versionIds }, prompt: { teamId } },
      select: { id: true, promptId: true, prompt: { select: { name: true } } },
    });
    return new Map(rows.map((r) => [r.id, { promptId: r.promptId, promptName: r.prompt.name }]));
  }

  /**
   * Loads one trace's `sessionId` and `startedAt`, team-scoped. Used to seed
   * a session-history reconstruction from the feedback trace.
   *
   * @param teamId - Isolation boundary.
   * @param traceId - Trace UUID.
   * @returns `{ sessionId, startedAt }`, or null if not found or in another team.
   */
  async getTraceById(
    teamId: string,
    traceId: string,
  ): Promise<{ sessionId: string | null; startedAt: Date } | null> {
    return prisma.trace.findFirst({
      where: { id: traceId, teamId },
      select: { sessionId: true, startedAt: true },
    });
  }

  /**
   * Lists the traces that share `sessionId` and started strictly before
   * `beforeStartedAt`, oldest first, capped at `limit`. Used to walk a
   * session backward from the feedback trace for history reconstruction.
   *
   * @param teamId - Isolation boundary.
   * @param sessionId - The session to walk.
   * @param beforeStartedAt - Exclusive upper bound (the feedback trace's own `startedAt`).
   * @param limit - Max traces to return (most-recent-first among the eligible set, then re-ordered ascending).
   * @returns Traces oldest first, each identified by id + startedAt.
   */
  async listPriorSessionTraces(
    teamId: string,
    sessionId: string,
    beforeStartedAt: Date,
    limit: number,
  ): Promise<Array<{ id: string; startedAt: Date }>> {
    const rows = await prisma.trace.findMany({
      where: { teamId, sessionId, startedAt: { lt: beforeStartedAt } },
      select: { id: true, startedAt: true },
      // `id` breaks ties: a gateway trace's `startedAt` is DERIVED
      // (createdAt - latencyMs), so two turns in one session can land on the
      // same instant, and without a second key their order — and therefore the
      // reconstructed conversation's order — would be undefined.
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.reverse();
  }

  /**
   * Loads one trace's `llm`-kind spans with captured payloads, oldest first —
   * the raw material `buildTraceExchange` (`./history.builder`) reconstructs
   * one turn's exchange from. Spans with no captured payload (capture was
   * off) or a missing input/output are excluded — there is nothing to
   * replay for them.
   *
   * Reads `input`/`output` only — not the whole span row and not the payload's
   * `variables`, which can be as large again as the messages and is never used
   * here. This runs once per prior trace in a session, so the saved transfer
   * multiplies.
   *
   * @param teamId - Isolation boundary.
   * @param traceId - Trace UUID.
   * @returns Each span's captured `input`/`output`, oldest first. Typed
   *   `unknown` deliberately: the payload is whatever its producer wrote (the
   *   gateway hook, either SDK's auto-trace, or a hand-ingested span), so it
   *   must be narrowed before use — `buildTraceExchange` does that.
   */
  async listLlmSpansForTrace(
    teamId: string,
    traceId: string,
  ): Promise<Array<{ input: unknown; output: unknown }>> {
    const spans = await prisma.span.findMany({
      where: { teamId, traceId, kind: 'llm', payload: { isNot: null } },
      select: { payload: { select: { input: true, output: true } } },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
    });
    return spans
      .filter((s) => s.payload?.input != null && s.payload?.output != null)
      .map((s) => ({ input: s.payload!.input as unknown, output: s.payload!.output as unknown }));
  }

  /**
   * Transaction helper: creates a dataset and N examples atomically.
   * Ensures that if the dataset is created but example creation fails, the entire
   * operation is rolled back.
   *
   * @param teamId - Isolation boundary.
   * @param createdBy - User ID (nullable for team-scoped API key creation).
   * @param dataset - Dataset fields: name and optional overallFeedback.
   * @param examples - Array of example data objects (input required, others optional).
   * @returns Object with created dataset (with example count) and total examples created.
   */
  async createDatasetWithExamples(
    teamId: string,
    createdBy: string | null,
    dataset: { name: string; overallFeedback?: string },
    examples: Array<{
      input: Prisma.InputJsonValue;
      criteria?: string;
      history?: Prisma.InputJsonValue;
      sourceTraceId?: string;
      sourceFeedbackId?: string;
      sourcePromptVersionId?: string;
    }>,
  ): Promise<{
    dataset: Prisma.DatasetGetPayload<{ include: { _count: { select: { examples: true } } } }>;
    examplesCreated: number;
  }> {
    return prisma.$transaction(async (tx) => {
      // Create the dataset
      const createdDataset = await tx.dataset.create({
        data: {
          teamId,
          name: dataset.name,
          overallFeedback: dataset.overallFeedback ?? null,
          createdBy,
        },
        include: {
          _count: {
            select: {
              examples: true,
            },
          },
        },
      });

      // Create all examples in one bulk insert (Finding #23) rather than one
      // round trip per example — a dataset with hundreds of examples no
      // longer holds the transaction open across hundreds of sequential awaits.
      const { count: examplesCreated } = await tx.datasetExample.createMany({
        data: examples.map((example) => ({
          teamId,
          datasetId: createdDataset.id,
          input: example.input,
          criteria: example.criteria ?? null,
          // SQL NULL, not the JSON literal `null` — see `createExample`.
          history: example.history ?? Prisma.DbNull,
          sourceTraceId: example.sourceTraceId ?? null,
          sourceFeedbackId: example.sourceFeedbackId ?? null,
          sourcePromptVersionId: example.sourcePromptVersionId ?? null,
        })),
      });

      // `createdDataset._count.examples` was captured when the dataset row was
      // created — before any example was inserted — so it is always 0. Return
      // it with the true count instead, so a caller that reads `_count` off the
      // returned dataset (via `toDto`) does not get a stale 0. `examplesCreated`
      // equals the true count here because the dataset is brand new.
      return {
        dataset: { ...createdDataset, _count: { examples: examplesCreated } },
        examplesCreated,
      };
    });
  }
}
