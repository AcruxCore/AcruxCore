import prisma from '../../shared/db/client';
import { Prisma } from '@prisma/client';
import type { TraceListFilters, TraceListItem } from './query.types';
import { buildTraceConditions, runContentSearch } from '../filters';
import { traceIdWhere, TRACE_ID_MATCH_ORDER } from '../spans/trace-id-where';
import { getTraceListCountCap } from './list-count.config';
import { detectRetrieval, LIST_FIELDS, SAMPLE_SIZE } from './retrieval';
import type { TraceRow, SpanRow, SpanPayloadRow } from '../../shared/db/schema';

/** Raw row shape returned by the list query before Date→ISO mapping. */
interface TraceListRaw {
  id: string;
  name: string | null;
  sessionId: string | null;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  spanCount: number;
  totalCostUsd: number | null;
  totalTokens: number;
  durationMs: number | null;
  tags: string[];
  hasWarning: boolean;
}

/**
 * An output stored as one JSON string larger than this is not inspected for the list's
 * search count. Lists and objects have no cap: only their first items are read.
 */
const MAX_COUNTED_STRING_BYTES = 1_048_576;

/** jsonpath for the leading items the shape check samples, e.g. `$[0 to 19]`. */
const SAMPLE_PATH = `$[0 to ${SAMPLE_SIZE - 1}]`;

/**
 * Read-only data access over `traces`/`spans` for the query surface. All queries
 * are team-scoped and hit the single uniform span table (no UNION). Span-level
 * filters resolve via `EXISTS (SELECT 1 FROM spans …)` so the row returned is the
 * trace. `groupBy`-free casts (`::int`, `::float8`, `status::text`) make raw rows
 * deserialize straight into JS numbers/strings.
 */
export class TraceQueryRepository {
  /** Maps a raw list row to the API DTO (timestamps → ISO strings). */
  private toListItem(r: TraceListRaw): TraceListItem {
    return {
      id: r.id,
      name: r.name,
      sessionId: r.sessionId,
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt ? r.endedAt.toISOString() : null,
      spanCount: r.spanCount,
      totalCostUsd: r.totalCostUsd,
      totalTokens: r.totalTokens,
      durationMs: r.durationMs,
      tags: r.tags,
      hasWarning: r.hasWarning,
      searchCount: 0,
    };
  }

  /**
   * Counts the search steps of each listed trace with the same rule the detail view uses
   * (issue #870): every `retrieval` span and every tool marked `kind="retrieval"`, plus
   * each unmarked `tool` span whose output is a list of documents.
   *
   * Only an unmarked tool's output is read, and only what the shape check looks at: the
   * first {@link SAMPLE_SIZE} items of a list, or of an object's list fields. So a page
   * of large RAG outputs sends Node a few items per span, not every document. An output
   * stored as one JSON string over {@link MAX_COUNTED_STRING_BYTES} is not counted.
   *
   * Runs on the shared client, after the page query: inside a content search's bounded
   * transaction it would be a third statement the transaction's budget does not cover.
   *
   * @param traceIds - The ids of the page's traces.
   * @returns Search steps per trace id; a trace with none is absent.
   */
  private async countSearches(traceIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (traceIds.length === 0) return counts;
    const listFields = Prisma.join(LIST_FIELDS.map((f) => Prisma.sql`${f}`));
    const rows = await prisma.$queryRaw<{ traceId: string; kind: string; toolKind: string | null; output: unknown }[]>(Prisma.sql`
      SELECT s.trace_id AS "traceId", s.kind::text AS kind, s.attributes->>'toolKind' AS "toolKind",
        CASE WHEN s.kind = 'tool' AND COALESCE(s.attributes->>'toolKind', '') NOT IN ('retrieval', 'tool') THEN
          CASE jsonb_typeof(p.output)
            WHEN 'array' THEN jsonb_path_query_array(p.output, ${SAMPLE_PATH}::jsonpath)
            WHEN 'object' THEN (
              SELECT jsonb_object_agg(e.key, CASE jsonb_typeof(e.value)
                WHEN 'array' THEN jsonb_path_query_array(e.value, ${SAMPLE_PATH}::jsonpath)
                WHEN 'string' THEN CASE WHEN octet_length(e.value #>> '{}') <= ${MAX_COUNTED_STRING_BYTES} THEN e.value END
              END)
              FROM jsonb_each(p.output) e
              WHERE e.key IN (${listFields})
            )
            WHEN 'string' THEN CASE WHEN octet_length(p.output #>> '{}') <= ${MAX_COUNTED_STRING_BYTES} THEN p.output END
          END
        END AS output
      FROM spans s
      LEFT JOIN span_payloads p ON p.span_id = s.id
      WHERE s.trace_id IN (${Prisma.join(traceIds.map((id) => Prisma.sql`${id}::uuid`))})
        AND s.kind IN ('tool', 'retrieval')
    `);
    for (const r of rows) {
      const payload = r.output === null || r.output === undefined ? undefined : { input: null, output: r.output };
      if (detectRetrieval({ kind: r.kind, attributes: { toolKind: r.toolKind }, payload })) counts.set(r.traceId, (counts.get(r.traceId) ?? 0) + 1);
    }
    return counts;
  }

