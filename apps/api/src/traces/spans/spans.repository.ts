import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../shared/db/client';
import type { TraceRow, SpanRow } from '../../shared/db/schema';
import type { CreateTraceInput, CreateSpanInput } from './spans.types';
import { redactPayloadValue } from './redact';

/**
 * Matches the Q12 timestamp fallback name, `startedAt.toISOString()`. Matching it by
 * pattern rather than recomputing it avoids depending on Postgres and JS agreeing on
 * timestamp formatting, and a user naming a trace after an ISO instant is not a real case.
 * It also identifies a derived name on traces written before `name_is_derived` existed.
 */
const TIMESTAMP_NAME = Prisma.sql`name ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$'`;

/**
 * The ONLY writer of the `traces`, `spans`, and `span_payloads` tables. Every
 * method accepts an optional Prisma transaction client so the gateway hook can run
 * trace + span + payload + rollup writes atomically in its own `$transaction`.
 */
export class SpansRepository {
  /**
   * Inserts a new trace row. Rollups start at zero; `id` is honored when supplied
   * (a caller-supplied trace id) else the DB generates one.
   *
   * @param input - teamId + startedAt (required); optional id/sessionId/name/status.
   * @param tx - Optional transaction client.
   * @returns The inserted trace row.
   */
  async createTrace(input: CreateTraceInput, tx?: Prisma.TransactionClient): Promise<TraceRow> {
    const client = tx ?? prisma;
    return client.trace.create({
      data: {
        ...(input.id ? { id: input.id } : {}),
        teamId: input.teamId,
        sessionId: input.sessionId ?? null,
        name: input.name ?? null,
        nameIsDerived: input.nameIsDerived,
        status: input.status ?? 'unset',
        startedAt: input.startedAt,
        tags: input.tags ?? [],
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Inserts a trace with a caller-supplied id unless a trace with that id already exists,
   * in one `INSERT … ON CONFLICT DO NOTHING`.
   *
   * Two writers often open the same new trace id at the same moment: with the TS SDK's
   * OTel bridge, the OTLP exporter and the span queue both report the first spans of a
   * step. A find-then-create let both see no row, and the slower insert failed the whole
   * request with a unique violation. Here the slower insert waits for the faster one's
   * transaction and then inserts nothing, and the read after it sees the committed row.
   *
   * @param input - As {@link createTrace}, with `id` required.
   * @param tx - Optional transaction client.
   * @returns The trace row with that id, and whether this call created it. When `created`
   *   is false the row may belong to another team: the caller must check `teamId`.
   */
  async createTraceIfAbsent(
    input: CreateTraceInput & { id: string },
    tx?: Prisma.TransactionClient,
  ): Promise<{ trace: TraceRow; created: boolean }> {
    const client = tx ?? prisma;
    const tags = input.tags ?? [];
    const inserted = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO traces (id, team_id, session_id, name, name_is_derived, status, started_at, tags, metadata)
      VALUES (
        ${input.id}::uuid, ${input.teamId}::uuid, ${input.sessionId ?? null}, ${input.name ?? null},
        ${input.nameIsDerived}, ${input.status ?? 'unset'}::span_status, ${input.startedAt},
        ${tags}::text[], ${JSON.stringify(input.metadata ?? {})}::jsonb
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `);
    const trace = await client.trace.findUniqueOrThrow({ where: { id: input.id } });
    return { trace, created: inserted.length === 1 };
  }

  /**
   * Finds a trace by id, scoped to the team (null if missing or another team's).
   *
   * @param traceId - Trace UUID.
   * @param teamId - Isolation boundary.
   * @param tx - Optional transaction client.
   */
  async findTrace(
    traceId: string,
    teamId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<TraceRow | null> {
    const client = tx ?? prisma;
    return client.trace.findFirst({ where: { id: traceId, teamId } });
  }

  /**
   * Merges tags (union, deduped) and metadata (shallow merge, new keys win on
   * conflict) into an already-existing trace — used when a second gateway call
   * or SDK ingestion batch shares a `traceId` and supplies its own tags/metadata
   * (T8, FAQ Q11). `name`, when supplied, is a plain overwrite rather than a merge
   * — last-explicit-write-wins (T9, FAQ Q11 revised): a call that omits `name` is
   * a no-op for it, never resetting an already-named trace. A no-op single atomic
   * `UPDATE` — no read-then-write race. Silently matches zero rows if `traceId`
   * isn't in `teamId` (callers resolve/verify the trace before calling this).
   *
   * `nameIfPlaceholder` is the DERIVED-name counterpart: it fills the name in only while
   * the trace still carries the Q12 timestamp fallback, and never touches a real one. That
   * is what the OTLP path needs — a batch can create a trace before the batch containing
   * its root span arrives, so the name has to be upgradable later without a second batch
   * being able to push a real name back to a timestamp (issue #362). It is deliberately a
   * separate key from `name`: `name` is a caller's explicit instruction and keeps
   * last-explicit-write-wins (Q11).
   *
   * `nameIfDerived` sits between the two: it replaces a name the server derived (the
   * message text or the timestamp, `name_is_derived`) but never one a caller chose. It is
   * how a step's root report names a trace that a gateway call inside the step opened
   * first (issue #791, FAQ Q48). A weak `nameIfPlaceholder` must not do this, or a
   * library default like `runToolLoop` would replace the message text (Q33).
   *
   * @param traceId - The existing trace's UUID.
   * @param teamId - Isolation boundary.
   * @param patch - `name` (overwrite) / `nameIfDerived` (replace a server fallback) /
   *   `nameIfPlaceholder` (fill in only) /
   *   `tags`/`metadata` (merge) / `startedAt` (move the start earlier, never later) to
   *   apply; any may be omitted. `name` wins over
   *   `nameIfPlaceholder` when both are given.
   * @param tx - Optional transaction client.
   */
  async mergeTraceContext(
    traceId: string,
    teamId: string,
    patch: {
      name?: string;
      nameIfDerived?: string;
      nameIfPlaceholder?: string;
      tags?: string[];
      metadata?: Record<string, unknown>;
      sessionId?: string;
      startedAt?: Date;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const sets: Prisma.Sql[] = [];
    if (patch.name) {
      sets.push(Prisma.sql`name = ${patch.name}`, Prisma.sql`name_is_derived = false`);
    } else if (patch.nameIfDerived) {
      sets.push(
        Prisma.sql`name = CASE WHEN name_is_derived OR ${TIMESTAMP_NAME} THEN ${patch.nameIfDerived} ELSE name END`,
        Prisma.sql`name_is_derived = CASE WHEN name_is_derived OR ${TIMESTAMP_NAME} THEN false ELSE name_is_derived END`,
      );
    } else if (patch.nameIfPlaceholder) {
      // The name that replaces the placeholder is itself a fallback, so the flag is set:
      // on a trace from before `name_is_derived`, leaving it false would stop the root
      // step from ever renaming the trace.
      sets.push(
        Prisma.sql`name = CASE WHEN ${TIMESTAMP_NAME} THEN ${patch.nameIfPlaceholder} ELSE name END`,
        Prisma.sql`name_is_derived = CASE WHEN ${TIMESTAMP_NAME} THEN true ELSE name_is_derived END`,
      );
    }
    // A report can hold spans that began before the call that opened the trace, such as
    // a step's root span: the trace starts at its earliest span.
    if (patch.startedAt) {
      sets.push(Prisma.sql`started_at = LEAST(started_at, ${patch.startedAt})`);
    }
    // Backfill the session id only when the trace doesn't have one yet — never
    // overwrite. This is how a gateway-created trace (born session-less) picks up
    // the session when a client later reports spans with it (e.g. runToolLoop).
    if (patch.sessionId) {
      sets.push(Prisma.sql`session_id = COALESCE(session_id, ${patch.sessionId})`);
    }
    if (patch.tags && patch.tags.length > 0) {
      sets.push(
        Prisma.sql`tags = (SELECT array_agg(DISTINCT x) FROM unnest(tags || ARRAY[${Prisma.join(patch.tags)}]::text[]) AS x)`,
      );
    }
    if (patch.metadata && Object.keys(patch.metadata).length > 0) {
      sets.push(Prisma.sql`metadata = metadata || ${JSON.stringify(patch.metadata)}::jsonb`);
    }
    if (sets.length === 0) return;

    const client = tx ?? prisma;
    await client.$executeRaw(Prisma.sql`
      UPDATE traces SET ${Prisma.join(sets, ', ')}
      WHERE id = ${traceId}::uuid AND team_id = ${teamId}::uuid
    `);
  }

  /**
   * Inserts a span and updates its trace's denormalized rollups in the SAME call
   * (pass a `tx` to keep both atomic). Rollups: span_count += 1, total_tokens +=
   * span tokens, total_cost_usd += span cost (null-safe), status → 'error' if the
   * span errored else 'ok' (never downgrades an existing 'error'), ended_at → the
   * latest span end time seen.
   *
   * @param input - The span fields (see {@link CreateSpanInput}).
   * @param tx - Optional transaction client (used by the gateway hook).
   * @returns The inserted span row.
   */
  async appendSpan(input: CreateSpanInput, tx?: Prisma.TransactionClient): Promise<SpanRow> {
    const client = tx ?? prisma;
    const span = await client.span.create({
      data: {
        teamId: input.teamId,
        traceId: input.traceId,
        spanRef: input.spanRef,
        parentSpanRef: input.parentSpanRef ?? null,
        kind: input.kind,
        name: input.name,
        status: input.status ?? 'unset',
        startedAt: input.startedAt,
        endedAt: input.endedAt ?? null,
        latencyMs: input.latencyMs ?? null,
        model: input.model ?? null,
        provider: input.provider ?? null,
        promptTokens: input.promptTokens ?? null,
        completionTokens: input.completionTokens ?? null,
        totalTokens: input.totalTokens ?? null,
        cachedTokens: input.cachedTokens ?? null,
        costUsd: input.costUsd ?? null,
        promptVersionId: input.promptVersionId ?? null,
        gatewayRequestId: input.gatewayRequestId ?? null,
        errorMessage: input.errorMessage ?? null,
        attributes: (input.attributes ?? {}) as Prisma.InputJsonValue,
        tags: input.tags ?? [],
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });

    const trace = await client.trace.findUnique({ where: { id: input.traceId } });
    if (trace) {
      const spanCost = input.costUsd == null ? null : new Prisma.Decimal(input.costUsd);
      const newCost =
        spanCost == null ? trace.totalCostUsd : (trace.totalCostUsd ?? new Prisma.Decimal(0)).add(spanCost);
      const newStatus =
        input.status === 'error' ? 'error' : trace.status === 'unset' ? 'ok' : trace.status;
      const spanEnded = input.endedAt ?? null;
      const newEndedAt =
        spanEnded && (!trace.endedAt || spanEnded > trace.endedAt) ? spanEnded : trace.endedAt;

      await client.trace.update({
        where: { id: input.traceId },
        data: {
          spanCount: { increment: 1 },
          totalTokens: trace.totalTokens + (input.totalTokens ?? 0),
          totalCostUsd: newCost,
          status: newStatus,
          endedAt: newEndedAt,
        },
      });
    }

    return span;
  }

  /**
   * Idempotent span write for retry-safe callers (OTLP ingestion — the OTLP spec
   * expects exporters to retry a whole export on failure). Upserts on
   * `(traceId, spanRef)` instead of `create()`, and recomputes the trace's
   * rollups from a fresh aggregate over all its spans rather than incrementing —
   * a blind increment would double-count on a retried batch. Never used by the
   * native JSON ingestion path, which keeps {@link appendSpan}'s stricter
   * create-and-fail semantics unchanged.
   *
   * @param input - The span fields (see {@link CreateSpanInput}).
   * @param tx - Optional transaction client.
   * @returns The upserted span row.
   */
  async upsertSpan(input: CreateSpanInput, tx?: Prisma.TransactionClient): Promise<SpanRow> {
    const client = tx ?? prisma;
    const data = {
      kind: input.kind,
      name: input.name,
      status: input.status ?? 'unset',
      startedAt: input.startedAt,
      endedAt: input.endedAt ?? null,
      latencyMs: input.latencyMs ?? null,
      model: input.model ?? null,
      provider: input.provider ?? null,
      promptTokens: input.promptTokens ?? null,
      completionTokens: input.completionTokens ?? null,
      totalTokens: input.totalTokens ?? null,
      cachedTokens: input.cachedTokens ?? null,
      costUsd: input.costUsd ?? null,
      promptVersionId: input.promptVersionId ?? null,
      gatewayRequestId: input.gatewayRequestId ?? null,
      errorMessage: input.errorMessage ?? null,
      attributes: (input.attributes ?? {}) as Prisma.InputJsonValue,
      tags: input.tags ?? [],
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      parentSpanRef: input.parentSpanRef ?? null,
    };

    const span = await client.span.upsert({
      where: { traceId_spanRef: { traceId: input.traceId, spanRef: input.spanRef } },
      create: { teamId: input.teamId, traceId: input.traceId, spanRef: input.spanRef, ...data },
      update: data,
    });

    const agg = await client.span.aggregate({
      where: { traceId: input.traceId },
      _count: { _all: true },
      _sum: { totalTokens: true, costUsd: true },
      _max: { endedAt: true },
    });
    const anyErrored = await client.span.findFirst({
      where: { traceId: input.traceId, status: 'error' },
      select: { id: true },
    });

    await client.trace.update({
      where: { id: input.traceId },
      data: {
        spanCount: agg._count._all,
        totalTokens: agg._sum.totalTokens ?? 0,
        totalCostUsd: agg._sum.costUsd,
        status: anyErrored ? 'error' : 'ok',
        endedAt: agg._max.endedAt,
      },
    });

    return span;
  }

  /**
   * Fetches a trace by primary key **without** a team filter, so the caller can
   * tell "absent" (null) apart from "belongs to another team"
   * (`row.teamId !== teamId`). Intentionally team-agnostic: T2 ingestion uses
   * this to resolve/append and to enforce cross-team isolation itself (a
   * foreign trace id → 404, never an append). Callers MUST verify
   * `row.teamId` themselves before trusting the result.
   *
   * @param id - The trace UUID (caller-supplied on append).
   * @param tx - Optional transaction client to read inside the ingest tx.
   * @returns The trace row, or null if no trace has that id.
   */
  async findTraceById(id: string, tx?: Prisma.TransactionClient): Promise<TraceRow | null> {
    const client = tx ?? prisma;
    return client.trace.findUnique({ where: { id } });
  }

  /**
   * Returns the caller-supplied `span_ref` values already stored under a trace,
   * so ingestion can validate `parentSpanId` references against previously
   * stored spans (not just spans in the current batch).
   *
   * @param traceId - The trace UUID.
   * @param tx - Optional transaction client to read inside the ingest tx.
   * @returns The list of stored `span_ref` strings (possibly empty).
   */
  async listSpanRefs(traceId: string, tx?: Prisma.TransactionClient): Promise<string[]> {
    const client = tx ?? prisma;
    const rows = await client.span.findMany({ where: { traceId }, select: { spanRef: true } });
    return rows.map((r) => r.spanRef);
  }

  /**
   * Writes the request/response payloads for a span. Called only when capture
   * resolves on (FAQ Q5). Undefined input/output/variables is stored as SQL NULL.
   * Each defined value is passed through {@link redactPayloadValue} first
   * (Finding #7) — a best-effort scrub of common secret shapes — before it is
   * ever written to disk; this is the single choke point every caller goes
   * through, so no call site can accidentally skip it.
   *
   * Upserts rather than inserts: `spanId` is the table's PK, and an idempotent
   * ingest retry (`IngestService`'s `upsertSpan` path) reuses the same span row,
   * so a plain `create()` would throw a unique-constraint violation on replay.
   * A fresh span from the non-idempotent `appendSpan` path always has a new id,
   * so this is a strict superset of the old behavior there.
   *
   * @param spanId - The span this payload belongs to (PK of span_payloads).
   * @param teamId - Isolation boundary.
   * @param io - `{ input?, output?, variables?, tools?, toolChoice? }` — arbitrary
   *   JSON-serializable values. `tools` / `toolChoice` are the tool definitions and
   *   `tool_choice` a gateway call sent (issues #792, #793); other callers omit them.
   *   `tools` is stored once per trace in `trace_tool_sets` (see {@link toolSetFor}); an
   *   empty list stores no set, so `toolSetId` is null exactly when no tools were sent.
   * @param tx - Optional transaction client.
   */
  async writePayload(
    spanId: string,
    teamId: string,
    io: { input?: unknown; output?: unknown; variables?: unknown; tools?: unknown; toolChoice?: unknown },
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? prisma;
    const data = {
      toolSetId: await this.toolSetFor(spanId, teamId, io.tools, client),
      toolChoice:
        io.toolChoice == null ? Prisma.DbNull : (redactPayloadValue(io.toolChoice) as Prisma.InputJsonValue),
      input: io.input === undefined ? Prisma.DbNull : (redactPayloadValue(io.input) as Prisma.InputJsonValue),
      output: io.output === undefined ? Prisma.DbNull : (redactPayloadValue(io.output) as Prisma.InputJsonValue),
      variables:
        io.variables === undefined ? Prisma.DbNull : (redactPayloadValue(io.variables) as Prisma.InputJsonValue),
    };
    await client.spanPayload.upsert({
      where: { spanId },
      create: {
        spanId,
        teamId,
        ...data,
      },
      update: data,
    });
  }

  /**
   * Finds or stores the trace-level copy of a tool list and returns its id.
   *
   * A tool loop sends the same definitions on every round, so the list is keyed by the
   * SHA-256 of its redacted JSON within the span's trace, and `INSERT … ON CONFLICT DO
   * NOTHING` makes two rounds written at once share one row.
   *
   * @param spanId - The span whose trace the list belongs to.
   * @param teamId - Isolation boundary.
   * @param tools - The request's `tools`; null, undefined or an empty array stores nothing.
   * @param client - The caller's client or transaction.
   * @returns The `trace_tool_sets` id, or null when no tools were sent.
   */
  private async toolSetFor(
    spanId: string,
    teamId: string,
    tools: unknown,
    client: Prisma.TransactionClient | typeof prisma,
  ): Promise<string | null> {
    if (tools == null || (Array.isArray(tools) && tools.length === 0)) return null;
    const json = JSON.stringify(redactPayloadValue(tools));
    const hash = `sha256:${createHash('sha256').update(json).digest('hex')}`;
    await client.$executeRaw(Prisma.sql`
      INSERT INTO trace_tool_sets (trace_id, team_id, hash, tools)
      SELECT s.trace_id, ${teamId}::uuid, ${hash}, ${json}::jsonb
      FROM spans s WHERE s.id = ${spanId}::uuid AND s.team_id = ${teamId}::uuid
      ON CONFLICT (trace_id, hash) DO NOTHING
    `);
    const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT t.id FROM trace_tool_sets t JOIN spans s ON s.trace_id = t.trace_id
      WHERE s.id = ${spanId}::uuid AND t.hash = ${hash}
    `);
    return rows[0]?.id ?? null;
  }
}
