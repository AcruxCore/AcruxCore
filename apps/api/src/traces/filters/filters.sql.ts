import { Prisma } from '@prisma/client';
import type { TraceFilters } from './filters.types';

/** Table aliases are code-controlled, never user input; this makes that explicit. */
const SAFE_ALIAS = /^[a-z_][a-z0-9_]*$/;

/**
 * Builds the SQL conditions for one free-text search, honouring its scope.
 *
 * The span half is a single `EXISTS` with a LEFT JOIN onto `span_payloads`, so
 * a trace whose payloads were never captured still matches on span name or
 * attributes instead of being excluded by an inner join.
 *
 * @param t - The already-validated `traces` alias, as raw SQL.
 * @param q - The search term (non-empty).
 * @param scope - Which parts of the trace to search.
 * @returns One parenthesised boolean expression.
 */
function buildSearchCondition(t: Prisma.Sql, q: string, scope: TraceFilters['qIn']): Prisma.Sql {
  const like = `%${q}%`;
  const searchesName = scope === 'all' || scope === 'name';

  const spanParts: Prisma.Sql[] = [];
  if (searchesName) spanParts.push(Prisma.sql`s.name ILIKE ${like}`);
  if (scope === 'all') spanParts.push(Prisma.sql`s.attributes::text ILIKE ${like}`);
  if (scope === 'all' || scope === 'input') spanParts.push(Prisma.sql`p.input::text ILIKE ${like}`);
  if (scope === 'all' || scope === 'output') spanParts.push(Prisma.sql`p.output::text ILIKE ${like}`);

  const spanExists = Prisma.sql`EXISTS (
    SELECT 1 FROM spans s
    LEFT JOIN span_payloads p ON p.span_id = s.id
    WHERE s.trace_id = ${t}.id AND (${Prisma.join(spanParts, ' OR ')})
  )`;

  return searchesName
    ? Prisma.sql`(${t}.name ILIKE ${like} OR ${spanExists})`
    : Prisma.sql`(${spanExists})`;
}

/**
 * Translates {@link TraceFilters} into SQL conditions over an aliased `traces`
 * row. Every surface that can reach a `traces` row filters through this, so the
 * trace list, the feedback feed and the dataset builders all speak one filter
 * language and gain a new filter at the same time.
 *
 * Team scoping is deliberately NOT included — each caller adds its own, because
 * the column to scope on differs (`t.team_id` on the trace list, the feedback
 * row's own `team_id` on the feedback feed) and an isolation boundary should be
 * visible at its call site rather than buried in a shared helper.
 *
 * Span-level filters use `EXISTS` sub-queries so a trace appears once no matter
 * how many of its spans match.
 *
 * @param filters - The resolved filters; every field is optional.
 * @param alias - The `traces` alias in the caller's query. Must be a plain
 *   identifier — this is interpolated raw, and is never caller-supplied.
 * @returns Zero or more boolean expressions, to be ANDed together by the caller.
 * @throws {Error} If `alias` is not a plain lowercase SQL identifier.
 */
