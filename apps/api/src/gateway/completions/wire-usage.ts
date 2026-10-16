import type { Usage } from '../providers/types';

/** `usage` as the gateway sends it: the flat counts plus OpenAI's nested detail objects. */
export interface WireUsage extends Usage {
  prompt_tokens_details?: { cached_tokens: number };
  completion_tokens_details?: { reasoning_tokens: number };
}

/**
 * Adds OpenAI's standard nested usage fields to the gateway's flat ones.
 *
 * The gateway is called with the official OpenAI SDKs, which read the cached count from
 * `usage.prompt_tokens_details.cached_tokens` and the reasoning count from
 * `usage.completion_tokens_details.reasoning_tokens`. The adapters keep only the flat
 * `cached_tokens` / `reasoning_tokens`, so those callers saw no counts at all. The flat
 * fields stay, because our own SDKs and existing callers read them.
 *
 * @param usage - The usage an adapter normalized.
 * @returns The same counts, with a nested object for each one the provider reported.
 */
export function toWireUsage(usage: Usage): WireUsage {
  return {
    ...usage,
    ...(usage.cached_tokens !== undefined ? { prompt_tokens_details: { cached_tokens: usage.cached_tokens } } : {}),
    ...(usage.reasoning_tokens !== undefined
      ? { completion_tokens_details: { reasoning_tokens: usage.reasoning_tokens } }
      : {}),
  };
}