  /**
   * Fills `searchCount` on a page of list rows (see {@link countSearches}).
   *
   * @param result - A page from {@link runList}.
   * @returns The same page with each row's search count.
   */
  private async withSearchCounts(
    result: { data: TraceListItem[]; total: number; totalCapped: boolean },
  ): Promise<{ data: TraceListItem[]; total: number; totalCapped: boolean }> {
    const searches = await this.countSearches(result.data.map((r) => r.id));
    return { ...result, data: result.data.map((r) => ({ ...r, searchCount: searches.get(r.id) ?? 0 })) };
  }

  /**
   * Runs the shared list SELECT + capped COUNT for a given WHERE fragment. Ordered
   * newest-first by `created_at` (matches idx_traces_team_time).
   *
   * Two choices keep the call flat as a team's history grows (issue #851; at 100,000
   * traces the old form took 67 ms in Postgres):
   * - The page is cut first and `hasWarning` is computed on its rows only. Over the whole
   *   table the planner hashed the subquery and scanned every span (45 ms); over 50 rows it
   *   probes `idx_spans_trace` per row (0.4 ms).
   * - The count stops at the page's offset plus {@link getTraceListCountCap} rows (2.6 ms
   *   instead of 23 ms for a full `COUNT(*)`), and `totalCapped` says when it stopped.
   *
   * @param where - A Prisma.Sql boolean expression over alias `t` (traces).
   * @param page - 1-based page.
   * @param limit - Page size (already capped at 100 upstream).
   * @param client - The client to run on: a content search passes its bounded
   *   transaction (see `runContentSearch`); everything else uses the shared client.
   * @returns Mapped page rows (with `searchCount` 0; see {@link withSearchCounts}), the
   *   matching count up to the cap, and whether it was capped.
   */
  private async runList(
    where: Prisma.Sql,
    page: number,
    limit: number,
    client: Prisma.TransactionClient = prisma,
  ): Promise<{ data: TraceListItem[]; total: number; totalCapped: boolean }> {
    const offset = (page - 1) * limit;

    const rows = await client.$queryRaw<TraceListRaw[]>(Prisma.sql`
      SELECT
        t.id,
        t.name,
        t.session_id AS "sessionId",
        t.status::text AS "status",
        t.started_at AS "startedAt",
        t.ended_at AS "endedAt",
        t.span_count AS "spanCount",
        t.total_cost_usd::float8 AS "totalCostUsd",
        t.total_tokens AS "totalTokens",
        CASE WHEN t.ended_at IS NULL THEN NULL
             ELSE (EXTRACT(EPOCH FROM (t.ended_at - t.started_at)) * 1000)::int END AS "durationMs",
        t.tags,
        -- Same predicate as the has_warning filter, selected rather than applied, so a
        -- reader who did not think to filter still sees the mark on the row.
        EXISTS (
          SELECT 1 FROM spans s
          WHERE s.trace_id = t.id AND jsonb_exists(s.attributes, 'warning')
        ) AS "hasWarning"
      FROM (
        SELECT t.* FROM traces t
        WHERE ${where}
        ORDER BY t.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      ) t
      ORDER BY t.created_at DESC
    `);

    const countLimit = offset + getTraceListCountCap();
    const counted = await client.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS n FROM (SELECT 1 FROM traces t WHERE ${where} LIMIT ${countLimit + 1}) c
    `);
    const totalCapped = counted[0].n > countLimit;

    return {
      data: rows.map((r) => this.toListItem(r)),
      total: totalCapped ? countLimit : counted[0].n,
      totalCapped,
    };
  }

  /**
   * Lists traces newest-first with optional filters.
   *
   * Every condition beyond team scope comes from {@link buildTraceConditions},
   * the one filter definition this endpoint shares with the feedback feed and
   * the dataset builders — so `?prompt_id=` means the same thing everywhere,
   * and a filter is never added to one surface and forgotten on another.
   *
   * A free-text `q` makes this a content search, run within its bounds (see
   * `runContentSearch`).
   *
   * @param teamId - Team scope.
   * @param filters - Resolved (camelCase) filters incl. page/limit.
   * @returns Page of trace list items, the matching count up to the cap, and whether it was capped.
   * @throws {RateLimitedError} 429 when `q` is set and the team already has its limit of
   *   searches running.
   * @throws {SearchTimeoutError} 422 when a `q` search runs past its statement timeout.
   */
  async listTraces(
    teamId: string,
    filters: TraceListFilters,
  ): Promise<{ data: TraceListItem[]; total: number; totalCapped: boolean }> {
    const conds: Prisma.Sql[] = [
      Prisma.sql`t.team_id = ${teamId}::uuid`,
      ...buildTraceConditions(filters, 't'),
    ];

    const where = Prisma.join(conds, ' AND ');
    const page = filters.q
      ? await runContentSearch(teamId, (tx) => this.runList(where, filters.page, filters.limit, tx))
      : await this.runList(where, filters.page, filters.limit);
    return this.withSearchCounts(page);
  }

  /**
   * Fetches a trace and its flat span list, scoped to the team, plus any captured
   * payload rows keyed by internal span id. Returns null when the trace is not in
   * the team. Spans are ordered by `started_at` so the tree builder nests children
   * in start order.
   *
   * @param teamId - Team scope.
   * @param traceId - The trace's stored id, or the id its caller chose for it (see
   *   `traceIdWhere`).
   * @returns `{ trace, spans, payloads?, toolSets }`, or null if not found in this team.
   *   `toolSets` maps a `trace_tool_sets` id to its tool list.
   */
  async getTrace(
    teamId: string,
    traceId: string,
  ): Promise<{
    trace: TraceRow;
    spans: SpanRow[];
    payloads?: Record<string, SpanPayloadRow>;
    toolSets: Record<string, unknown>;
  } | null> {
    const trace = await prisma.trace.findFirst({
      where: traceIdWhere(teamId, traceId),
      orderBy: TRACE_ID_MATCH_ORDER,
    });
    if (!trace) return null;

    const spans = await prisma.span.findMany({
      where: { traceId: trace.id, teamId },
      orderBy: { startedAt: 'asc' },
    });

    const payloadRows = await prisma.spanPayload.findMany({
      where: { spanId: { in: spans.map((s) => s.id) }, teamId },
    });

    const payloads =
      payloadRows.length > 0
        ? Object.fromEntries(payloadRows.map((p) => [p.spanId, p]))
        : undefined;

    // Each distinct tool list once, however many rounds sent it (PR #799 review).
    const setRows = await prisma.traceToolSet.findMany({
      where: { traceId: trace.id, teamId },
      select: { id: true, tools: true },
    });
    const toolSets = Object.fromEntries(setRows.map((t) => [t.id, t.tools]));

    return { trace, spans, payloads, toolSets };
  }

  /**
   * Lists traces (newest-first, paginated) whose spans reference a given prompt
   * version. Same list shape as {@link listTraces}; no date default — the reverse
   * lineage lists all matching traces.
   *
   * @param teamId - Team scope.
   * @param promptVersionId - The resolved prompt_versions UUID.
   * @param page - 1-based page.
   * @param limit - Page size (capped at 100 upstream).
   * @returns Page of trace list items, the matching count up to the cap, and whether it was capped.
   */
  async tracesForPromptVersion(
    teamId: string,
    promptVersionId: string,
    page: number,
    limit: number,
  ): Promise<{ data: TraceListItem[]; total: number; totalCapped: boolean }> {
    const where = Prisma.sql`t.team_id = ${teamId}::uuid AND EXISTS (SELECT 1 FROM spans s WHERE s.trace_id = t.id AND s.prompt_version_id = ${promptVersionId}::uuid)`;
    return this.withSearchCounts(await this.runList(where, page, limit));
  }
}