export function buildTraceConditions(filters: TraceFilters, alias = 't'): Prisma.Sql[] {
  if (!SAFE_ALIAS.test(alias)) throw new Error(`Unsafe SQL alias: ${alias}`);
  const t = Prisma.raw(alias);
  const conds: Prisma.Sql[] = [];

  if (filters.from) conds.push(Prisma.sql`${t}.created_at >= ${filters.from}`);
  if (filters.to) conds.push(Prisma.sql`${t}.created_at < ${filters.to}`);
  if (filters.status) conds.push(Prisma.sql`${t}.status = ${filters.status}::span_status`);
  if (filters.sessionId) conds.push(Prisma.sql`${t}.session_id = ${filters.sessionId}`);

  // All three read `spans.attributes`, written by the shared classifier in
  // `traces/spans/span-failure.ts`. `->>` rather than `->` so the comparison is against
  // text. Key existence goes through `jsonb_exists(...)` rather than the `?` operator,
  // because a bare `?` in a raw query is ambiguous with a driver placeholder.
  if (filters.errorType) {
    conds.push(
      Prisma.sql`EXISTS (SELECT 1 FROM spans s WHERE s.trace_id = ${t}.id AND s.attributes->>'errorType' = ${filters.errorType})`,
    );
  }
  // Equality on the key, not a substring of the JSON: `q=location_not_found` also matches
  // that text inside an unrelated attribute or a captured payload, which is exactly why
  // it cannot be used to count one failure mode.
  if (filters.errorCode) {
    conds.push(
      Prisma.sql`EXISTS (SELECT 1 FROM spans s WHERE s.trace_id = ${t}.id AND s.attributes->>'errorCode' = ${filters.errorCode})`,
    );
  }
  if (filters.hasWarning !== undefined) {
    const exists = Prisma.sql`EXISTS (SELECT 1 FROM spans s WHERE s.trace_id = ${t}.id AND jsonb_exists(s.attributes, 'warning'))`;
    conds.push(filters.hasWarning ? exists : Prisma.sql`NOT ${exists}`);
  }

  if (filters.model) {
    conds.push(
      Prisma.sql`EXISTS (SELECT 1 FROM spans s WHERE s.trace_id = ${t}.id AND s.model = ${filters.model})`,
    );
  }
  if (filters.promptVersionId) {
    conds.push(
      Prisma.sql`EXISTS (SELECT 1 FROM spans s WHERE s.trace_id = ${t}.id AND s.prompt_version_id = ${filters.promptVersionId}::uuid)`,
    );
  }
  // One join out from the version: "traces that used any version of this prompt".
  // This is the filter an operator actually reaches for — nobody remembers which
  // version id was live last Tuesday.
  if (filters.promptId) {
    conds.push(
      Prisma.sql`EXISTS (
        SELECT 1 FROM spans s
        JOIN prompt_versions pv ON pv.id = s.prompt_version_id
        WHERE s.trace_id = ${t}.id AND pv.prompt_id = ${filters.promptId}::uuid
      )`,
    );
  }

  if (filters.minCostUsd !== undefined) {
    conds.push(Prisma.sql`${t}.total_cost_usd >= ${filters.minCostUsd}`);
  }
  if (filters.minTokens !== undefined) {
    conds.push(Prisma.sql`${t}.total_tokens >= ${filters.minTokens}`);
  }
  if (filters.minLatencyMs !== undefined) {
    conds.push(
      Prisma.sql`(${t}.ended_at IS NOT NULL AND EXTRACT(EPOCH FROM (${t}.ended_at - ${t}.started_at)) * 1000 >= ${filters.minLatencyMs})`,
    );
  }

  if (filters.q) {
    conds.push(buildSearchCondition(t, filters.q, filters.qIn ?? 'all'));
  }

  if (filters.tags && filters.tags.length > 0) {
    conds.push(Prisma.sql`${t}.tags @> ARRAY[${Prisma.join(filters.tags)}]::text[]`);
  }
  if (filters.metadata && Object.keys(filters.metadata).length > 0) {
    conds.push(Prisma.sql`${t}.metadata @> ${JSON.stringify(filters.metadata)}::jsonb`);
  }

  if (filters.ruleId) {
    conds.push(
      Prisma.sql`EXISTS (SELECT 1 FROM eval_rule_scores ers WHERE ers.trace_id = ${t}.id AND ers.rule_id = ${filters.ruleId}::uuid)`,
    );
  }
  if (filters.minScore !== undefined) {
    conds.push(
      Prisma.sql`EXISTS (SELECT 1 FROM eval_rule_scores ers WHERE ers.trace_id = ${t}.id AND ers.score >= ${filters.minScore})`,
    );
  }
  if (filters.maxScore !== undefined) {
    conds.push(
      Prisma.sql`EXISTS (SELECT 1 FROM eval_rule_scores ers WHERE ers.trace_id = ${t}.id AND ers.score <= ${filters.maxScore})`,
    );
  }

  return conds;
}
