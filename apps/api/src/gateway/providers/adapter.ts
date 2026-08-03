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

/**
 * Error thrown by adapters on any upstream failure. `status` is the provider HTTP
 * status (or 502/504 for network/timeout); `retriable` (429/5xx/network) is consumed
 * by G5 retry/fallback. The gateway service maps `status === 504` → GatewayTimeoutError
 * and everything else → BadGatewayError.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly providerCode?: string,
    public readonly retriable = false,
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
