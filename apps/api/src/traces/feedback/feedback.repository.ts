import { Prisma } from '@prisma/client';
import prisma from '../../shared/db/client';
import { FeedbackRow } from '../../shared/db/schema';

/**
 * The author join every read path carries, so the UI can name the team member
 * behind a `developer` row instead of only its source. Null for feedback posted
 * with a team-scoped API key or by an end user, where there is no user row.
 */
const CREATOR_SELECT = { creator: { select: { id: true, displayName: true, email: true } } } as const;

/** A feedback row with its span reference and its author, as every read returns it. */
export type FeedbackRowWithRelations = FeedbackRow & {
  span: { spanRef: string } | null;
  creator: { id: string; displayName: string | null; email: string } | null;
};
import { FeedbackBucket, FeedbackFilters, FeedbackGroupBy, FeedbackSummary } from './feedback.types';
import { buildTraceConditions } from '../filters';

/**
 * Data access for the `trace_feedback` table plus the trace/span lookups the
 * feedback service needs for validation. The only file in this domain that
 * touches Prisma. All queries are team-scoped for isolation.
 */
export class FeedbackRepository {
  /**
   * Inserts one feedback row. `spanId` is the already-resolved internal span
   * UUID (or null for whole-trace feedback) — the service does the ref → UUID
   * resolution before calling this.
   *
   * @param input - team/trace/span ids, the optional rating/label/comment, source, and createdBy.
   * @returns The inserted row.
   */
  async create(input: {
    teamId: string;
    traceId: string;
    spanId: string | null;
    rating: number | null;
    label: string | null;
    comment: string | null;
    source: string;
    createdBy: string | null;
  }): Promise<FeedbackRowWithRelations> {
    return prisma.traceFeedback.create({
      data: {
        teamId: input.teamId,
        traceId: input.traceId,
        spanId: input.spanId,
        rating: input.rating,
        label: input.label,
        comment: input.comment,
        source: input.source,
        createdBy: input.createdBy,
      },
      include: { span: { select: { spanRef: true } }, ...CREATOR_SELECT },
    });
  }

  /**
   * Lists a trace's feedback newest-first, joining the span reference (for rows
   * attached to a span) so the API can echo `spanId` as the OTel ref.
   *
   * @param teamId - Isolation boundary.
   * @param traceId - The trace whose feedback to list.
   */
  async listForTrace(
    teamId: string,
    traceId: string,
  ): Promise<FeedbackRowWithRelations[]> {
    return prisma.traceFeedback.findMany({
      where: { teamId, traceId },
      orderBy: { createdAt: 'desc' },
      include: { span: { select: { spanRef: true } }, ...CREATOR_SELECT },
    });
  }

  /**
   * Builds the WHERE for a filtered feedback search over
   * `trace_feedback f JOIN traces t`.
   *
   * The trace half comes from {@link buildTraceConditions}, so `?prompt_id=` or
   * `?q=` mean exactly what they mean on the trace list. The date window is the
   * one deliberate exception: it is applied to the feedback row rather than to
   * its trace, because a critique is usually written after the run it grades.
   *
   * @param teamId - Isolation boundary, applied to the feedback row itself.
   * @param filters - Resolved feedback filters.
   * @returns One ANDed boolean expression over aliases `f` and `t`.
   */
  private buildFeedWhere(teamId: string, filters: FeedbackFilters): Prisma.Sql {
    const { from, to, ...traceFilters } = filters;

    const conds: Prisma.Sql[] = [
      Prisma.sql`f.team_id = ${teamId}::uuid`,
      ...buildTraceConditions(traceFilters, 't'),
    ];

    if (from) conds.push(Prisma.sql`f.created_at >= ${from}`);
    if (to) conds.push(Prisma.sql`f.created_at < ${to}`);

    if (filters.rating === 'up') conds.push(Prisma.sql`f.rating > 0`);
    if (filters.rating === 'down') conds.push(Prisma.sql`f.rating < 0`);
    if (filters.rating === 'none') conds.push(Prisma.sql`f.rating IS NULL`);

    if (filters.source) conds.push(Prisma.sql`f.source = ${filters.source}`);
    if (filters.label) conds.push(Prisma.sql`f.label = ${filters.label}`);

    if (filters.hasComment === true) conds.push(Prisma.sql`f.comment IS NOT NULL`);
    if (filters.hasComment === false) conds.push(Prisma.sql`f.comment IS NULL`);

    return Prisma.join(conds, ' AND ');
  }

