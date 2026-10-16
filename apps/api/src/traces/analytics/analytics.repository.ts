import { Prisma } from '@prisma/client';
import prisma from '../../shared/db/client';
import type {
  GroupBy,
  SpanKind,
  AnalyticsTotals,
  AnalyticsBucket,
  CostPerTrace,
  FeedbackCounts,
  RuleScoreSummary,
  ScoreDay,
} from './analytics.types';

/** Parameters for a single analytics aggregation over spans. */
interface BucketParams {
  from: Date; // inclusive lower bound on started_at
  to: Date; // exclusive upper bound on started_at
  groupBy: GroupBy;
  kind?: SpanKind;
  model?: string;
}

/** Shape of a single raw aggregate row returned by $queryRaw. */
interface RawRow {
  key?: string | null;
  requests: number;
  errorRate: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

/**
 * Read-only analytics over the whole `spans` table (gateway + SDK spans — the
 * superset over G8's gateway-only usage). All queries are team-scoped. Aggregates
 * use raw SQL (`Prisma.sql`) because dynamic group-by, date_trunc, and
 * `percentile_cont` are not expressible in the query builder.
 */
export class AnalyticsRepository {
  /**
   * Maps a group-by dimension to a safe SQL expression. `groupBy` is a validated
   * enum, never raw user input, so the fragment is safe. Aliased columns: `s` =
   * spans, `t` = traces (joined for session_id), `gm` = the gateway model the span's
   * linked gateway request actually served through, `p`/`pv` = the span's linked
   * prompt + prompt version.
   *
   * `model` and `prompt_version` prefer a human label over the raw stored id: a
   * gateway-routed span stores the resolved *upstream* model string (e.g.
   * `gpt-4o-mini-2026-04-09`), never the `publicName` alias the team configured,
   * so this resolves it back via `gateway_request_id -> gateway_model_id`. SDK-
   * reported spans with no linked gateway request (or a since-deleted model) fall
   * back to the raw `s.model` string, which is all that's known for them. Same
   * idea for `prompt_version`: label as "<prompt name> vN" instead of the raw
   * `prompt_version_id` UUID, falling back to the UUID if the join can't resolve.
   *
   * @param groupBy - Validated grouping dimension.
   * @returns A Prisma.Sql fragment used in both SELECT and GROUP BY.
   */
  private groupExpr(groupBy: GroupBy): Prisma.Sql {
    switch (groupBy) {
      case 'day':
        // `AT TIME ZONE 'UTC'` before truncating is load-bearing: `started_at` is a
        // `timestamptz`, so a bare `date_trunc('day', …)` truncates in the Postgres
        // *session* timezone. On any deployment whose session timezone is not UTC that
        // buckets a span into the local calendar day, while `analytics.service.ts` echoes
        // `from`/`to` as UTC-sliced dates — so for the hours where the two dates differ the
        // response could carry a bucket dated after its own `to` (issue #238).
        return Prisma.sql`to_char(date_trunc('day', s.started_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;
      case 'model':
        return Prisma.sql`COALESCE(gm.public_name, s.model)`;
      case 'session':
        return Prisma.sql`t.session_id`;
      case 'prompt_version':
        return Prisma.sql`COALESCE(p.name || ' v' || pv.version_number::text, s.prompt_version_id::text)`;
      case 'span_name':
        // Before #601 a gateway call sent without `x-span-name` was named after its own
        // start time, so grouping those rows by the raw name would give one bucket per
        // call. They share one `(unnamed)` bucket instead; newer rows carry the model name.
        return Prisma.sql`CASE
          WHEN s.name = to_char(s.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          THEN '(unnamed)' ELSE s.name END`;
    }
  }

  /**
   * Aggregates volume / error rate / tokens / cost / latency percentiles over a
   * date range on `started_at`, plus one grouped bucket per group key. Null cost
   * sums as 0; null latency is counted in `requests` but skipped by the
   * percentiles (see the note in the query). Buckets whose group key is NULL
   * (e.g. null model / null session / null prompt_version_id) are omitted.
   *
   * @param teamId - Team scope.
   * @param params - Window, group dimension, and optional kind/model filters.
   * @returns Totals across the range and one bucket per group key.
   */
  async bucket(
    teamId: string,
    params: BucketParams,
  ): Promise<{ totals: AnalyticsTotals; buckets: AnalyticsBucket[] }> {
    const { from, to, groupBy, kind, model } = params;
    const kindFilter = kind ? Prisma.sql`AND s.kind = ${kind}::span_kind` : Prisma.empty;
    const modelFilter = model ? Prisma.sql`AND s.model = ${model}` : Prisma.empty;

    // latency_ms is deliberately NEVER in the WHERE clause. percentile_cont skips
    // NULL latencies on its own, while COUNT(*) counts every span — so a null-
    // latency span is excluded from percentiles yet still counted in `requests`.
    // Adding `AND s.latency_ms IS NOT NULL` here would wrongly drop it from the count.
    // One trace per span (NOT NULL FK) so the JOIN never fans out / double-counts.
    const totalsRows = await prisma.$queryRaw<RawRow[]>(Prisma.sql`
      SELECT
        COUNT(*)::int AS "requests",
        COALESCE(AVG(CASE WHEN s.status = 'error' THEN 1 ELSE 0 END), 0)::float8 AS "errorRate",
        COALESCE(SUM(s.prompt_tokens), 0)::float8 AS "promptTokens",
        COALESCE(SUM(s.completion_tokens), 0)::float8 AS "completionTokens",
        COALESCE(SUM(s.total_tokens), 0)::float8 AS "totalTokens",
        COALESCE(SUM(s.cost_usd), 0)::float8 AS "costUsd",
        percentile_cont(0.5)  WITHIN GROUP (ORDER BY s.latency_ms)::float8 AS "p50",
        percentile_cont(0.95) WITHIN GROUP (ORDER BY s.latency_ms)::float8 AS "p95",
        percentile_cont(0.99) WITHIN GROUP (ORDER BY s.latency_ms)::float8 AS "p99"
      FROM spans s
      JOIN traces t ON t.id = s.trace_id
      WHERE s.team_id = ${teamId}::uuid
        AND s.started_at >= ${from}
        AND s.started_at < ${to}
        ${kindFilter}
        ${modelFilter}
    `);

    const rawBuckets = await prisma.$queryRaw<RawRow[]>(Prisma.sql`
      SELECT
        ${this.groupExpr(groupBy)} AS "key",
        COUNT(*)::int AS "requests",
        COALESCE(AVG(CASE WHEN s.status = 'error' THEN 1 ELSE 0 END), 0)::float8 AS "errorRate",
        COALESCE(SUM(s.prompt_tokens), 0)::float8 AS "promptTokens",
        COALESCE(SUM(s.completion_tokens), 0)::float8 AS "completionTokens",
        COALESCE(SUM(s.total_tokens), 0)::float8 AS "totalTokens",
        COALESCE(SUM(s.cost_usd), 0)::float8 AS "costUsd",
        percentile_cont(0.5)  WITHIN GROUP (ORDER BY s.latency_ms)::float8 AS "p50",
        percentile_cont(0.95) WITHIN GROUP (ORDER BY s.latency_ms)::float8 AS "p95",
        percentile_cont(0.99) WITHIN GROUP (ORDER BY s.latency_ms)::float8 AS "p99"
      FROM spans s
      JOIN traces t ON t.id = s.trace_id
      LEFT JOIN gateway_requests gr ON gr.id = s.gateway_request_id
      LEFT JOIN gateway_models gm ON gm.id = gr.gateway_model_id
      LEFT JOIN prompt_versions pv ON pv.id = s.prompt_version_id
      -- The team filter on the join, not just on the span: a span row carrying
      -- another team's prompt_version_id must resolve to no name at all rather
      -- than to that team's prompt. Ingest refuses to write such a row now, but
      -- a database may already hold one.
      LEFT JOIN prompts p ON p.id = pv.prompt_id AND p.team_id = ${teamId}::uuid
      WHERE s.team_id = ${teamId}::uuid
        AND s.started_at >= ${from}
        AND s.started_at < ${to}
        ${kindFilter}
        ${modelFilter}
      GROUP BY 1
      ORDER BY 1
    `);

    return {
      totals: this.toMetrics(totalsRows[0]),
      buckets: rawBuckets
        .filter((r) => r.key !== null)
        .map((r) => ({ key: r.key as string, ...this.toMetrics(r) })),
    };
  }

  /**
   * The median and p99 cost of one trace in the window. A trace's cost is the sum of its
   * spans' `cost_usd` that pass the same window and kind/model filters as {@link bucket},
   * so a `kind=llm` view gives the model spend per trace. A trace with no priced span sums
   * to NULL and is left out, so unpriced traffic does not pull the percentiles to $0.
   *
   * @param teamId - Team scope.
   * @param params - Window and optional kind/model filters; `groupBy` is ignored.
   * @returns Both percentiles, or nulls when no span is in the window.
   */
  async costPerTrace(teamId: string, params: Omit<BucketParams, 'groupBy'>): Promise<CostPerTrace> {
    const { from, to, kind, model } = params;
    const kindFilter = kind ? Prisma.sql`AND s.kind = ${kind}::span_kind` : Prisma.empty;
    const modelFilter = model ? Prisma.sql`AND s.model = ${model}` : Prisma.empty;
    const rows = await prisma.$queryRaw<Array<{ p50: number | null; p99: number | null }>>(Prisma.sql`
      SELECT
        percentile_cont(0.5)  WITHIN GROUP (ORDER BY cost)::float8 AS "p50",
        percentile_cont(0.99) WITHIN GROUP (ORDER BY cost)::float8 AS "p99"
      FROM (
        SELECT SUM(s.cost_usd) AS cost
        FROM spans s
        WHERE s.team_id = ${teamId}::uuid
          AND s.started_at >= ${from}
          AND s.started_at < ${to}
          ${kindFilter}
          ${modelFilter}
        GROUP BY s.trace_id
      ) per_trace
    `);
    return { p50: rows[0]?.p50 ?? null, p99: rows[0]?.p99 ?? null };
  }

  /**
   * Thumbs feedback and online-eval verdicts recorded in a window, per rule and per UTC day.
   *
   * A rating is a thumb: 1 is up, -1 is down, and feedback with no rating is neither. A
   * verdict with a null `passed` (the judge could not score) is left out of every count.
   *
   * @param teamId - Team scope; both tables are filtered on it.
   * @param from - Inclusive lower bound on `created_at`.
   * @param to - Exclusive upper bound on `created_at`.
   * @returns Window totals for feedback, one row per rule that has a verdict (by name),
   *   and one row per day that has either.
   */
  async scores(
    teamId: string,
    from: Date,
    to: Date,
  ): Promise<{ feedback: FeedbackCounts; rules: RuleScoreSummary[]; days: ScoreDay[] }> {
    const inWindow = Prisma.sql`f.team_id = ${teamId}::uuid AND f.created_at >= ${from} AND f.created_at < ${to}`;
    const feedbackRows = await prisma.$queryRaw<Array<FeedbackCounts>>(Prisma.sql`
      SELECT
        COUNT(*) FILTER (WHERE f.rating = 1)::int AS "up",
        COUNT(*) FILTER (WHERE f.rating = -1)::int AS "down"
      FROM trace_feedback f
      WHERE ${inWindow}
    `);

    const rules = await prisma.$queryRaw<RuleScoreSummary[]>(Prisma.sql`
      SELECT
        r.id::text AS "ruleId",
        r.name AS "name",
        COUNT(*)::int AS "scored",
        COUNT(*) FILTER (WHERE sc.passed)::int AS "passed",
        COUNT(*) FILTER (WHERE NOT sc.passed)::int AS "failed",
        AVG(sc.score)::float8 AS "avgScore"
      FROM eval_rule_scores sc
      JOIN eval_rules r ON r.id = sc.rule_id AND r.team_id = ${teamId}::uuid
      WHERE sc.team_id = ${teamId}::uuid
        AND sc.created_at >= ${from} AND sc.created_at < ${to}
        AND sc.passed IS NOT NULL
      GROUP BY r.id, r.name
      ORDER BY r.name, r.id
    `);

    // UTC days, for the same reason as `groupExpr('day')` (issue #238).
    const days = await prisma.$queryRaw<ScoreDay[]>(Prisma.sql`
      SELECT
        day AS "day",
        SUM(up)::int AS "up",
        SUM(down)::int AS "down",
        SUM(passed)::int AS "passed",
        SUM(failed)::int AS "failed"
      FROM (
        SELECT
          to_char(date_trunc('day', f.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
          (f.rating = 1)::int AS up, (f.rating = -1)::int AS down, 0 AS passed, 0 AS failed
        FROM trace_feedback f
        WHERE ${inWindow} AND f.rating IN (1, -1)
        UNION ALL
        SELECT
          to_char(date_trunc('day', sc.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD'),
          0, 0, (sc.passed)::int, (NOT sc.passed)::int
        FROM eval_rule_scores sc
        WHERE sc.team_id = ${teamId}::uuid AND sc.created_at >= ${from} AND sc.created_at < ${to}
          AND sc.passed IS NOT NULL
      ) events
      GROUP BY day
      ORDER BY day
    `);

    return { feedback: feedbackRows[0] ?? { up: 0, down: 0 }, rules, days };
  }

  /** Maps a raw aggregate row to the metrics DTO, nesting the latency percentiles. */
  private toMetrics(r: RawRow): AnalyticsTotals {
    return {
      requests: r.requests,
      errorRate: r.errorRate,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      totalTokens: r.totalTokens,
      costUsd: r.costUsd,
      latencyMs: { p50: r.p50, p95: r.p95, p99: r.p99 },
    };
  }
}
