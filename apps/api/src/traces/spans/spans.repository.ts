import { Prisma } from '@prisma/client';
import prisma from '../../shared/db/client';
import type { TraceRow, SpanRow } from '../../shared/db/schema';
import type { CreateTraceInput, CreateSpanInput } from './spans.types';
import { redactPayloadValue } from './redact';

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
        status: input.status ?? 'unset',
        startedAt: input.startedAt,
        tags: input.tags ?? [],
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
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
   * @param traceId - The existing trace's UUID.
   * @param teamId - Isolation boundary.
   * @param patch - `name` (overwrite) / `tags`/`metadata` (merge) to apply; any may be omitted.
   * @param tx - Optional transaction client.
   */
  async mergeTraceContext(
    traceId: string,
    teamId: string,
    patch: { name?: string; tags?: string[]; metadata?: Record<string, unknown>; sessionId?: string },
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const sets: Prisma.Sql[] = [];
    if (patch.name) {
      sets.push(Prisma.sql`name = ${patch.name}`);
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
   * @param spanId - The span this payload belongs to (PK of span_payloads).
   * @param teamId - Isolation boundary.
   * @param io - `{ input?, output?, variables? }` — arbitrary JSON-serializable values.
   * @param tx - Optional transaction client.
   */
  async writePayload(
    spanId: string,
    teamId: string,
    io: { input?: unknown; output?: unknown; variables?: unknown },
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? prisma;
    await client.spanPayload.create({
      data: {
        spanId,
        teamId,
        input: io.input === undefined ? Prisma.DbNull : (redactPayloadValue(io.input) as Prisma.InputJsonValue),
        output: io.output === undefined ? Prisma.DbNull : (redactPayloadValue(io.output) as Prisma.InputJsonValue),
        variables:
          io.variables === undefined ? Prisma.DbNull : (redactPayloadValue(io.variables) as Prisma.InputJsonValue),
      },
    });
  }
}
