import { ProviderAdapter, ProviderError, GATEWAY_TIMEOUT_MS, summarizeProviderDetail, parseRetryAfter } from './adapter';
import type {
  NormalizedRequest,
  NormalizedResponse,
  ProviderCredentials,
  StreamChunk,
  ChatMessage,
  ToolDefinition,
  ToolChoice,
  ResponseFormat,
  Usage,
} from './types';
import { parseSseStream } from './sse-parse';
import { guardedFetch } from './guarded-fetch';

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

/** Anthropic requires max_tokens; fall back to this when the caller omits it. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 1024;

/** Description attached to the synthetic tool used to translate `response_format`
 * into a forced Anthropic tool call (see `toAnthropicResponseFormatTool`). */
const RESPONSE_FORMAT_TOOL_DESCRIPTION =
  'Return the final answer using this tool, matching its input schema exactly. Do not respond with plain text.';

/** Fallback tool name for a `json_object` request, which (unlike `json_schema`) carries no name. */
const RESPONSE_FORMAT_GENERIC_TOOL_NAME = 'structured_output';

interface AnthropicResponseBody {
  id: string;
  model: string;
  content: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
  stop_reason: string | null;
  usage: AnthropicUsage;
}

/**
 * Anthropic's token counts. Unlike OpenAI, `input_tokens` counts only the uncached part of the
 * prompt: tokens read from or written to the cache are reported beside it, not inside it.
 */
interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/**
 * Converts Anthropic's usage into the canonical shape, where `prompt_tokens` is the whole prompt
 * and the cache counts are subsets of it. Adds the cache fields only when they are above zero, so
 * an uncached call keeps the exact `usage` shape it always had.
 */
function toUsage(u: AnthropicUsage, outputTokens = u.output_tokens ?? 0): Usage {
  const read = u.cache_read_input_tokens ?? 0;
  const written = u.cache_creation_input_tokens ?? 0;
  const prompt = (u.input_tokens ?? 0) + read + written;
  return {
    prompt_tokens: prompt,
    completion_tokens: outputTokens,
    total_tokens: prompt + outputTokens,
    ...(read > 0 ? { cached_tokens: read } : {}),
    ...(written > 0 ? { cache_write_tokens: written } : {}),
  };
}

/** Map Anthropic stop_reason to an OpenAI finish_reason. */
function mapStopReason(stop: string | null | undefined): string | null {
  switch (stop) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case undefined:
      return null;
    default:
      return stop;
  }
}

/**
 * Build Anthropic's top-level `system` from the `system`-role messages (shared by the streaming
 * and non-streaming paths). Non-system messages are translated separately by `toAnthropicMessages`.
 *
 * Without a `cache_control` marker this is the joined string it always was. With one, it becomes
 * one text block per system message, the marked ones carrying `cache_control`, because Anthropic
 * reads the marker only from a block (issue #552).
 *
 * @returns The `system` value, or `undefined` when there is no system text.
 */
function toAnthropicSystem(messages: NormalizedRequest['messages']): string | unknown[] | undefined {
  const system = messages.filter((m) => m.role === 'system');
  if (system.some((m) => m.cache_control)) {
    return system.map((m) => ({
      type: 'text',
      text: m.content ?? '',
      ...(m.cache_control ? { cache_control: m.cache_control } : {}),
    }));
  }
  const text = system.map((m) => m.content).join('\n');
  return text || undefined;
}

/** Adds a message's `cache_control` marker to the last block of its Anthropic content. */
function withCacheMarker(m: ChatMessage, blocks: Record<string, unknown>[]): Record<string, unknown>[] {
  const last = blocks[blocks.length - 1];
  if (m.cache_control && last) last['cache_control'] = m.cache_control;
  return blocks;
}

/** Maps OpenAI tool definitions to Anthropic's `{ name, description, input_schema }` shape. */
function toAnthropicTools(tools: ToolDefinition[] | undefined): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    ...(t.function.description ? { description: t.function.description } : {}),
    input_schema: t.function.parameters ?? { type: 'object', properties: {} },
  }));
}

