import { getAdapter } from './adapter';
import type { NormalizedRequest } from './types';

/**
 * Names the request fields the serving provider's adapter accepted but did not send.
 *
 * Each adapter declares its own `unsentParams`, so this list comes from the code that drops
 * the fields rather than from a second list kept in step by hand. The caller is told in
 * `x-gateway-params-ignored` rather than left to guess why the model ignored a field
 * (issue #593).
 *
 * @param provider - The provider of the connection that served the call.
 * @param req - The request as sent to the adapter.
 * @returns The declared fields that this request set, in the adapter's order; empty for an
 *   unknown provider, since this only feeds a response header.
 */
export function unappliedParams(provider: string, req: Partial<NormalizedRequest>): string[] {
  let unsent: ReadonlyArray<keyof NormalizedRequest>;
  try {
    unsent = getAdapter(provider).unsentParams;
  } catch {
    return [];
  }
  return unsent.filter((field) => req[field] !== undefined);
}
