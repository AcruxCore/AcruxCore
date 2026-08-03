import { CacheRepository } from './cache.repository';
import type { CacheFlushResponse } from './cache.types';

/**
 * Service for cache management operations exposed over HTTP.
 * The read/write cache path used by the completion pipeline talks to
 * CacheRepository directly; this service backs the management endpoint only.
 */
export class CacheService {
  private readonly repo: CacheRepository;

  constructor() {
    this.repo = new CacheRepository();
  }

  /**
   * Flushes the entire response cache for a team.
   *
   * @param teamId - The team whose cache to clear.
   * @returns The number of cache rows deleted.
   */
  async flushTeam(teamId: string): Promise<CacheFlushResponse> {
    const deleted = await this.repo.flushTeam(teamId);
    return { deleted };
  }
}
