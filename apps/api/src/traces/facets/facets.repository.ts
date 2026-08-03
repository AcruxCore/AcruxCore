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
