import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../shared/db/client';
import type { TraceRow, SpanRow } from '../../shared/db/schema';
import type { CreateTraceInput, CreateSpanInput } from './spans.types';
import { redactPayloadValue } from './redact';
import { traceIdWhere, TRACE_ID_MATCH_ORDER } from './trace-id-where';
// The files, not the `ingest` index: the index pulls in the ingest service, which imports this.
import { INT4_MAX } from '../ingest/int4-range';
import { MAX_COST_USD } from '../ingest/cost-range';

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
   * Returns the team's trace for a caller-chosen id, creating it when the team has none.
   *
   * A caller-chosen id names a trace within one team only (see {@link traceIdWhere}).
   * The first team to report an id stores it as `traces.id`. When another team already
   * holds that `traces.id`, this team's trace gets a server-generated `id` and records the
   * caller's id in `client_trace_id`, so neither team can claim or block the other's ids.
   * No other team's data is ever returned. The id handed back does show the case,
   * though: it differs from the caller's id exactly when another team holds that id, so
   * a caller who already knows an id can tell it is in use on this instance.
   *
   * Two writers often open the same new trace id at the same moment: with the TS SDK's
   * OTel bridge, the OTLP exporter and the span queue both report the first spans of a
   * step. A find-then-create let both see no row, and the slower insert failed the whole
   * request with a unique violation. So both inserts are `INSERT … ON CONFLICT DO
   * NOTHING`: the slower insert waits for the faster one's transaction and then inserts
   * nothing, and the read after it sees the committed row.
   *
   * @param input - As {@link createTrace}, with `id` (the caller's UUID) required.
   * @param tx - Optional transaction client.
   * @returns The team's trace row for that id (always `input.teamId`'s), and whether this
   *   call created it. Use the row's `id` for every write: it differs from `input.id` when
   *   another team held the id first.
   */
  async createTraceIfAbsent(
    input: CreateTraceInput & { id: string },
    tx?: Prisma.TransactionClient,
  ): Promise<{ trace: TraceRow; created: boolean }> {
    const client = tx ?? prisma;
    // The common case for any trace reported more than once: the team already has it.
    const existing = await this.findTrace(input.id, input.teamId, tx);
    if (existing) return { trace: existing, created: false };

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
    const holder = await client.trace.findUniqueOrThrow({ where: { id: input.id } });
    if (inserted.length === 1 || holder.teamId === input.teamId) {
      return { trace: holder, created: inserted.length === 1 };
    }

    // Another team holds this id: this team's trace takes a server-generated id instead.
    const aliased = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO traces (team_id, client_trace_id, session_id, name, name_is_derived, status, started_at, tags, metadata)
      VALUES (
        ${input.teamId}::uuid, ${input.id}::uuid, ${input.sessionId ?? null}, ${input.name ?? null},
        ${input.nameIsDerived}, ${input.status ?? 'unset'}::span_status, ${input.startedAt},
        ${tags}::text[], ${JSON.stringify(input.metadata ?? {})}::jsonb
      )
      ON CONFLICT (team_id, client_trace_id) WHERE client_trace_id IS NOT NULL DO NOTHING
      RETURNING id
    `);
    const trace = await client.trace.findFirstOrThrow({
      where: { teamId: input.teamId, clientTraceId: input.id },
    });
    return { trace, created: aliased.length === 1 };
  }

  /**
   * Finds a team's trace by the id a caller uses for it: its stored id, or the id the
   * caller chose when another team already held that one (see {@link traceIdWhere}).
   * Null if the team has no such trace, including when only another team has it.
   *
   * @param traceId - A stored trace id or a caller-chosen one (UUID).
   * @param teamId - Isolation boundary.
   * @param tx - Optional transaction client.
   * @returns The team's trace row, or null.
   */
  async findTrace(
    traceId: string,
    teamId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<TraceRow | null> {
    const client = tx ?? prisma;
    return client.trace.findFirst({ where: traceIdWhere(teamId, traceId), orderBy: TRACE_ID_MATCH_ORDER });
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
      // Capped: the rollup's DECIMAL(18, 9) column must not refuse the span.
      const newCost =
        spanCost == null
          ? trace.totalCostUsd
          : Prisma.Decimal.min((trace.totalCostUsd ?? new Prisma.Decimal(0)).add(spanCost), MAX_COST_USD);
      const newStatus =
        input.status === 'error' ? 'error' : trace.status === 'unset' ? 'ok' : trace.status;
      const spanEnded = input.endedAt ?? null;
      const newEndedAt =
        spanEnded && (!trace.endedAt || spanEnded > trace.endedAt) ? spanEnded : trace.endedAt;

      await client.trace.update({
        where: { id: input.traceId },
        data: {
          spanCount: { increment: 1 },
          // Capped: the rollup is INT4, and a sum past it must not refuse the span.
          totalTokens: Math.min(trace.totalTokens + (input.totalTokens ?? 0), INT4_MAX),
          totalCostUsd: newCost,
          status: newStatus,
          endedAt: newEndedAt,
        },
      });
    }

    return span;
  }

  /**
   * Idempotent span write for retry-safe callers (OTLP ingestion: the OTLP spec expects
   * exporters to retry a whole export on failure). Every span of one trace goes in one
   * `INSERT … ON CONFLICT (trace_id, span_ref)`, then the trace's rollups are recomputed
   * once from all its stored spans rather than incremented, since a blind increment
   * would double-count a retried batch. The native JSON path never uses this: it keeps
   * {@link appendSpan}'s stricter create-and-fail semantics.
   *
   * OTLP ingestion wrote each span with four statements (upsert, aggregate, error
   * lookup, trace update), so a 3-span trace cost a dozen round trips and the API spent
   * its CPU in the query engine (issue #851). This is two statements however many spans
   * the trace has.
   *
   * A span repeated in the batch (an exporter can send the same span twice in one
   * export) is written once, with its last copy's fields, which is what the sequential
   * upserts left behind. Postgres refuses an `ON CONFLICT DO UPDATE` that touches one
   * row twice in a statement, so the repeat cannot be passed through.
   *
   * @param traceId - The trace every input belongs to; each input's `traceId` must equal it.
   * @param inputs - The spans, in arrival order. Empty → no statement runs.
   * @param tx - Optional transaction client. Pass one to keep the spans and the rollups atomic.
   * @returns One row per distinct `spanRef`, in first-arrival order: the stored span id,
   *   its kind, and `inserted` (false when the span was already stored, so a retried
   *   export can tell new spans from repeats without a separate lookup).
   */
  async upsertSpans(
    traceId: string,
    inputs: CreateSpanInput[],
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; spanRef: string; kind: string; inserted: boolean }>> {
    if (inputs.length === 0) return [];
    const client = tx ?? prisma;
    const lastByRef = new Map<string, CreateSpanInput>();
    for (const input of inputs) {
      lastByRef.delete(input.spanRef);
      lastByRef.set(input.spanRef, input);
    }
    const order = [...new Set(inputs.map((i) => i.spanRef))];

    const rows = [...lastByRef.values()].map(
      (i) => Prisma.sql`(
        ${i.teamId}::uuid, ${traceId}::uuid, ${i.spanRef}, ${i.parentSpanRef ?? null}, ${i.kind}::span_kind,
        ${i.name}, ${i.status ?? 'unset'}::span_status, ${i.startedAt}, ${i.endedAt ?? null}::timestamptz,
        ${i.latencyMs ?? null}::int, ${i.model ?? null}, ${i.provider ?? null}, ${i.promptTokens ?? null}::int,
        ${i.completionTokens ?? null}::int, ${i.totalTokens ?? null}::int, ${i.cachedTokens ?? null}::int,
        ${i.costUsd == null ? null : String(i.costUsd)}::numeric, ${i.promptVersionId ?? null}::uuid,
        ${i.gatewayRequestId ?? null}::uuid, ${i.errorMessage ?? null},
        ${JSON.stringify(i.attributes ?? {})}::jsonb, ${JSON.stringify(i.metadata ?? {})}::jsonb,
        ${i.tags ?? []}::text[]
      )`,
    );
    const stored = await client.$queryRaw<Array<{ id: string; spanRef: string; kind: string; inserted: boolean }>>(
      Prisma.sql`
        INSERT INTO spans (
          team_id, trace_id, span_ref, parent_span_ref, kind, name, status, started_at, ended_at,
          latency_ms, model, provider, prompt_tokens, completion_tokens, total_tokens, cached_tokens,
          cost_usd, prompt_version_id, gateway_request_id, error_message, attributes, metadata, tags
        )
        VALUES ${Prisma.join(rows)}
        ON CONFLICT (trace_id, span_ref) DO UPDATE SET
          parent_span_ref = EXCLUDED.parent_span_ref, kind = EXCLUDED.kind, name = EXCLUDED.name,
          status = EXCLUDED.status, started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at,
          latency_ms = EXCLUDED.latency_ms, model = EXCLUDED.model, provider = EXCLUDED.provider,
          prompt_tokens = EXCLUDED.prompt_tokens, completion_tokens = EXCLUDED.completion_tokens,
          total_tokens = EXCLUDED.total_tokens, cached_tokens = EXCLUDED.cached_tokens,
          cost_usd = EXCLUDED.cost_usd, prompt_version_id = EXCLUDED.prompt_version_id,
          gateway_request_id = EXCLUDED.gateway_request_id, error_message = EXCLUDED.error_message,
          attributes = EXCLUDED.attributes, metadata = EXCLUDED.metadata, tags = EXCLUDED.tags
        -- xmax is 0 only on a row this statement inserted, not on one it updated.
        RETURNING id, span_ref AS "spanRef", kind::text AS kind, (xmax = 0) AS inserted
      `,
    );

    await client.$executeRaw(Prisma.sql`
      UPDATE traces t SET
        span_count = a.n,
        total_tokens = a.tokens,
        total_cost_usd = a.cost,
        status = CASE WHEN a.errored THEN 'error' ELSE 'ok' END::span_status,
        ended_at = a.ended
      FROM (
        SELECT count(*)::int AS n, LEAST(COALESCE(sum(total_tokens), 0), ${INT4_MAX})::int AS tokens,
               -- Not a bare LEAST: it skips NULLs, so a trace with no cost would get the cap.
               CASE WHEN sum(cost_usd) IS NULL THEN NULL ELSE LEAST(sum(cost_usd), ${MAX_COST_USD}::numeric) END AS cost,
               max(ended_at) AS ended, COALESCE(bool_or(status = 'error'), false) AS errored
        FROM spans WHERE trace_id = ${traceId}::uuid
      ) a
      WHERE t.id = ${traceId}::uuid
    `);

    const byRef = new Map(stored.map((r) => [r.spanRef, r]));
    return order.map((ref) => byRef.get(ref)!);
  }

  /**
   * Batch form of {@link writePayload} for spans that send no tool list (SDK and OTLP
   * ingestion): one `INSERT … ON CONFLICT` for all of them. Each value goes through
   * {@link redactPayloadValue}, the same choke point as the single-row write.
   *
   * @param teamId - Isolation boundary.
   * @param payloads - One entry per span; a span id must not repeat. An undefined field
   *   is stored as SQL NULL. Empty → no statement runs.
   * @param tx - Optional transaction client.
   */
  async writePayloads(
    teamId: string,
    payloads: Array<{ spanId: string; input?: unknown; output?: unknown; variables?: unknown }>,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (payloads.length === 0) return;
    const client = tx ?? prisma;
    const json = (v: unknown) => (v === undefined ? null : JSON.stringify(redactPayloadValue(v)));
    const rows = payloads.map(
      (p) => Prisma.sql`(
        ${p.spanId}::uuid, ${teamId}::uuid, ${json(p.input)}::jsonb, ${json(p.output)}::jsonb,
        ${json(p.variables)}::jsonb
      )`,
    );
    await client.$executeRaw(Prisma.sql`
      INSERT INTO span_payloads (span_id, team_id, input, output, variables)
      VALUES ${Prisma.join(rows)}
      ON CONFLICT (span_id) DO UPDATE SET
        input = EXCLUDED.input, output = EXCLUDED.output, variables = EXCLUDED.variables,
        tool_set_id = NULL, tool_choice = NULL
    `);
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
   * @param onlyRefs - When given, only these refs are looked up, so a check of one batch
   *   costs the batch's size rather than the whole trace's.
   * @returns The list of stored `span_ref` strings (possibly empty).
   */
  async listSpanRefs(traceId: string, tx?: Prisma.TransactionClient, onlyRefs?: string[]): Promise<string[]> {
    const client = tx ?? prisma;
    const rows = await client.span.findMany({
      where: { traceId, ...(onlyRefs ? { spanRef: { in: onlyRefs } } : {}) },
      select: { spanRef: true },
    });
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
   * ingest retry (`IngestService`'s `upsertSpans` path) reuses the same span row,
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