  /**
   * Returns the ids of a team's feedback rows matching `filters`, newest-first.
   *
   * Kept separate from {@link listForTeam} because the dataset builders need
   * "which rows does this criteria select" without a page of hydrated DTOs.
   *
   * @param teamId - Isolation boundary.
   * @param filters - Resolved feedback filters.
   * @param limit - Hard ceiling on how many ids to return.
   * @returns `ids` (newest-first, at most `limit`) and `total`, the full match
   *   count — so a caller can tell the user their criteria selected more than
   *   one request can process.
   */
  async listIdsForTeam(
    teamId: string,
    filters: FeedbackFilters,
    limit: number,
  ): Promise<{ ids: string[]; total: number }> {
    const where = this.buildFeedWhere(teamId, filters);

    const [rows, totalRows] = await Promise.all([
      prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT f.id FROM trace_feedback f JOIN traces t ON t.id = f.trace_id
        WHERE ${where}
        ORDER BY f.created_at DESC, f.id DESC
        LIMIT ${limit}
      `),
      prisma.$queryRaw<{ total: number }[]>(Prisma.sql`
        SELECT COUNT(*)::int AS "total" FROM trace_feedback f JOIN traces t ON t.id = f.trace_id
        WHERE ${where}
      `),
    ]);

    return { ids: rows.map((r) => r.id), total: totalRows[0].total };
  }

  /**
   * Lists a team's feedback newest-first across all traces, filtered and
   * paginated — the raw feed behind the feedback visualization page (T10) and
   * the dataset "add rows" dialog. Joins the span reference the same way
   * {@link listForTrace} does.
   *
   * Two queries by design: a raw one selects the page's ids (the filters reach
   * into `traces`, `spans` and `span_payloads`, which the Prisma query builder
   * cannot express as one readable expression), then the existing `findMany`
   * hydrates them with their span and creator joins so the DTO shape is
   * untouched. Postgres does not promise to preserve the `IN` order, so the
   * newest-first order is restored from the id list rather than assumed.
   *
   * @param teamId - Isolation boundary.
   * @param filters - Resolved feedback filters (all optional).
   * @param page - 1-based page.
   * @param limit - Page size (already capped upstream).
   */
  async listForTeam(
    teamId: string,
    filters: FeedbackFilters,
    page: number,
    limit: number,
  ): Promise<{ data: FeedbackRowWithRelations[]; total: number }> {
    const where = this.buildFeedWhere(teamId, filters);
    const offset = (page - 1) * limit;

    const [idRows, totalRows] = await Promise.all([
      prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT f.id FROM trace_feedback f JOIN traces t ON t.id = f.trace_id
        WHERE ${where}
        ORDER BY f.created_at DESC, f.id DESC
        LIMIT ${limit} OFFSET ${offset}
      `),
      prisma.$queryRaw<{ total: number }[]>(Prisma.sql`
        SELECT COUNT(*)::int AS "total" FROM trace_feedback f JOIN traces t ON t.id = f.trace_id
        WHERE ${where}
      `),
    ]);

    const ids = idRows.map((r) => r.id);
    if (ids.length === 0) return { data: [], total: totalRows[0].total };

    const rows = await prisma.traceFeedback.findMany({
      where: { id: { in: ids }, teamId },
      include: { span: { select: { spanRef: true } }, ...CREATOR_SELECT },
    });

    const byId = new Map(rows.map((r) => [r.id, r]));
    const data = ids
      .map((id) => byId.get(id))
      .filter((r): r is FeedbackRowWithRelations => r !== undefined);

