import { randomUUID } from 'node:crypto';
import type { Agent } from 'undici';
import { ProviderAdapter, ProviderError, GATEWAY_TIMEOUT_MS } from './adapter';
import type {
  NormalizedRequest,
  NormalizedResponse,
  ProviderCredentials,
  StreamChunk,
  ChatMessage,
  ToolDefinition,
  ToolChoice,
} from './types';
import { parseSseStream } from './sse-parse';
import { guardedFetch } from './guarded-fetch';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** Maps OpenAI tool definitions to Gemini's `tools: [{ functionDeclarations }]` shape. */
function toGeminiTools(tools: ToolDefinition[] | undefined): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.function.name,
        ...(t.function.description ? { description: t.function.description } : {}),
        parameters: t.function.parameters ?? { type: 'object', properties: {} },
      })),
    },
  ];
}

/**
 * Maps canonical OpenAI-shaped `tool_choice` to Gemini's `toolConfig.functionCallingConfig` shape.
 *
 * Gemini's documented `functionCallingConfig.mode` values are `AUTO` (model decides
 * whether to call a function) and `ANY` (model must call one of the available
 * functions). There is no dedicated "force exactly this one function" mode name the
 * way Anthropic has `{ type: 'tool', name }` — Gemini's mechanism for a forced
 * single function is `mode: 'ANY'` combined with `allowedFunctionNames` restricted
 * to just that one name, which narrows the ANY-mode call to only that function.
 * The mode enum casing (`AUTO`/`ANY`) and the `allowedFunctionNames` field name
 * match the documented Gemini v1beta `functionCallingConfig` REST JSON shape.
 *
 * IMPORTANT — this is a DELIBERATE CHOICE, not a "Gemini has no equivalent" claim:
 * Gemini's `functionCallingConfig` DOES have a native `NONE` mode ("model will not
 * predict any function call; same as not passing any function declarations"). We
 * intentionally do NOT use `mode: 'NONE'` here. Instead, canonical `'none'` is
 * resolved by omitting BOTH `tools` and `toolConfig` from the outgoing payload
 * entirely (see `buildGeminiPayload`). The reason is implementation simplicity for
 * this adapter: Gemini's own docs describe `mode: 'NONE'` as behaviorally
 * equivalent to omitting the declarations anyway, so omitting them sidesteps
 * needing to reason about whether `NONE` actually suppresses calls the same way,
 * without giving up any real behavior on the Gemini side. This is this adapter's
 * own approximation choice, not a cross-adapter contract — OpenAI's adapter, by
 * contrast, forwards `tools` and `tool_choice: 'none'` to OpenAI unchanged, which
 * keeps OpenAI's tool declarations visible to the model while instructing it not
 * to call one (OpenAI's own native `'none'` semantics). This function itself just
 * returns `undefined` for `'none'` and for an absent `tool_choice` (both mean:
 * don't set the `toolConfig` key).
 *
 * @param choice - Canonical `tool_choice`, or undefined if the caller didn't send one.
 * @returns Gemini's `toolConfig` object, or undefined when nothing should be sent.
 */
function toGeminiToolChoice(choice: ToolChoice | undefined): Record<string, unknown> | undefined {
  if (choice === undefined || choice === 'none') return undefined;
  if (choice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
  if (choice === 'required') return { functionCallingConfig: { mode: 'ANY' } };
  return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.function.name] } };
}

/**
 * Maps a canonical message to a Gemini `contents` entry, translating assistant
 * `tool_calls` into `functionCall` parts and `tool`-role results into
 * `functionResponse` parts. Returns null for `system` messages, which are hoisted
 * into `systemInstruction` by `buildGeminiPayload` instead.
 *
 * Gemini keys `functionResponse` by the **function name**, not a call id. Since the
 * canonical `tool` message carries `tool_call_id` (which for Gemini we set equal to
 * the function name when normalizing the response — see `chatCompletion`), reading
 * `m.tool_call_id` back here round-trips correctly.
 */