/**
 * Maps canonical OpenAI-shaped `tool_choice` to Anthropic's `tool_choice` shape.
 *
 * Anthropic's `tool_choice` does support a native `{ type: 'none' }` ("prevents
 * Claude from using any tools"), alongside `auto` / `any` / a forced `tool`. This
 * adapter does not use it: canonical `'none'` is instead handled by the caller
 * omitting BOTH `tools` and `tool_choice` from the outgoing request entirely (see
 * `chatCompletion`/`streamChatCompletion`) — an approximation, not a claim that
 * Anthropic lacks a `'none'` option. This function itself just returns `undefined`
 * for `'none'` and for an absent `tool_choice` (both mean: don't set the
 * `tool_choice` key on the payload).
 *
 * @param choice - Canonical `tool_choice`, or undefined if the caller didn't send one.
 * @returns Anthropic's `tool_choice` object, or undefined when nothing should be sent.
 */
function toAnthropicToolChoice(choice: ToolChoice | undefined): Record<string, unknown> | undefined {
  if (choice === undefined || choice === 'none') return undefined;
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'required') return { type: 'any' };
  return { type: 'tool', name: choice.function.name };
}

/**
 * Anthropic has no native `response_format`. Translate a `json_object`/`json_schema`
 * request into a single synthetic tool definition, forced via `tool_choice` — the
 * model's tool-call arguments become the structured JSON the caller asked for. Only
 * called when `req.tools`/`req.tool_choice` are unset by the time the request reaches
 * this adapter: `GatewayService.assertResponseFormatToolsCompatible` rejects
 * `response_format` combined with a non-empty `tools` array *after* prompt-attached and
 * `tool_refs`-resolved tools are merged in (the Zod layer alone only catches the inline
 * case, since it runs before that merge) — see `gateway.service.ts`.
 *
 * @param responseFormat - `req.response_format`, or undefined/`'text'` for no translation.
 * @returns The synthetic tool's name and input schema, or null when nothing to translate.
 */
function toAnthropicResponseFormatTool(
  responseFormat: ResponseFormat | undefined,
): { name: string; input_schema: Record<string, unknown> } | null {
  if (!responseFormat || responseFormat.type === 'text') return null;
  if (responseFormat.type === 'json_schema') {
    // `json_schema.strict` (OpenAI's guarantee that every property is fulfilled) has no
    // Anthropic equivalent on a tool's `input_schema`, so it is intentionally not carried
    // over — Claude conforms to the schema as best-effort, not as a hard contract.
    return {
      name: responseFormat.json_schema.name,
      input_schema: responseFormat.json_schema.schema ?? { type: 'object' },
    };
  }
  return { name: RESPONSE_FORMAT_GENERIC_TOOL_NAME, input_schema: { type: 'object' } };
}

/**
 * Builds an Anthropic message array from canonical messages, translating:
 * assistant `tool_calls` → `tool_use` content blocks; `tool` role → a user message
 * with a `tool_result` block (Anthropic carries results on the user turn).
 */
function toAnthropicMessages(messages: ChatMessage[]): { role: 'user' | 'assistant'; content: unknown }[] {
  const out: { role: 'user' | 'assistant'; content: unknown }[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue; // handled by extractSystemText
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: withCacheMarker(m, [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content ?? '' }]),
      });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const blocks: Record<string, unknown>[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.function.arguments || '{}');
        } catch {
          input = {};
        }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      out.push({ role: 'assistant', content: withCacheMarker(m, blocks) });
      continue;
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    out.push({
      role,
      content: m.cache_control ? withCacheMarker(m, [{ type: 'text', text: m.content ?? '' }]) : m.content ?? '',
    });
  }
  return out;
}

