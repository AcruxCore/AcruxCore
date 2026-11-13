import { randomUUID } from 'node:crypto';
import type { Agent } from 'undici';
import { ProviderAdapter, ProviderError, GATEWAY_TIMEOUT_MS, summarizeProviderDetail, parseRetryAfter, OWN_TIMEOUT_CODE } from './adapter';
import { providerCallSignal } from './timeout';
import type {
  NormalizedRequest,
  NormalizedResponse,
  ProviderCredentials,
  StreamChunk,
  ChatMessage,
  ContentPart,
  ToolCall,
  ToolDefinition,
  ToolChoice,
  Usage,
} from './types';
import { parseSseStream } from './sse-parse';
import { guardedFetch } from './guarded-fetch';
import { contentText, parseDataImageUrl } from './message-content';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** Maps OpenAI tool definitions to Gemini's `tools: [{ functionDeclarations }]` shape. */
function toGeminiTools(tools: ToolDefinition[] | undefined): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.function.name,
        ...(t.function.description ? { description: t.function.description } : {}),
        // The full-JSON-Schema field: `parameters` is an OpenAPI subset that rejects
        // `additionalProperties`, which every zod-generated schema carries.
        parametersJsonSchema: t.function.parameters ?? { type: 'object', properties: {} },
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
 * Maps a content part to a Gemini part. Gemini takes an image only as inline base64 (or as a file
 * uploaded to its own File API), so a remote URL is refused rather than fetched: the gateway
 * fetching an arbitrary caller-supplied URL would be a server-side request the caller steers.
 *
 * @throws {ProviderError} 400 when an image part holds a remote URL.
 */
function toGeminiPart(part: ContentPart): Record<string, unknown> {
  if (part.type === 'text') return { text: part.text };
  const data = parseDataImageUrl(part.image_url.url);
  if (!data) {
    throw new ProviderError(
      'This model reads an image only as a data:image/...;base64 URL; send the image bytes inline instead of a link.',
      400,
      'unsupported_image_url',
    );
  }
  return { inlineData: { mimeType: data.mediaType, data: data.data } };
}

/** The thought signature a tool call carries in `extra_content`, if any. */
function thoughtSignatureOf(tc: ToolCall): string | undefined {
  const google = tc.extra_content?.['google'] as { thought_signature?: unknown } | undefined;
  return typeof google?.thought_signature === 'string' ? google.thought_signature : undefined;
}

/**
 * Maps a Gemini `functionCall` part to a canonical tool call.
 *
 * Gemini 3 sends a call `id`; older models send none, and then the id is the function
 * name, which is what this adapter always did. The part's `thoughtSignature` is kept in
 * `extra_content`, because Gemini 3 refuses a follow-up turn that does not send it back.
 */
function toToolCall(part: GeminiPart): ToolCall {
  const fc = part.functionCall!;
  return {
    id: fc.id || fc.name,
    type: 'function',
    function: { name: fc.name, arguments: JSON.stringify(fc.args ?? {}) },
    ...(part.thoughtSignature ? { extra_content: { google: { thought_signature: part.thoughtSignature } } } : {}),
  };
}

/**
 * Maps a canonical message to a Gemini `contents` entry, translating assistant
 * `tool_calls` into `functionCall` parts and `tool`-role results into
 * `functionResponse` parts. Returns null for `system` messages, which are hoisted
 * into `systemInstruction` by `buildGeminiPayload` instead.
 *
 * Gemini keys `functionResponse` by the **function name**, while a canonical `tool`
 * message carries only `tool_call_id`. `names` maps each call id seen on an earlier
 * assistant turn to its function name. An id that is not in it is read as the name
 * itself, which is what the id was before Gemini sent ids of its own.
 */
