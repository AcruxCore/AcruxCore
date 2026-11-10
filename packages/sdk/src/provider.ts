import { acruxcoreError } from './error';
import type { ProviderConfig, ProviderKind } from './types';

/** The values `provider.kind` may take. Checked at runtime, since a cast or plain JS
 * can pass anything. */
const PROVIDER_KINDS: readonly ProviderKind[] = ['openai', 'openai_compatible'];

/**
 * Best-effort display label for a BYO provider, derived from its base URL's
 * hostname — not a validated enum. Used only for the span's `provider` field
 * so gateway and BYO traces can be filtered/grouped the same way in the
 * dashboard.
 *
 * Display only. The wire format never reads it: `byoMaxTokensField` parses the host
 * itself, so a change to this label cannot change what is sent.
 *
 * @param baseUrl - The BYO provider's base URL.
 * @returns The base URL's hostname, unmodified.
 * @throws {TypeError} When `baseUrl` does not parse; `checkProviderConfig` refuses
 *   such a URL before any call reaches this.
 */
export function inferProviderName(baseUrl: string): string {
  return new URL(baseUrl).hostname;
}

/**
 * Refuses a BYO provider config that cannot be sent, before anything is sent.
 *
 * @param provider - The BYO provider for this call.
 * @throws {acruxcoreError} `MISSING_API_KEY` or `MISSING_BASE_URL` when either is empty.
 *   `VALIDATION_ERROR` when `baseUrl` is not an http(s) URL with a host, or when `kind`
 *   is set to anything but `'openai'` or `'openai_compatible'`. A near-miss such as
 *   `'OpenAI'` is refused rather than ignored, since ignoring it would silently send
 *   the wrong field name.
 */
export function checkProviderConfig(provider: ProviderConfig): void {
  if (!provider.apiKey) {
    throw new acruxcoreError('acruxcore: provider.apiKey is required for a BYO (direct-provider) call.', 'MISSING_API_KEY');
  }
  if (!provider.baseUrl) {
    throw new acruxcoreError('acruxcore: provider.baseUrl is required for a BYO (direct-provider) call.', 'MISSING_BASE_URL');
  }
  if (parseHost(provider.baseUrl) === undefined) {
    throw new acruxcoreError(`acruxcore: provider.baseUrl "${provider.baseUrl}" is not a valid http(s) URL.`, 'VALIDATION_ERROR');
  }
  if ('kind' in provider && provider.kind !== undefined && !PROVIDER_KINDS.includes(provider.kind)) {
    throw new acruxcoreError(
      `acruxcore: provider.kind is ${JSON.stringify(provider.kind)}; it must be 'openai' or 'openai_compatible', or left out.`,
      'VALIDATION_ERROR',
    );
  }
}

/**
 * The body field a BYO call uses for the caller's `maxTokens`.
 *
 * OpenAI renamed `max_tokens` to `max_completion_tokens`, and its reasoning models
 * (gpt-5, the o-series) refuse the old name with a 400. Every OpenAI model accepts the
 * new name. Many OpenAI-compatible servers know only the old name. This is the same
 * split the gateway's OpenAI adapter makes between `openai` and `openai_compatible`.
 * A gateway call never asks: it always sends `max_tokens`, which the gateway maps per
 * provider.
 *
 * `provider.kind` decides when it is set, which covers Azure OpenAI and proxies in front
 * of OpenAI. When it is not set, the host decides: OpenAI's own hosts get the new name.
 * A base URL with no parseable host gets `max_tokens`; `checkProviderConfig` refuses it
 * before the request is sent.
 *
 * @param provider - The BYO provider for this call.
 * @returns `'max_completion_tokens'` or `'max_tokens'`.
 */
export function byoMaxTokensField(provider: ProviderConfig): 'max_tokens' | 'max_completion_tokens' {
  if (provider.kind) return provider.kind === 'openai' ? 'max_completion_tokens' : 'max_tokens';
  const host = parseHost(provider.baseUrl);
  return host !== undefined && isOpenAiHost(host) ? 'max_completion_tokens' : 'max_tokens';
}

/**
 * A hint to add to a BYO provider's error when it refused `max_tokens` and asked for
 * `max_completion_tokens`: the case of a proxy or Azure in front of OpenAI, which the
 * host check cannot recognise.
 *
 * @param sent - The body the SDK sent.
 * @param errorBody - The provider's parsed error body, or `undefined`.
 * @returns The hint, starting with `' — '`, or `''` when it does not apply.
 */
export function maxTokensRefusalHint(sent: Record<string, unknown>, errorBody: unknown): string {
  if (!('max_tokens' in sent) || errorBody === undefined) return '';
  if (!JSON.stringify(errorBody).includes('max_completion_tokens')) return '';
  return " — this provider wants max_completion_tokens; set provider.kind to 'openai' to send maxTokens under that name.";
}

/**
 * The hostname of an http(s) URL, or `undefined` when there is none. A probe, not error
 * handling: callers decide what a bad URL means. (`URL.canParse` would say this without
 * a try, but it needs Node 18.17, and the SDK supports 18.0.)
 */
function parseHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) return undefined;
    return parsed.hostname;
  } catch {
    return undefined;
  }
}

/**
 * True when a hostname is one of OpenAI's own API hosts: `api.openai.com`, or a
 * data-residency host under it such as `eu.api.openai.com`. A trailing dot (the
 * fully-qualified form) is ignored. `URL` already lower-cases the hostname.
 */
function isOpenAiHost(hostname: string): boolean {
  const host = hostname.replace(/\.$/, '');
  return host === 'api.openai.com' || host.endsWith('.api.openai.com');
}
