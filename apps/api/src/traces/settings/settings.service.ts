import { TraceSettingsRepository } from './settings.repository';
import type { TraceSettingsDto } from './settings.types';
import { audit } from '../../shared/audit';
import prisma from '../../shared/db/client';

/**
 * Business logic for team trace settings: reads with a lazy default (capture on
 * when no row exists) and writes via upsert, emitting a `trace_settings_updated`
 * audit event on change.
 */
export class TraceSettingsService {
  constructor(private readonly repo: TraceSettingsRepository) {}

  /**
   * Returns the team's trace settings, defaulting to `{ capturePayloads: true,
   * updatedAt: null }` when no row exists yet.
   *
   * @param teamId - The current team's UUID.
   */
  async get(teamId: string): Promise<TraceSettingsDto> {
    const row = await this.repo.get(teamId);
    if (!row) return { capturePayloads: true, updatedAt: null };
    return { capturePayloads: row.capturePayloads, updatedAt: row.updatedAt };
  }

  /**
   * Upserts the payload-capture default and emits `trace_settings_updated`.
   *
   * @param teamId - The team whose setting is changing.
   * @param actorId - The owner/admin performing the change (for audit).
   * @param capturePayloads - The new capture default.
   * @returns The updated settings.
   */
  async update(teamId: string, actorId: string, capturePayloads: boolean): Promise<TraceSettingsDto> {
    const row = await this.repo.upsert(teamId, capturePayloads);
    await audit(prisma, {
      teamId,
      actorId,
      event: 'trace_settings_updated',
      metadata: { capturePayloads },
    });
    return { capturePayloads: row.capturePayloads, updatedAt: row.updatedAt };
  }
}