function toGeminiContent(
  m: ChatMessage,
  names: Map<string, string>,
): { role: 'user' | 'model'; parts: Record<string, unknown>[] } | null {
  if (m.role === 'system') return null;
  if (m.role === 'tool') {
    let response: unknown;
    try {
      response = JSON.parse(contentText(m.content) || '{}');
    } catch {
      response = { result: contentText(m.content) };
    }
    const callId = m.tool_call_id ?? '';
    const name = names.get(callId) ?? callId;
    // A real Gemini call id goes back with the response, so Gemini can match parallel calls.
    const withId = callId !== '' && callId !== name;
    return { role: 'user', parts: [{ functionResponse: { name, response, ...(withId ? { id: callId } : {}) } }] };
  }
  if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
    const parts: Record<string, unknown>[] = [];
    const text = contentText(m.content);
    if (text) parts.push({ text });
    for (const tc of m.tool_calls) {
      let args: unknown = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        args = {};
      }
      names.set(tc.id, tc.function.name);
      const withId = tc.id !== '' && tc.id !== tc.function.name;
      const signature = thoughtSignatureOf(tc);
      parts.push({
        functionCall: { name: tc.function.name, args, ...(withId ? { id: tc.id } : {}) },
        ...(signature ? { thoughtSignature: signature } : {}),
      });
    }
    return { role: 'model', parts };
  }
  const role = m.role === 'assistant' ? 'model' : 'user';
  if (Array.isArray(m.content)) return { role, parts: m.content.map(toGeminiPart) };
  return { role, parts: [{ text: m.content ?? '' }] };
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
    .map((m) => contentText(m.content))
    .join('\n');
  const names = new Map<string, string>();
  const contents: { role: 'user' | 'model'; parts: Record<string, unknown>[] }[] = [];
  for (const m of req.messages) {
    const content = toGeminiContent(m, names);
    if (!content) continue;
    // Gemini wants every response to a parallel call in one turn, right after the call.
    const prev = contents[contents.length - 1];
    const isResponse = 'functionResponse' in (content.parts[0] ?? {});
    if (isResponse && prev && prev.role === 'user' && 'functionResponse' in (prev.parts[0] ?? {})) {
      prev.parts.push(...content.parts);
    } else {
      contents.push(content);
    }
  }

  const generationConfig: Record<string, unknown> = {};
  if (req.temperature !== undefined) generationConfig['temperature'] = req.temperature;
  if (req.max_tokens !== undefined) generationConfig['maxOutputTokens'] = req.max_tokens;
  if (req.top_p !== undefined) generationConfig['topP'] = req.top_p;
  if (req.stop !== undefined) {
    generationConfig['stopSequences'] = Array.isArray(req.stop) ? req.stop : [req.stop];
  }
  // `responseJsonSchema` takes full JSON Schema. The older `responseSchema` is an OpenAPI
  // subset that 400s on `additionalProperties`, which OpenAI strict mode and every zod
  // schema carry. The schema is passed as it is, so a schema Gemini cannot use surfaces
  // as a Gemini 400, not a silent gateway failure.
  if (req.response_format !== undefined && req.response_format.type !== 'text') {
    generationConfig['responseMimeType'] = 'application/json';
    if (req.response_format.type === 'json_schema' && req.response_format.json_schema.schema) {
      generationConfig['responseJsonSchema'] = req.response_format.json_schema.schema;
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

/** One part of a Gemini candidate's content. */
interface GeminiPart {
  text?: string;
  /** Set on a thought summary: the model's reasoning, not part of its answer. */
  thought?: boolean;
  /** Gemini 3's signature over its reasoning; must be sent back with the call. */
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: unknown };
}

interface GeminiResponseBody {
  candidates?: {
    content?: {
      parts?: GeminiPart[];
      role?: string;
    };
    finishReason?: string;
    index?: number;
  }[];
  usageMetadata?: GeminiUsageMetadata;
}

/** Gemini's token counts. `thoughtsTokenCount` is NOT part of `candidatesTokenCount`. */
interface GeminiUsageMetadata {
  promptTokenCount?: number;
  /** Prompt tokens served from Gemini's cache; a subset of `promptTokenCount`. */
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  /** Thinking tokens; billed at the output rate, counted apart from the answer. */
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

/**
 * Maps Gemini's usage block to the OpenAI shape.
 *
 * Gemini reports a thinking model's reasoning in `thoughtsTokenCount`, apart from
 * `candidatesTokenCount`, and bills both at the output rate. OpenAI counts reasoning
 * inside `completion_tokens` and repeats it as `reasoning_tokens`. Reading
 * `candidatesTokenCount` alone left every thinking token unbilled (issue #593).
 *
 * `cachedContentTokenCount` is already inside `promptTokenCount`, the same shape as OpenAI's
 * `cached_tokens`, so it maps across unchanged. Ignoring it billed every cache hit at the
 * full input price (issue #595).
 */
function toUsage(meta: GeminiUsageMetadata): Usage {
  const promptTokens = meta.promptTokenCount ?? 0;
  const thoughts = meta.thoughtsTokenCount ?? 0;
  const completionTokens = (meta.candidatesTokenCount ?? 0) + thoughts;
  const cached = meta.cachedContentTokenCount ?? 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: meta.totalTokenCount ?? promptTokens + completionTokens,
    ...(thoughts > 0 ? { reasoning_tokens: thoughts } : {}),
    ...(cached > 0 ? { cached_tokens: cached } : {}),
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
   * Gemini has no `reasoning_effort`. Its thinking control (`thinkingConfig`) differs by model
   * generation, so the field is left out (issue #593).
   */
  readonly unsentParams: ReadonlyArray<keyof NormalizedRequest> = ['reasoning_effort'];

  /**
   * @param req - Canonical request; `system` hoisted, `assistant`→`model`, sampling params → generationConfig, tools/tool_choice translated.
   * @param creds - Decrypted API key (sent as `x-goog-api-key`). `baseUrl` overrides the default host.
   * @param deadline - Optional caller deadline (what is left of the fallback chain's);
   *   the call ends at whichever comes first, it or GATEWAY_TIMEOUT_MS.
   * @returns Normalized (OpenAI-shaped) response with a synthesized `id`; `tool_calls` present when the model called a function.
   * @throws {ProviderError} On a non-2xx response (retriable for 429/5xx), timeout (504), or network error (502).
   */
  async chatCompletion(
    req: NormalizedRequest,
    creds: ProviderCredentials,
    deadline?: AbortSignal,
  ): Promise<NormalizedResponse> {
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
          signal: providerCallSignal(deadline),
        },
        usesCustomBaseUrl,
        'Gemini',
        GATEWAY_TIMEOUT_MS,
        // Buffered: `res.json()` below reads the whole body into memory.
        true,
      ));
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      const isTimeout = err instanceof Error && err.name === 'TimeoutError';
      throw new ProviderError(
        isTimeout ? 'Gemini request timed out' : `Gemini network error: ${(err as Error).message}`,
        isTimeout ? 504 : 502,
        isTimeout ? OWN_TIMEOUT_CODE : 'network_error',
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
          summarizeProviderDetail(detail),
          parseRetryAfter(res.headers),
        );
      }

      const data = (await res.json()) as GeminiResponseBody;
      const candidate = data.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      const text = parts
        .filter((p) => typeof p.text === 'string' && !p.thought)
        .map((p) => p.text as string)
        .join('');
      const toolCalls = parts.filter((p) => p.functionCall).map(toToolCall);
      // Gemini's own finishReason is typically STOP even for a function-calling turn,
      // so force 'tool_calls' when the model actually emitted one, matching OpenAI's
      // and the Anthropic adapter's finish_reason semantics.
      const finishReason = toolCalls.length > 0 ? 'tool_calls' : mapFinishReason(candidate?.finishReason);

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
        usage: toUsage(data.usageMetadata ?? {}),
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
        isTimeout ? OWN_TIMEOUT_CODE : 'network_error',
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
          summarizeProviderDetail(detail),
          parseRetryAfter(res.headers),
        );
      }

      // Tool calls seen so far in this stream. Gemini sends each call whole, but parallel
      // calls can arrive in separate frames, so the ordinal is counted across frames.
      let callCount = 0;
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
          .filter((p) => typeof p.text === 'string' && !p.thought)
          .map((p) => p.text as string)
          .join('');
        // Gemini sends each functionCall whole rather than as partial JSON (unlike
        // OpenAI/Anthropic), so each part here is a complete call. `index` is the call's
        // ordinal among all tool calls in the stream, the "position among parallel tool
        // calls" meaning `ToolCall.index` has for the other adapters, so a consumer
        // reassembling calls by index keeps calls from separate frames apart.
        const toolCallParts = parts.filter((p) => p.functionCall);
        const toolCalls =
          toolCallParts.length > 0
            ? toolCallParts.map((p) => ({ ...toToolCall(p), index: callCount++ }))
            : undefined;
        // As in the non-streaming path, report 'tool_calls' once the stream has carried
        // a functionCall — Gemini's own finishReason is typically STOP even then.
        const mapped = mapFinishReason(candidate?.finishReason);
        const finishReason = toolCalls || (mapped !== null && callCount > 0) ? 'tool_calls' : mapped;
        const usage = frame.usageMetadata ? toUsage(frame.usageMetadata) : undefined;
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
