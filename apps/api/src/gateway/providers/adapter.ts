import type { NormalizedRequest, NormalizedResponse, ProviderCredentials, StreamChunk } from './types';
import { openaiAdapter, openaiCompatibleAdapter } from './openai.adapter';
import { anthropicAdapter } from './anthropic.adapter';
import { geminiAdapter } from './gemini.adapter';

/** Default per-request upstream timeout (ms). Adapters abort the fetch after this. */
export const GATEWAY_TIMEOUT_MS = 60_000;

/**
 * A provider adapter maps the canonical request to a specific provider's wire format,
 * calls it, and normalizes the response (including token usage) back to OpenAI shape.
 */
export interface ProviderAdapter {
  readonly provider: 'openai' | 'anthropic' | 'openai_compatible' | 'gemini';
  /**
   * Perform a non-streaming chat completion.
   * @throws {ProviderError} On any provider HTTP error, timeout, or network failure.
   */
  chatCompletion(req: NormalizedRequest, creds: ProviderCredentials): Promise<NormalizedResponse>;
  /**
   * Stream a chat completion as normalized OpenAI-style delta chunks.
   *
   * @param req - Canonical request; the adapter sets provider streaming flags itself.
   * @param creds - Decrypted provider credentials (apiKey, optional baseUrl).
   * @param signal - Optional abort signal; when it fires, the underlying provider
   *   stream is cancelled (used by the pipeline on client disconnect).
   * @returns An async iterable of {@link StreamChunk}; the final chunk carries `usage` when the provider reports it.
   * @throws {ProviderError} Before the first chunk on an HTTP/network failure; mid-stream if the connection drops.
   */
  streamChatCompletion(
    req: NormalizedRequest,
    creds: ProviderCredentials,
    signal?: AbortSignal,
  ): AsyncIterable<StreamChunk>;
}

/** Longest provider error body forwarded to the caller; the rest is only logged. */
export const MAX_PROVIDER_DETAIL = 800;

/**
 * The provider's own error body, trimmed for forwarding to the caller.
 *
 * Providers answer a 4xx with the actionable sentence — *"In context=('properties','b'),
 * 'required' is required to be supplied and to be an array including every key in
 * properties"* names the exact field. Adapters read that body to log it and then threw it
 * away, leaving the caller one opaque sentence and a guess (issue #356).
 *
 * A JSON `{ error: { message } }` is unwrapped to just the message; anything else is
 * passed through as text. Whitespace is collapsed because the body may be pretty-printed
 * and this ends up inside a single-line error message.
 *
 * @param detail - Raw response body text, possibly empty.
 * @returns A single-line summary, or `undefined` when there was nothing usable.
 */
export function summarizeProviderDetail(detail: string): string | undefined {
  const raw = detail?.trim();
  if (!raw) return undefined;
  let text = raw;
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown } | string };
    const inner = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
    if (typeof inner === 'string' && inner.trim()) text = inner.trim();
  } catch {
    // Not JSON — forward the text as-is.
  }
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_PROVIDER_DETAIL
    ? `${collapsed.slice(0, MAX_PROVIDER_DETAIL)}…`
    : collapsed;
}

/**
 * Error thrown by adapters on any upstream failure. `status` is the provider HTTP
 * status (or 502/504 for network/timeout); `retriable` (429/5xx/network) is consumed
 * by G5 retry/fallback. The gateway service maps `status === 504` → GatewayTimeoutError
 * and everything else → BadGatewayError.
 *
 * `detail` is the provider's own error body, summarised by
 * {@link summarizeProviderDetail}. It is forwarded to the caller only for a 4xx, where
 * the provider is describing the caller's own malformed request and so has nothing to
 * leak; a 5xx stays flattened.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly providerCode?: string,
    public readonly retriable = false,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
    Object.setPrototypeOf(this, ProviderError.prototype);
  }
}

const REGISTRY: Record<string, ProviderAdapter> = {
  openai: openaiAdapter,
  openai_compatible: openaiCompatibleAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
};

/**
 * Resolve a provider-kind string to its adapter singleton.
 *
 * @param provider - One of 'openai' | 'anthropic' | 'openai_compatible'.
 * @returns The matching adapter instance.
 * @throws {ProviderError} 500 UNKNOWN_PROVIDER if no adapter is registered.
 */
export function getAdapter(provider: string): ProviderAdapter {
  const adapter = REGISTRY[provider];
  if (!adapter) {
    throw new ProviderError(`Unknown provider '${provider}'`, 500, 'UNKNOWN_PROVIDER', false);
  }
  return adapter;
}