function toGeminiContent(m: ChatMessage): { role: 'user' | 'model'; parts: Record<string, unknown>[] } | null {
  if (m.role === 'system') return null;
  if (m.role === 'tool') {
    let response: unknown;
    try {
      response = JSON.parse(m.content ?? '{}');
    } catch {
      response = { result: m.content ?? '' };
    }
    return { role: 'user', parts: [{ functionResponse: { name: m.tool_call_id ?? '', response } }] };
  }
  if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
    const parts: Record<string, unknown>[] = [];
    if (m.content) parts.push({ text: m.content });
    for (const tc of m.tool_calls) {
      let args: unknown = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        args = {};
      }
      parts.push({ functionCall: { name: tc.function.name, args } });
    }
    return { role: 'model', parts };
  }
  return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content ?? '' }] };
}

/**
 * Translate a canonical request into a Gemini request body: hoist `system` to
 * `systemInstruction`, map `assistant`→`model`, fold sampling params into
 * `generationConfig`, and translate tools/tool_choice/tool messages. Shared by the
 * streaming and non-streaming paths.
 */
function buildGeminiPayload(req: NormalizedRequest): Record<string, unknown> {
  const systemText = req.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
  const contents = req.messages
    .map(toGeminiContent)
    .filter((c): c is { role: 'user' | 'model'; parts: Record<string, unknown>[] } => c !== null);

  const generationConfig: Record<string, unknown> = {};
  if (req.temperature !== undefined) generationConfig['temperature'] = req.temperature;
  if (req.max_tokens !== undefined) generationConfig['maxOutputTokens'] = req.max_tokens;
  if (req.top_p !== undefined) generationConfig['topP'] = req.top_p;
  if (req.stop !== undefined) {
    generationConfig['stopSequences'] = Array.isArray(req.stop) ? req.stop : [req.stop];
  }
  // Gemini's `responseSchema` expects an OpenAPI-3.0-subset schema, not arbitrary JSON
  // Schema — this passes the schema through as-is rather than validating/stripping
  // unsupported keywords; an incompatible schema surfaces as a Gemini 400, not a silent
  // gateway failure.
  if (req.response_format !== undefined && req.response_format.type !== 'text') {
    generationConfig['responseMimeType'] = 'application/json';
    if (req.response_format.type === 'json_schema' && req.response_format.json_schema.schema) {
      generationConfig['responseSchema'] = req.response_format.json_schema.schema;
    }
  }

  const payload: Record<string, unknown> = { contents };
  if (systemText) payload['systemInstruction'] = { parts: [{ text: systemText }] };
  if (Object.keys(generationConfig).length > 0) payload['generationConfig'] = generationConfig;
  // `tool_choice: 'none'` → omit both `tools` and `toolConfig` entirely. Gemini has
  // a native `functionCallingConfig.mode: 'NONE'`, but this adapter chooses not to
  // use it, for implementation simplicity (see `toGeminiToolChoice`'s doc comment) —
  // per Gemini's own docs, `mode: 'NONE'` is equivalent to omitting the declarations
  // anyway, so this loses no real behavior on the Gemini side.
  if (req.tool_choice !== 'none') {
    const geminiTools = toGeminiTools(req.tools);
    if (geminiTools) payload['tools'] = geminiTools;
    const geminiToolChoice = toGeminiToolChoice(req.tool_choice);
    if (geminiToolChoice) payload['toolConfig'] = geminiToolChoice;
  }
  return payload;
}

