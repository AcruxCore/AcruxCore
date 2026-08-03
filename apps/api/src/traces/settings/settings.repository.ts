import { Prisma } from '@prisma/client';
import prisma from '../../shared/db/client';
import type { TeamTraceSettings } from '../../shared/db/schema';

/**
 * Data access for the `team_trace_settings` table (one row per team, lazily
 * created). The only file in the settings domain that touches Prisma.
 */
export class TraceSettingsRepository {
  /**
   * Reads a team's trace settings row, or null when none exists yet (the service
   * treats absent as the default: capture off).
   *
   * @param teamId - The team's UUID.
   * @param tx - Optional transaction client (used by the gateway hook).
   */
  async get(teamId: string, tx?: Prisma.TransactionClient): Promise<TeamTraceSettings | null> {
    const client = tx ?? prisma;
    return client.teamTraceSettings.findUnique({ where: { teamId } });
  }

  /**
   * Creates or updates the team's `capture_payloads` flag; `updated_at` is bumped
   * automatically by Prisma's `@updatedAt`.
   *
   * @param teamId - The team's UUID.
   * @param capturePayloads - The new capture default.
   * @param tx - Optional transaction client.
   * @returns The upserted settings row.
   */
  async upsert(
    teamId: string,
    capturePayloads: boolean,
    tx?: Prisma.TransactionClient,
  ): Promise<TeamTraceSettings> {
    const client = tx ?? prisma;
    return client.teamTraceSettings.upsert({
      where: { teamId },
      create: { teamId, capturePayloads },
      update: { capturePayloads },
    });
  }
}
