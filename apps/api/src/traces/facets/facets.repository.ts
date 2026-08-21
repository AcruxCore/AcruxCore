import prisma from '../../shared/db/client';
import { Prisma } from '@prisma/client';

/** Cap on distinct facet values returned — a discovery/UI-picker aid, not a report. */
const FACET_LIMIT = 200;

/**
 * Read-only distinct-value queries over `traces` for facet discovery (T8) — lets
 * the frontend populate its tag/metadata filter pickers without a hardcoded list.
 * Cheap sequential scans at dogfood volume (Phase 3 FAQ Q4); revisit if/when
 * partitioning lands.
 */
export class TraceFacetsRepository {
  /**
   * Distinct tags in use for the team, alphabetical.
   *
   * @param teamId - Team scope.
   */
  async listTags(teamId: string): Promise<string[]> {
    const rows = await prisma.$queryRaw<{ tag: string }[]>(Prisma.sql`
      SELECT DISTINCT unnest(tags) AS tag FROM traces
      WHERE team_id = ${teamId}::uuid
      ORDER BY tag
      LIMIT ${FACET_LIMIT}
    `);
    return rows.map((r) => r.tag);
  }

  /**
   * Distinct resolved models seen on the team's `llm` spans, alphabetical.
   *
   * This is the value `eval-rule-matcher.ts`'s `filter.model` is compared
   * against (`span.model`, the RESOLVED/upstream model id — e.g.
   * `gpt-4o-mini-2024-07-18` — not a `GatewayModel.publicName` like
   * `gpt-4o-mini`). A picker sourced from `GatewayModel` would offer values
   * that can never match a real span (phase-5-faq).
   *
   * @param teamId - Team scope.
   */
  async listModels(teamId: string): Promise<string[]> {
    const rows = await prisma.$queryRaw<{ model: string }[]>(Prisma.sql`
      SELECT DISTINCT model FROM spans
      WHERE team_id = ${teamId}::uuid AND kind = 'llm' AND model IS NOT NULL
      ORDER BY model
      LIMIT ${FACET_LIMIT}
    `);
    return rows.map((r) => r.model);
  }

  /**
   * Distinct metadata keys in use for the team, alphabetical.
   *
   * @param teamId - Team scope.
   */
  async listMetadataKeys(teamId: string): Promise<string[]> {
    const rows = await prisma.$queryRaw<{ key: string }[]>(Prisma.sql`
      SELECT DISTINCT jsonb_object_keys(metadata) AS key FROM traces
      WHERE team_id = ${teamId}::uuid
      ORDER BY key
      LIMIT ${FACET_LIMIT}
    `);
    return rows.map((r) => r.key);
  }

  /**
   * Distinct string values seen for one metadata key, for the team, alphabetical.
   * Uses `jsonb_exists` (not the `?` operator) to sidestep Prisma's raw-query
   * placeholder scanner colliding with jsonb's `?` operator.
   *
   * @param teamId - Team scope.
   * @param key - The metadata key to enumerate values for.
   */
  async listMetadataValues(teamId: string, key: string): Promise<string[]> {
    const rows = await prisma.$queryRaw<{ value: string }[]>(Prisma.sql`
      SELECT DISTINCT metadata->>${key} AS value FROM traces
      WHERE team_id = ${teamId}::uuid
        AND jsonb_exists(metadata, ${key})
        AND metadata->>${key} IS NOT NULL
      ORDER BY value
      LIMIT ${FACET_LIMIT}
    `);
    return rows.map((r) => r.value);
  }
}
