import { ProviderAdapter, ProviderError, GATEWAY_TIMEOUT_MS } from './adapter';
import type {
  NormalizedRequest,
  NormalizedResponse,
  ProviderCredentials,
  StreamChunk,
  ChatMessage,
  ToolDefinition,
  ToolChoice,
  ResponseFormat,
} from './types';
import { parseSseStream } from './sse-parse';

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
  usage: { input_tokens: number; output_tokens: number };
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
 * Extract and join `system`-role message content into Anthropic's single
 * top-level `system` string (shared by the streaming and non-streaming paths).
 * Non-system messages are translated separately by `toAnthropicMessages`.
 */
function extractSystemText(messages: NormalizedRequest['messages']): string {
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
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
      out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content ?? '' }] });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const blocks: unknown[] = [];
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
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content ?? '' });
  }
  return out;
}

/** One SSE event from the Anthropic Messages streaming API. */
interface AnthropicStreamEvent {
  type?: string;
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
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
    const systemText = extractSystemText(req.messages);
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
      res = await fetch(`${ANTHROPIC_BASE_URL}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': creds.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      });
    } catch (err) {
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
          usage: {
            prompt_tokens: data.usage.input_tokens,
            completion_tokens: data.usage.output_tokens,
            total_tokens: data.usage.input_tokens + data.usage.output_tokens,
          },
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
      usage: {
        prompt_tokens: data.usage.input_tokens,
        completion_tokens: data.usage.output_tokens,
        total_tokens: data.usage.input_tokens + data.usage.output_tokens,
      },
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
    const system = extractSystemText(req.messages);
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

    const res = await fetch(`${ANTHROPIC_BASE_URL}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': creds.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      console.error(`Anthropic stream upstream error ${res.status}:`, detail);
      throw new ProviderError(
        `Anthropic stream request failed with status ${res.status}`,
        res.status,
        undefined,
        res.status === 429 || res.status >= 500,
      );
    }

    let promptTokens = 0;
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
          promptTokens = evt.message?.usage?.input_tokens ?? 0;
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
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            },
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
