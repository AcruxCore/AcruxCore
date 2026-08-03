import type { Prisma } from '@prisma/client';
import prisma from '../../shared/db/client';
import type { NormalizedResponse, Usage } from '../providers/types';
import type { StoredCacheRow } from './cache.types';

/**
 * Repository for the per-team response cache (gateway_cache). The only file in
 * the cache domain that imports prisma. All methods are team-scoped.
 */
export class CacheRepository {
  /**
   * Looks up a non-expired cache entry for a team + key.
   *
   * A row whose `expires_at <= now()` is treated as a miss regardless of whether
   * a cleanup has removed it yet, so stale entries are never served.
   *
   * @param teamId - The calling team's id (partition key).
   * @param cacheKey - The SHA-256 request key from computeCacheKey.
   * @returns The stored response + token counts, or undefined on a miss.
   */
  async lookup(teamId: string, cacheKey: string): Promise<StoredCacheRow | undefined> {
    const row = await prisma.gatewayCache.findFirst({
      where: { teamId, cacheKey, expiresAt: { gt: new Date() } },
      select: { response: true, promptTokens: true, completionTokens: true },
    });
    if (!row) return undefined;
    return {
      response: row.response as unknown as NormalizedResponse,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
    };
  }

  /**
   * Stores (or refreshes) a cache entry with a fresh TTL. Upserts on the
   * (team_id, cache_key) unique constraint: a repeat store for the same key
   * updates the response, token counts, and expiry in place rather than inserting.
   *
   * @param teamId - The calling team's id.
   * @param cacheKey - The SHA-256 request key.
   * @param response - The normalized (OpenAI-shaped) response body to cache.
   * @param usage - Provider-reported token usage recorded alongside the response.
   * @param ttlSeconds - Time-to-live in seconds; expires_at = now() + ttlSeconds.
   */
  async store(
    teamId: string,
    cacheKey: string,
    response: NormalizedResponse,
    usage: Usage,
    ttlSeconds: number,
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const responseJson = response as unknown as Prisma.InputJsonValue;
    await prisma.gatewayCache.upsert({
      where: { teamId_cacheKey: { teamId, cacheKey } },
      create: {
        teamId,
        cacheKey,
        response: responseJson,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        expiresAt,
      },
      update: {
        response: responseJson,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        expiresAt,
      },
    });
  }

  /**
   * Deletes every cache row for a team (used by DELETE /gateway/cache).
   *
   * @param teamId - The team whose cache to flush.
   * @returns The number of rows deleted.
   */
  async flushTeam(teamId: string): Promise<number> {
    const result = await prisma.gatewayCache.deleteMany({ where: { teamId } });
    return result.count;
  }
}