    return { data, total: totalRows[0].total };
  }

  /**
   * Looks up one feedback row, scoped to a team + trace (so a foreign team's or
   * foreign trace's feedback id resolves to null, surfaced by the service as 404).
   *
   * @param teamId - Isolation boundary.
   * @param traceId - The trace the feedback must belong to.
   * @param id - The feedback row id.
   */
  async findByIdForTeamTrace(
    teamId: string,
    traceId: string,
    id: string,
  ): Promise<FeedbackRowWithRelations | null> {
    return prisma.traceFeedback.findFirst({
      where: { id, teamId, traceId },
      include: { span: { select: { spanRef: true } }, ...CREATOR_SELECT },
    });
  }

  /**
   * Updates a feedback row's rating/label/comment in place. Caller (the service)
   * has already resolved the merged values and the ownership check.
   *
   * @param id - The feedback row id.
   * @param data - The full new rating/label/comment (nulls allowed).
   */
  async update(
    id: string,
    data: { rating: number | null; label: string | null; comment: string | null },
  ): Promise<FeedbackRowWithRelations> {
    return prisma.traceFeedback.update({
      where: { id },
      data: { rating: data.rating, label: data.label, comment: data.comment },
      include: { span: { select: { spanRef: true } }, ...CREATOR_SELECT },
    });
  }

  /**
   * Resolves a trace id within a team. Returns null if it does not exist or is in
   * another team (so callers surface 404, not 403).
   *
   * @param teamId - Isolation boundary.
   * @param traceId - The trace UUID to look up.
   */
  async findTraceForTeam(teamId: string, traceId: string): Promise<{ id: string } | null> {
    return prisma.trace.findFirst({ where: { id: traceId, teamId }, select: { id: true } });
  }

  /**
   * Resolves a caller-supplied span reference to the internal span row within a
   * trace. `span_ref` is unique per trace, so `(traceId, spanRef)` is unambiguous.
   *
   * @param traceId - The trace the span must belong to (internal UUID).
   * @param spanRef - The caller-supplied OTel span id.
   * @returns The span's internal id + ref, or null if no such span in this trace.
   */
  async findSpanInTrace(
    traceId: string,
    spanRef: string,
  ): Promise<{ id: string; spanRef: string } | null> {
    return prisma.span.findFirst({
      where: { traceId, spanRef },
      select: { id: true, spanRef: true },
    });
  }

  /**
   * Aggregates feedback by prompt version or by model over a date window.
   * Each feedback row is attributed to every distinct version/model used by its
   * trace's `llm` spans (deduped per trace so one feedback counts once per key).
   * `created_at` window is `[from, to)`. `avgRating` averages non-null ratings;
   * `downCount` counts rating < 0.
   *
   * @param teamId - Team scope.
   * @param params - `from` (inclusive), `to` (exclusive), and the group dimension.
   * @returns The group dimension echoed back plus one bucket per key. Each bucket
   *   carries a human-readable `label` (and `promptId` when grouping by prompt
   *   version) so callers never have to render the raw grouping id.
   */
  async aggregate(
    teamId: string,
    params: { from: Date; to: Date; groupBy: FeedbackGroupBy },
  ): Promise<FeedbackSummary> {
    // `dim` is a validated enum → safe to inject as a raw column identifier.
    const byModel = params.groupBy === 'model';
    const dim: Prisma.Sql = byModel ? Prisma.sql`model` : Prisma.sql`prompt_version_id`;

    // #383: the raw grouping key is a UUID for prompt versions, which is
    // unreadable in the dashboard. Resolve it to "<prompt name> v<n>" here — a
    // left join so a bucket whose version row is gone still reports its counts.
    const labelSelect: Prisma.Sql = byModel
      ? Prisma.sql`sp.dim::text AS "label", NULL::text AS "promptId"`
      : Prisma.sql`COALESCE(p.name || ' v' || pv.version_number, sp.dim::text) AS "label", p.id::text AS "promptId"`;
    const labelJoin: Prisma.Sql = byModel
      ? Prisma.empty
      : Prisma.sql`LEFT JOIN prompt_versions pv ON pv.id = sp.dim
                   LEFT JOIN prompts p ON p.id = pv.prompt_id`;
    const labelGroup: Prisma.Sql = byModel
      ? Prisma.empty
      : Prisma.sql`, p.id, p.name, pv.version_number`;

    const buckets = await prisma.$queryRaw<FeedbackBucket[]>(Prisma.sql`
      SELECT
        sp.dim::text AS "key",
        ${labelSelect},
        COUNT(*)::int AS "count",
        AVG(f.rating)::float8 AS "avgRating",
        COUNT(*) FILTER (WHERE f.rating < 0)::int AS "downCount"
      FROM trace_feedback f
      JOIN (
        SELECT DISTINCT trace_id, ${dim} AS dim
        FROM spans
        WHERE team_id = ${teamId}::uuid AND kind = 'llm' AND ${dim} IS NOT NULL
      ) sp ON sp.trace_id = f.trace_id
      ${labelJoin}
      WHERE f.team_id = ${teamId}::uuid
        AND f.created_at >= ${params.from}
        AND f.created_at < ${params.to}
      GROUP BY sp.dim${labelGroup}
      ORDER BY "label"
    `);

    return { groupBy: params.groupBy, buckets };
  }
}
