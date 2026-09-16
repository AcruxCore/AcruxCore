import { createHash } from 'node:crypto';
import type { NormalizedRequest } from '../providers/types';

/**
 * Computes the exact-match cache key for a normalized gateway request.
 *
 * The key is the SHA-256 hex digest of a canonical JSON object built from the
 * request fields that affect the model output: model, messages (in order), the
 * four sampling params, `response_format`, and the declared `tools` /
 * `tool_choice`. Optional params that are absent
 * are normalized to `null` so an omitted field and an explicit-null field
 * collide (they mean the same thing to the provider). `response_format` is
 * included so a `json_schema`/`json_object` request and an otherwise-identical
 * plain-text request never collide on the same cache row — one asks the model
 * for structured output, the other for free text, and serving one's cached
 * response for the other would hand a caller either invalid JSON or a broken
 * schema match.
 *
 * `teamId` is accepted so the signature matches the conventions contract, but it
 * is deliberately NOT part of the hash: teams are partitioned by the `team_id`
 * column and the `UNIQUE(team_id, cache_key)` constraint, so the same request
 * from two teams yields the same key and lands in two separate rows.
 *
 * @param teamId - The calling team's id. Not hashed; present for signature symmetry.
 * @param req - The normalized (OpenAI-shaped) request.
 * @returns A 64-character lowercase hex SHA-256 digest.
 */
export function computeCacheKey(teamId: string, req: NormalizedRequest): string {
  const canonical = JSON.stringify({
    model: req.model,
    messages: req.messages,
    temperature: req.temperature ?? null,
    max_tokens: req.max_tokens ?? null,
    top_p: req.top_p ?? null,
    stop: req.stop ?? null,
    response_format: req.response_format ?? null,
    // Part of the key because they change what the model may answer with. Without
    // them a plain question and the same question carrying a tool list hashed
    // identically, so a cached prose answer was replayed to a caller that asked
    // for a tool call — the model never got to call it and the agent loop simply
    // stopped, with no error anywhere. `response_format` cannot stand in for this:
    // `assertResponseFormatToolsCompatible` guarantees the two are never both set.
    // Hashed in the order given, not sorted: the order a caller declares tools in
    // is part of the request the provider sees.
    tools: req.tools ?? null,
    tool_choice: req.tool_choice ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
