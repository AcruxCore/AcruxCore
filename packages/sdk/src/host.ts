import type { ProviderConfig } from './types';
import type { SpanQueue } from './span-queue';
import type { ToolsNamespace } from './tools-api';

/**
 * Base interface shared by all namespace classes.
 *
 * Every namespace receives a host object conforming to this interface so it can
 * make authenticated requests without importing the client directly (which would
 * be a runtime circular import).
 */
export interface NamespaceHost {
  _request(
    method: string,
    path: string,
    body?: unknown,
    errorContext?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<Response>;
  _parseJsonOrThrow(response: Response, errorContext: string): Promise<unknown>;
  _apiKeyFingerprint(): string;
}

/**
 * Extended host for the gateway namespace.
 *
 * The gateway needs additional client internals for chat/stream/runToolLoop:
 * API key and base URL for BYO provider calls, retry config, the span queue for
 * background trace reporting, and the tools namespace for runToolLoop's
 * syncOne/resolve/execute calls.
 */
export interface GatewayNamespaceHost extends NamespaceHost {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly maxRetries: number;
  readonly retryInterval: number;
  readonly providerDefault?: ProviderConfig;
  readonly spanQueue: SpanQueue;
  readonly tools: ToolsNamespace;
}
