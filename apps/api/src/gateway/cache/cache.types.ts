import type { NormalizedResponse } from '../providers/types';

/**
 * A hydrated cache row as returned by CacheRepository.lookup — the stored,
 * OpenAI-shaped response plus the token counts recorded at store time (so a
 * cache hit can copy them into its gateway_requests row).
 */
export interface StoredCacheRow {
  response: NormalizedResponse;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Response body for DELETE /api/v1/gateway/cache.
 */
export interface CacheFlushResponse {
  deleted: number;
}
