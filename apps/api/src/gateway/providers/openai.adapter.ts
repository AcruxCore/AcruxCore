import type { Agent } from 'undici';
import { ProviderAdapter, ProviderError, GATEWAY_TIMEOUT_MS } from './adapter';
import type { NormalizedRequest, NormalizedResponse, ProviderCredentials, StreamChunk } from './types';
import { parseSseStream } from './sse-parse';
import { guardedFetch } from './guarded-fetch';

/** One SSE frame from the OpenAI streaming API (`chat.completion.chunk`). */
interface OpenAiStreamFrame {
  choices?: {
    delta?: {
      content?: string;
      /** Incremental tool-call deltas; fields may be partial/split across frames. */
      tool_calls?: { index?: number; id?: string; type?: 'function'; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}

interface OpenAiResponseBody {
  id: string;
  object?: string;
  created?: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
    };
    finish_reason: string | null;
  }[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * Adapter for the OpenAI Chat Completions wire format. Because our canonical shape
 * IS the OpenAI shape, request and response are near passthroughs. The same class
 * serves `openai_compatible` providers (Groq, Together, Ollama, …) by requiring a
 * caller-supplied `baseUrl`.
 */
export class OpenAiAdapter implements ProviderAdapter {
  readonly provider: 'openai' | 'openai_compatible';

  /**
   * @param provider - `'openai'` (default base URL) or `'openai_compatible'` (baseUrl required).
   */
  constructor(provider: 'openai' | 'openai_compatible' = 'openai') {
    this.provider = provider;
  }

  /**
   * Resolve the base URL for this connection, enforcing the openai_compatible
   * requirement of an explicit base URL.
   * @throws {ProviderError} 502 MISSING_BASE_URL when openai_compatible lacks a base URL.
   */
  private resolveBaseUrl(creds: ProviderCredentials): string {
    if (this.provider === 'openai_compatible' && !creds.baseUrl) {
      throw new ProviderError('openai_compatible connection is missing base_url', 502, 'MISSING_BASE_URL', false);
    }
    return (creds.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
  }

  /** Build the shared OpenAI request body (model + messages + sampling params). */
  private buildPayload(req: NormalizedRequest): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
    };
    if (req.temperature !== undefined) payload['temperature'] = req.temperature;
    if (req.max_tokens !== undefined) {
      // Real OpenAI renamed max_tokens → max_completion_tokens; the new key is
      // accepted on every chat model and required by reasoning families
      // (o1/o3/o4-mini/gpt-5), which 400 on the legacy name. Third-party
      // openai_compatible servers (Groq/Together/Ollama/…) still expect the
      // legacy name, so the wire key follows the provider boundary, not the model.
      const maxTokensKey = this.provider === 'openai' ? 'max_completion_tokens' : 'max_tokens';
      payload[maxTokensKey] = req.max_tokens;
    }
    if (req.top_p !== undefined) payload['top_p'] = req.top_p;
    if (req.stop !== undefined) payload['stop'] = req.stop;
    if (req.tools !== undefined) payload['tools'] = req.tools;
    if (req.tool_choice !== undefined) payload['tool_choice'] = req.tool_choice;
    if (req.response_format !== undefined) payload['response_format'] = req.response_format;
    return payload;
  }

  /**
   * @param req - Canonical request (already OpenAI-shaped).
   * @param creds - Decrypted API key and optional base URL override.
   * @returns Normalized (OpenAI-shaped) response.
   * @throws {ProviderError} On a non-2xx response (retriable for 429/5xx), timeout (504), or network error (502).
   */
  async chatCompletion(req: NormalizedRequest, creds: ProviderCredentials): Promise<NormalizedResponse> {
    const baseUrl = this.resolveBaseUrl(creds);
    const url = `${baseUrl}/chat/completions`;

    const payload: Record<string, unknown> = { ...this.buildPayload(req), stream: false };
    const usesCustomBaseUrl = creds.baseUrl !== undefined;

    let res: Response;
    let dispatcher: Agent | undefined;
    try {
      ({ res, dispatcher } = await guardedFetch(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${creds.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
        },
        usesCustomBaseUrl,
        'OpenAI',
      ));
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      const isTimeout = err instanceof Error && err.name === 'TimeoutError';
      throw new ProviderError(
        isTimeout ? 'OpenAI request timed out' : `OpenAI network error: ${(err as Error).message}`,
        isTimeout ? 504 : 502,
        isTimeout ? 'timeout' : 'network_error',
        true,
      );
    }

    try {
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.error(`OpenAI upstream error ${res.status}:`, detail);
        throw new ProviderError(
          `OpenAI request failed with status ${res.status}`,
          res.status,
          undefined,
          res.status === 429 || res.status >= 500,
        );
      }

      const data = (await res.json()) as OpenAiResponseBody;
      return {
        id: data.id,
        model: data.model,
        object: data.object ?? 'chat.completion',
        created: data.created ?? Math.floor(Date.now() / 1000),
        choices: data.choices.map((c) => ({
          index: c.index,
          message: {
            role: 'assistant' as const,
            content: c.message.content ?? '',
            ...(c.message.tool_calls ? { tool_calls: c.message.tool_calls } : {}),
          },
          finish_reason: c.finish_reason,
        })),
        usage: {
          prompt_tokens: data.usage.prompt_tokens,
          completion_tokens: data.usage.completion_tokens,
          total_tokens: data.usage.total_tokens,
        },
      };
    } finally {
      if (dispatcher) await dispatcher.close();
    }
  }

  /**
   * @param req - Canonical request (already OpenAI-shaped).
   * @param creds - Decrypted API key and optional base URL override.
   * @param signal - Optional abort signal; cancels the upstream stream on client disconnect.
   * @returns Async iterable of normalized delta chunks; the final frame carries provider usage.
   * @throws {ProviderError} On a non-2xx response before the first chunk (retriable for 429/5xx), or a network/timeout failure establishing the connection (retriable, 502/504).
   */
  async *streamChatCompletion(
    req: NormalizedRequest,
    creds: ProviderCredentials,
    signal?: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const baseUrl = this.resolveBaseUrl(creds);
    const url = `${baseUrl}/chat/completions`;
    const payload: Record<string, unknown> = {
      ...this.buildPayload(req),
      stream: true,
      stream_options: { include_usage: true },
    };
    const usesCustomBaseUrl = creds.baseUrl !== undefined;

    let res: Response;
    let dispatcher: Agent | undefined;
    try {
      ({ res, dispatcher } = await guardedFetch(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${creds.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal,
        },
        usesCustomBaseUrl,
        'OpenAI',
      ));
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      const isTimeout = err instanceof Error && err.name === 'TimeoutError';
      throw new ProviderError(
        isTimeout ? 'OpenAI stream request timed out' : `OpenAI network error: ${(err as Error).message}`,
        isTimeout ? 504 : 502,
        isTimeout ? 'timeout' : 'network_error',
        true,
      );
    }

    try {
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        console.error(`OpenAI stream upstream error ${res.status}:`, detail);
        throw new ProviderError(
          `OpenAI stream request failed with status ${res.status}`,
          res.status,
          undefined,
          res.status === 429 || res.status >= 500,
        );
      }

      for await (const data of parseSseStream(res.body, signal)) {
        let frame: OpenAiStreamFrame;
        try {
          frame = JSON.parse(data) as OpenAiStreamFrame;
        } catch {
          continue; // ignore malformed keep-alive lines
        }
        const choice = frame.choices?.[0];
        const delta = choice?.delta?.content ?? '';
        const rawToolCalls = choice?.delta?.tool_calls;
        const finishReason = choice?.finish_reason ?? null;
        const usage = frame.usage
          ? {
              prompt_tokens: frame.usage.prompt_tokens,
              completion_tokens: frame.usage.completion_tokens,
              total_tokens: frame.usage.total_tokens,
            }
          : undefined;
        // Map partial OpenAI tool-call deltas to the canonical ToolCall shape (fields
        // may be split/partial across frames — id/name typically arrive on the first
        // frame for a given tool call, arguments stream in afterward).
        const toolCalls = rawToolCalls?.map((t) => ({
          id: t.id ?? '',
          type: 'function' as const,
          function: { name: t.function?.name ?? '', arguments: t.function?.arguments ?? '' },
          // Preserve the wire index so callers can correlate fragments of the same
          // parallel tool call across chunks (see canonical ToolCall.index doc).
          index: t.index,
        }));
        // Skip empty keep-alives, but always forward finish, usage, and tool-call frames.
        if (delta === '' && finishReason === null && !usage && !toolCalls) continue;
        yield { delta, finish_reason: finishReason, usage, ...(toolCalls ? { tool_calls: toolCalls } : {}) };
      }
    } finally {
      if (dispatcher) await dispatcher.close();
    }
  }
}

/** Singleton adapter for OpenAI proper (default base URL). */
export const openaiAdapter = new OpenAiAdapter('openai');

/** Singleton adapter for any OpenAI-wire-compatible provider (base URL required). */
export const openaiCompatibleAdapter = new OpenAiAdapter('openai_compatible');