interface GeminiResponseBody {
  candidates?: {
    content?: {
      parts?: { text?: string; functionCall?: { name: string; args?: unknown } }[];
      role?: string;
    };
    finishReason?: string;
    index?: number;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

/** Map a Gemini `finishReason` to an OpenAI `finish_reason`. */
function mapFinishReason(reason: string | undefined): string | null {
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'content_filter';
    case undefined:
      return null;
    default:
      return 'stop';
  }
}

/**
 * Adapter for Google's Gemini (Generative Language API, `:generateContent`).
 * Translates the canonical OpenAI-shaped request — hoisting `system` messages to
 * `systemInstruction`, mapping `assistant`→`model` roles, folding sampling params
 * into `generationConfig`, and mapping `tools`/`tool_choice`/tool-related messages
 * to Gemini's `functionDeclarations`/`toolConfig`/`functionCall`/`functionResponse`
 * shapes — and normalizes the response (text, tool_calls, token usage) back to
 * OpenAI shape. Gemini returns no response id, so one is synthesized.
 */
export class GeminiAdapter implements ProviderAdapter {
  readonly provider = 'gemini' as const;

  /**
   * @param req - Canonical request; `system` hoisted, `assistant`→`model`, sampling params → generationConfig, tools/tool_choice translated.
   * @param creds - Decrypted API key (sent as `x-goog-api-key`). `baseUrl` overrides the default host.
   * @returns Normalized (OpenAI-shaped) response with a synthesized `id`; `tool_calls` present when the model called a function.
   * @throws {ProviderError} On a non-2xx response (retriable for 429/5xx), timeout (504), or network error (502).
   */
  async chatCompletion(req: NormalizedRequest, creds: ProviderCredentials): Promise<NormalizedResponse> {
    const payload = buildGeminiPayload(req);

    const baseUrl = (creds.baseUrl ?? GEMINI_BASE_URL).replace(/\/+$/, '');
    const url = `${baseUrl}/models/${encodeURIComponent(req.model)}:generateContent`;
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
            'x-goog-api-key': creds.apiKey,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
        },
        usesCustomBaseUrl,
        'Gemini',
      ));
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      const isTimeout = err instanceof Error && err.name === 'TimeoutError';
      throw new ProviderError(
        isTimeout ? 'Gemini request timed out' : `Gemini network error: ${(err as Error).message}`,
        isTimeout ? 504 : 502,
        isTimeout ? 'timeout' : 'network_error',
        true,
      );
    }

    try {
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.error(`Gemini upstream error ${res.status}:`, detail);
        throw new ProviderError(
          `Gemini request failed with status ${res.status}`,
          res.status,
          undefined,
          res.status === 429 || res.status >= 500,
        );
      }

      const data = (await res.json()) as GeminiResponseBody;
      const candidate = data.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      const text = parts
        .filter((p) => typeof p.text === 'string')
        .map((p) => p.text as string)
        .join('');
      // Gemini has no id for a function call, so we set tool_calls[].id = name — the
      // same name `toGeminiContent` reads back from `tool_call_id` on the next turn's
      // `tool` message, since Gemini's own `functionResponse` is name-keyed too.
      const toolCalls = parts
        .filter((p) => p.functionCall)
        .map((p) => ({
          id: p.functionCall!.name,
          type: 'function' as const,
          function: { name: p.functionCall!.name, arguments: JSON.stringify(p.functionCall!.args ?? {}) },
        }));
      // Gemini's own finishReason is typically STOP even for a function-calling turn,
      // so force 'tool_calls' when the model actually emitted one, matching OpenAI's
      // and the Anthropic adapter's finish_reason semantics.
      const finishReason = toolCalls.length > 0 ? 'tool_calls' : mapFinishReason(candidate?.finishReason);
      const promptTokens = data.usageMetadata?.promptTokenCount ?? 0;
      const completionTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
      const totalTokens = data.usageMetadata?.totalTokenCount ?? promptTokens + completionTokens;

      return {
        id: `chatcmpl-${randomUUID()}`,
        model: req.model,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: text,
              ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: finishReason,
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: totalTokens,
        },
      };
    } finally {
      if (dispatcher) await dispatcher.close();
    }
  }

  /**
   * @param req - Canonical request; `system` hoisted, `assistant`→`model`, sampling params → generationConfig, tools/tool_choice translated.
   * @param creds - Decrypted API key (sent as `x-goog-api-key`). `baseUrl` overrides the default host.
   * @param signal - Optional abort signal; cancels the upstream stream on client disconnect.
   * @returns Async iterable of normalized delta chunks; a chunk carries `tool_calls` when the frame has functionCall parts (finish_reason forced to `tool_calls`), and the final frame carries finish_reason + usage (from usageMetadata).
   * @throws {ProviderError} On a non-2xx response before the first chunk (retriable for 429/5xx), or a network/timeout failure establishing the connection (retriable, 502/504).
   */
  async *streamChatCompletion(
    req: NormalizedRequest,
    creds: ProviderCredentials,
    signal?: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const payload = buildGeminiPayload(req);
    const baseUrl = (creds.baseUrl ?? GEMINI_BASE_URL).replace(/\/+$/, '');
    const url = `${baseUrl}/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`;
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
            'x-goog-api-key': creds.apiKey,
          },
          body: JSON.stringify(payload),
          signal,
        },
        usesCustomBaseUrl,
        'Gemini',
      ));
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      const isTimeout = err instanceof Error && err.name === 'TimeoutError';
      throw new ProviderError(
        isTimeout ? 'Gemini stream request timed out' : `Gemini network error: ${(err as Error).message}`,
        isTimeout ? 504 : 502,
        isTimeout ? 'timeout' : 'network_error',
        true,
      );
    }

    try {
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        console.error(`Gemini stream upstream error ${res.status}:`, detail);
        throw new ProviderError(
          `Gemini stream request failed with status ${res.status}`,
          res.status,
          undefined,
          res.status === 429 || res.status >= 500,
        );
      }

      for await (const data of parseSseStream(res.body, signal)) {
        let frame: GeminiResponseBody;
        try {
          frame = JSON.parse(data) as GeminiResponseBody;
        } catch {
          continue; // ignore malformed keep-alive lines
        }
        const candidate = frame.candidates?.[0];
        const parts = candidate?.content?.parts ?? [];
        const delta = parts
          .filter((p) => typeof p.text === 'string')
          .map((p) => p.text as string)
          .join('');
        // Gemini repeats the full functionCall per chunk rather than streaming partial
        // JSON incrementally (unlike OpenAI/Anthropic), so each functionCall part here
        // is already a complete call. `index` is the 0-based ordinal position among
        // tool-call parts WITHIN this candidate's parts array (not the raw array
        // position, and not carried across frames) — consistent with the "position
        // among parallel tool calls" meaning `ToolCall.index` has for the other
        // adapters, so a downstream consumer reassembling parallel calls can key on it.
        const toolCallParts = parts.filter((p) => p.functionCall);
        const toolCalls =
          toolCallParts.length > 0
            ? toolCallParts.map((p, index) => ({
                id: p.functionCall!.name,
                type: 'function' as const,
                function: { name: p.functionCall!.name, arguments: JSON.stringify(p.functionCall!.args ?? {}) },
                index,
              }))
            : undefined;
        // As in the non-streaming path, force 'tool_calls' when the frame carries a
        // functionCall — Gemini's own finishReason is typically STOP even then.
        const finishReason = toolCalls ? 'tool_calls' : mapFinishReason(candidate?.finishReason);
        const usage = frame.usageMetadata
          ? {
              prompt_tokens: frame.usageMetadata.promptTokenCount ?? 0,
              completion_tokens: frame.usageMetadata.candidatesTokenCount ?? 0,
              total_tokens:
                frame.usageMetadata.totalTokenCount ??
                (frame.usageMetadata.promptTokenCount ?? 0) +
                  (frame.usageMetadata.candidatesTokenCount ?? 0),
            }
          : undefined;
        // Skip empty keep-alives, but always forward finish, usage, and tool-call frames.
        if (delta === '' && finishReason === null && !usage && !toolCalls) continue;
        yield { delta, finish_reason: finishReason, usage, tool_calls: toolCalls };
      }
    } finally {
      if (dispatcher) await dispatcher.close();
    }
  }
}

/** Singleton Gemini adapter. */
export const geminiAdapter = new GeminiAdapter();