/** One SSE event from the Anthropic Messages streaming API. */
interface AnthropicStreamEvent {
  type?: string;
  message?: { usage?: AnthropicUsage };
  delta?: { type?: string; text?: string; stop_reason?: string | null; partial_json?: string };
  usage?: { output_tokens?: number };
  content_block?: { type?: string; id?: string; name?: string };
  /** Content-block index (text and tool_use blocks share one sequence — this is
   * NOT a 0-based ordinal among tool calls). Remapped to a tool-call ordinal in
   * `streamChatCompletion` before it reaches the canonical `ToolCall.index`. */
  index?: number;
}

/**
 * Adapter for Anthropic's Messages API. Translates the canonical OpenAI-shaped
 * request into Anthropic's format (system messages hoisted to a top-level `system`
 * string, required `max_tokens`) and normalizes the response back to OpenAI shape.
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly provider = 'anthropic' as const;

  /**
   * @param req - Canonical request. `system` messages are hoisted; `max_tokens` defaulted.
   * @param creds - Decrypted API key. `baseUrl` is ignored (Anthropic has a fixed host).
   * @returns Normalized (OpenAI-shaped) response.
   * @throws {ProviderError} On a non-2xx response, timeout (504), or network error (502).
   */
  async chatCompletion(req: NormalizedRequest, creds: ProviderCredentials): Promise<NormalizedResponse> {
    const systemText = toAnthropicSystem(req.messages);
    const messages = toAnthropicMessages(req.messages);

    const payload: Record<string, unknown> = {
      model: req.model,
      messages,
      max_tokens: req.max_tokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    };
    if (systemText) payload['system'] = systemText;
    if (req.temperature !== undefined) payload['temperature'] = req.temperature;
    if (req.top_p !== undefined) payload['top_p'] = req.top_p;
    if (req.stop !== undefined) {
      payload['stop_sequences'] = Array.isArray(req.stop) ? req.stop : [req.stop];
    }
    // `response_format` and a non-empty `tools` are mutually exclusive by the time a
    // NormalizedRequest reaches this adapter — enforced in GatewayService (post-merge
    // guard, see `assertResponseFormatToolsCompatible`), not "by construction" here — so
    // this is an if/else, not a merge.
    const forcedFormatTool = toAnthropicResponseFormatTool(req.response_format);
    if (forcedFormatTool) {
      payload['tools'] = [
        {
          name: forcedFormatTool.name,
          description: RESPONSE_FORMAT_TOOL_DESCRIPTION,
          input_schema: forcedFormatTool.input_schema,
        },
      ];
      payload['tool_choice'] = { type: 'tool', name: forcedFormatTool.name };
    } else if (req.tool_choice !== 'none') {
      // `tool_choice: 'none'` → omit both `tools` and `tool_choice` entirely. Anthropic
      // does have a native `tool_choice: { type: 'none' }`, but this adapter doesn't
      // use it (see `toAnthropicToolChoice`'s doc comment for the full rationale).
      const anthropicTools = toAnthropicTools(req.tools);
      if (anthropicTools) payload['tools'] = anthropicTools;
      const anthropicToolChoice = toAnthropicToolChoice(req.tool_choice);
      if (anthropicToolChoice) payload['tool_choice'] = anthropicToolChoice;
    }

    let res: Response;
    try {
      // Through guardedFetch like every other adapter, so the headers deadline is armed
      // in one place. Anthropic's base URL is hardcoded, so `usesCustomBaseUrl` is false
      // and this stays on global fetch — the SSRF dispatcher is for caller-supplied hosts.
      // The extra `AbortSignal.timeout` is the body deadline: guardedFetch's own clock
      // stops at the headers, and res.json() below is read after it returns.
      ({ res } = await guardedFetch(
        `${ANTHROPIC_BASE_URL}/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': creds.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
        },
        false,
        'Anthropic',
        GATEWAY_TIMEOUT_MS,
        // Buffered: `res.json()` below reads the whole body into memory.
        true,
      ));
    } catch (err) {
      // guardedFetch raises its own typed errors; passing one through keeps its status
      // and retriable flag instead of flattening it to a generic 502 network error.
      if (err instanceof ProviderError) throw err;
      const isTimeout = err instanceof Error && err.name === 'TimeoutError';
      throw new ProviderError(
        isTimeout ? 'Anthropic request timed out' : `Anthropic network error: ${(err as Error).message}`,
        isTimeout ? 504 : 502,
        isTimeout ? 'timeout' : 'network_error',
        true,
      );
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`Anthropic upstream error ${res.status}:`, detail);
      throw new ProviderError(
        `Anthropic request failed with status ${res.status}`,
        res.status,
        undefined,
        res.status === 429 || res.status >= 500,
        summarizeProviderDetail(detail),
        parseRetryAfter(res.headers),
      );
    }

    const data = (await res.json()) as AnthropicResponseBody;

    // When `response_format` forced a synthetic tool call, find that tool's block and
    // hand its arguments back as plain JSON message content — the mechanism (a forced
    // tool call under the hood) must stay invisible to the caller. Only skipped if the
    // model unexpectedly didn't call the forced tool, in which case we fall through to
    // the normal text/tool_calls parsing below as a defensive fallback.
    if (forcedFormatTool) {
      const formatBlock = data.content.find(
        (b) => b.type === 'tool_use' && b.name === forcedFormatTool.name,
      );
      if (formatBlock) {
        return {
          id: data.id,
          model: data.model,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: JSON.stringify(formatBlock.input ?? {}),
              },
              finish_reason: 'stop',
            },
          ],
          usage: toUsage(data.usage),
        };
      }
    }

    const text = data.content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
    const toolCalls = data.content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({
        id: b.id ?? '',
        type: 'function' as const,
        function: { name: b.name ?? '', arguments: JSON.stringify(b.input ?? {}) },
      }));

    return {
      id: data.id,
      model: data.model,
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
          finish_reason: mapStopReason(data.stop_reason),
        },
      ],
      usage: toUsage(data.usage),
    };
  }

  /**
   * @param req - Canonical request. `system` messages are hoisted; `max_tokens` defaulted.
   * @param creds - Decrypted API key. `baseUrl` is ignored (Anthropic has a fixed host).
   * @param signal - Optional abort signal; cancels the upstream stream on client disconnect.
   * @returns Async iterable of normalized delta chunks; the terminal frame carries finish_reason + usage.
   * @throws {ProviderError} On a non-2xx response before the first chunk (retriable for 429/5xx).
   */
  async *streamChatCompletion(
    req: NormalizedRequest,
    creds: ProviderCredentials,
    signal?: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const system = toAnthropicSystem(req.messages);
    const messages = toAnthropicMessages(req.messages);

    const payload: Record<string, unknown> = {
      model: req.model,
      messages,
      max_tokens: req.max_tokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
      stream: true,
    };
    if (system) payload['system'] = system;
    if (req.temperature !== undefined) payload['temperature'] = req.temperature;
    if (req.top_p !== undefined) payload['top_p'] = req.top_p;
    if (req.stop !== undefined) {
      payload['stop_sequences'] = Array.isArray(req.stop) ? req.stop : [req.stop];
    }
    // Same response_format/tools mutual-exclusion branching as the non-streaming path.
    const forcedFormatTool = toAnthropicResponseFormatTool(req.response_format);
    if (forcedFormatTool) {
      payload['tools'] = [
        {
          name: forcedFormatTool.name,
          description: RESPONSE_FORMAT_TOOL_DESCRIPTION,
          input_schema: forcedFormatTool.input_schema,
        },
      ];
      payload['tool_choice'] = { type: 'tool', name: forcedFormatTool.name };
    } else if (req.tool_choice !== 'none') {
      // Same 'none' handling as the non-streaming path — see toAnthropicToolChoice's doc comment.
      const anthropicTools = toAnthropicTools(req.tools);
      if (anthropicTools) payload['tools'] = anthropicTools;
      const anthropicToolChoice = toAnthropicToolChoice(req.tool_choice);
      if (anthropicToolChoice) payload['tool_choice'] = anthropicToolChoice;
    }

    // Wrapped exactly like the non-streaming sibling above. Without this a DNS
    // blip or ECONNRESET rejected with a bare TypeError, which `completeStream`
    // treats as "not a ProviderError": it credits the reservation back and
    // rethrows immediately, so no fallback deployment was tried and the caller got
    // a generic 500 where the identical non-streaming request would have recovered.
    let res: Response;
    try {
      // Only the caller's signal is forwarded. guardedFetch adds the headers deadline,
      // and the gap between chunks is policed by parseSseStream below — a whole-request
      // clock here would abort the body mid-answer on any long generation.
      ({ res } = await guardedFetch(
        `${ANTHROPIC_BASE_URL}/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': creds.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify(payload),
          ...(signal ? { signal } : {}),
        },
        false,
        'Anthropic',
      ));
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      throw new ProviderError(
        timedOut ? 'Anthropic stream request timed out' : 'Anthropic stream request failed',
        timedOut ? 504 : 502,
        undefined,
        true,
        err instanceof Error ? err.message : undefined,
      );
    }

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      console.error(`Anthropic stream upstream error ${res.status}:`, detail);
      throw new ProviderError(
        `Anthropic stream request failed with status ${res.status}`,
        res.status,
        undefined,
        res.status === 429 || res.status >= 500,
        summarizeProviderDetail(detail),
        parseRetryAfter(res.headers),
      );
    }

    let promptUsage: AnthropicUsage = {};
    let completionTokens = 0;
    // Anthropic's `index` on content_block_* events is the content block's position
    // (text and tool_use blocks share one sequence), NOT a 0-based ordinal among tool
    // calls the way OpenAI's (and our canonical `ToolCall.index`'s) wire index is. If a
    // text block precedes a tool_use block, Anthropic's content-block index for that
    // first tool call is 1, not 0. Remap content-block index -> tool-call ordinal here
    // so `ToolCall.index` means the same thing ("position among parallel tool calls")
    // regardless of which adapter produced it.
    const toolOrdinalByBlockIndex = new Map<number, number>();
    let nextToolOrdinal = 0;
    // Content-block indices whose tool_use block is the synthetic response_format tool
    // (rather than a real user tool call). Its input_json_delta fragments are re-emitted
    // as plain content deltas below instead of tool_calls deltas — Anthropic's partial_json
    // fragments concatenate to the complete JSON string, the same way text_delta fragments
    // concatenate to the complete text, so no local buffering/accumulation is needed here.
    const formatToolBlockIndices = new Set<number>();
    // Defensive fallback for the forced-tool-call translation (see `content_block_delta`
    // and `message_delta` below): text deltas are suppressed while a response_format tool
    // is forced so the model's prose never concatenates ahead of the JSON. But if the
    // model disobeys the forced tool_choice and returns text instead of calling the tool,
    // the non-streaming path returns that text — buffer the suppressed text here and flush
    // it at the terminal `message_delta` only if no forced tool block ever appeared, so
    // streaming matches the non-streaming path instead of handing the caller an empty stream.
    let suppressedText = '';
    let sawForcedFormatBlock = false;

    for await (const data of parseSseStream(res.body, signal)) {
      let evt: AnthropicStreamEvent;
      try {
        evt = JSON.parse(data) as AnthropicStreamEvent;
      } catch {
        continue;
      }

      switch (evt.type) {
        case 'message_start':
          // Cache counts arrive only here; the final message_delta carries output tokens.
          promptUsage = evt.message?.usage ?? {};
          break;
        case 'content_block_start':
          // A new tool_use block starting carries the call's id/name; arguments
          // stream in afterward via input_json_delta below (minimal, correctness-
          // first mapping — no cross-chunk JSON accumulation is done here).
          if (evt.content_block?.type === 'tool_use' && forcedFormatTool && evt.content_block.name === forcedFormatTool.name) {
            if (evt.index !== undefined) formatToolBlockIndices.add(evt.index);
            sawForcedFormatBlock = true; // the forced tool was called — any buffered preamble is discarded
            break; // suppress the tool_calls chunk — this mechanism must stay invisible to the caller
          }
          if (evt.content_block?.type === 'tool_use') {
            const ordinal = nextToolOrdinal++;
            if (evt.index !== undefined) toolOrdinalByBlockIndex.set(evt.index, ordinal);
            yield {
              delta: '',
              finish_reason: null,
              tool_calls: [
                {
                  id: evt.content_block.id ?? '',
                  type: 'function',
                  function: { name: evt.content_block.name ?? '', arguments: '' },
                  index: ordinal,
                },
              ],
            };
          }
          break;
        case 'content_block_delta':
          // Suppress stray text deltas when a response_format tool call is forced —
          // mirrors the non-streaming path, which only ever returns the forced tool's
          // JSON and never the model's surrounding text (see chatCompletion above). A
          // model occasionally emits a stray text block before the forced tool_use
          // block; without this guard that text would concatenate ahead of the JSON
          // content and break a caller's JSON.parse. The suppressed text is buffered
          // (not dropped) and flushed at `message_delta` if the model never calls the
          // forced tool — that fallback mirrors chatCompletion's fall-through, so a
          // disobeyed forced tool_choice yields the text rather than an empty stream.
          if (evt.delta?.type === 'text_delta' && evt.delta.text) {
            if (forcedFormatTool) {
              suppressedText += evt.delta.text;
            } else {
              yield { delta: evt.delta.text, finish_reason: null };
            }
          }
          if (evt.delta?.type === 'input_json_delta' && evt.index !== undefined && formatToolBlockIndices.has(evt.index)) {
            // The synthetic response_format tool's arguments — re-emitted as plain
            // content, not a tool_calls delta (see formatToolBlockIndices' doc comment).
            yield { delta: evt.delta.partial_json ?? '', finish_reason: null };
          } else if (evt.delta?.type === 'input_json_delta') {
            const ordinal = evt.index !== undefined ? toolOrdinalByBlockIndex.get(evt.index) : undefined;
            yield {
              delta: '',
              finish_reason: null,
              tool_calls: [{ id: '', type: 'function', function: { name: '', arguments: evt.delta.partial_json ?? '' }, index: ordinal }],
            };
          }
          break;
        case 'message_delta': {
          completionTokens = evt.usage?.output_tokens ?? completionTokens;
          // Defensive fallback: if the model ignored the forced tool_choice and returned
          // text instead, emit the text we suppressed rather than handing the caller an
          // empty stream (mirrors chatCompletion's fall-through). Only flushes when no
          // forced tool block appeared — the normal case (tool called) discards the preamble.
          if (forcedFormatTool && !sawForcedFormatBlock && suppressedText) {
            yield { delta: suppressedText, finish_reason: null };
            suppressedText = '';
          }
          // A forced response_format tool call always stops with stop_reason 'tool_use',
          // which mapStopReason maps to 'tool_calls' — override that to 'stop' so the
          // caller sees a normal completion, since the tool call was never real to them.
          const mappedFinishReason = mapStopReason(evt.delta?.stop_reason);
          const finishReason = forcedFormatTool && mappedFinishReason === 'tool_calls' ? 'stop' : mappedFinishReason;
          yield {
            delta: '',
            finish_reason: finishReason,
            usage: toUsage(promptUsage, completionTokens),
          };
          break;
        }
        default:
          break; // ping / message_stop / content_block_stop / non-tool_use content_block_start → ignore
      }
    }
  }
}

/** Singleton Anthropic adapter. */
export const anthropicAdapter = new AnthropicAdapter();
