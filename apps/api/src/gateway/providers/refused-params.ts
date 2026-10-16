import { ProviderError } from './adapter';
import type { NormalizedRequest } from './types';

/** A 400 that names the field. */
const NAMES_REASONING_EFFORT = /reasoning[_\s-]?effort/i;

/**
 * Words a provider uses when the parameter itself is not accepted, as opposed to its value.
 * OpenAI: "Unsupported parameter: 'reasoning_effort' is not supported with this model" and
 * "Unrecognized request argument supplied: reasoning_effort". z.ai's answer to a bad value,
 * "reasoning_effort must be one of: none, minimal, …", names the field too, and must not match.
 */
const SAYS_UNSUPPORTED = /unsupported|not supported|unrecognized|unrecognised|unknown|not allowed|not permitted|extra (inputs|fields)/i;

/**
 * The request to retry with when a deployment refused `reasoning_effort`, or null when
 * the error is not that refusal.
 *
 * Until issue #593 the gateway dropped `reasoning_effort`, so a model that does not take
 * it (gpt-4o, say) still answered. Forwarding the field made such a model answer 400, and
 * a provider 400 ends a call at once, so a gpt-5 → gpt-4o fallback chain stopped working.
 * Retrying that one deployment without the field keeps the call working, and the caller is
 * told in `x-gateway-params-ignored`.
 *
 * Only a 400 whose message names the field and says it is not supported counts. A 400 for
 * anything else, or for a value the model does not know (z.ai: "reasoning_effort must be
 * one of: …"), stays the caller's error rather than being answered at default effort.
 *
 * @param req - The request the deployment refused.
 * @param err - The error it answered with.
 * @returns The same request without `reasoning_effort`, or null when no retry applies.
 */
export function withoutRefusedReasoningEffort(req: NormalizedRequest, err: unknown): NormalizedRequest | null {
  if (!(err instanceof ProviderError) || err.status !== 400 || req.reasoning_effort === undefined) return null;
  const said = err.detail ?? '';
  if (!NAMES_REASONING_EFFORT.test(said) || !SAYS_UNSUPPORTED.test(said)) return null;
  const { reasoning_effort: _dropped, ...rest } = req;
  return rest;
}
