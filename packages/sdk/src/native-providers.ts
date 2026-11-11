/**
 * Native Anthropic and Gemini wire formats for BYO (direct-provider) calls.
 *
 * Every other part of the SDK speaks the OpenAI chat-completions shape: the body it
 * builds, the reply it reads, the chunks a stream yields, the messages a tool loop keeps.
 * This module is the one place that knows the two other shapes. It turns an OpenAI-shaped
 * body into an Anthropic Messages or Gemini `generateContent` request, and turns the
 * native reply (whole, or one streamed event at a time) back into OpenAI-shaped data. The
 * translation follows the gateway's own Anthropic and Gemini adapters, so a call made
 * through the gateway and the same call made BYO send the provider the same request.
 *
 * Gemini's call `id` and its `thoughtSignature` survive a round trip only because they
 * ride on the OpenAI-shaped tool call. Gemini 3 models refuse a follow-up turn whose
 * function call has lost its signature, so it is kept as
 * `extra_content.google.thought_signature` (where Gemini's own OpenAI-compatible endpoint
 * puts it) and sent back on the next turn.
 *
 * Mirrors `packages/sdk-python/src/acruxcore/native_providers.py`.
 */
import { randomUUID } from 'node:crypto';
import { acruxcoreError } from './error';

/** The two provider kinds whose native API the SDK speaks. */
export type NativeKind = 'anthropic' | 'gemini';

/** Used when `provider.kind` is `'anthropic'` and no `baseUrl` is given. */
export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
/** Used when `provider.kind` is `'gemini'` and no `baseUrl` is given. */
export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const ANTHROPIC_VERSION = '2023-06-01';
/** Anthropic requires `max_tokens`. The gateway's Anthropic adapter uses the same default,
 * so a call without `maxTokens` stops at the same length either way. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 1024;

const FORMAT_TOOL_DESCRIPTION =
  'Return the final answer using this tool, matching its input schema exactly. Do not respond with plain text.';
const FORMAT_TOOL_GENERIC_NAME = 'structured_output';

/** OpenAI-body keys this module translates. Any other key came from `extraBody` and is
 * copied onto the native payload as it is, so a caller can still reach a native-only field
 * such as Anthropic's `thinking` or Gemini's `safetySettings`. */
const TRANSLATED_KEYS = new Set([
  'model', 'messages', 'tools', 'tool_choice', 'response_format', 'temperature',
  'max_tokens', 'max_completion_tokens', 'top_p', 'stop', 'stream', 'stream_options',
  'reasoning_effort',
]);

type Json = Record<string, unknown>;
type Msg = {
  role?: string;
  content?: unknown;
  tool_calls?: ToolCallLike[];
  tool_call_id?: string;
  cache_control?: unknown;
};
type ToolCallLike = {
  id?: string;
  function?: { name?: string; arguments?: string };
  extra_content?: { google?: { thought_signature?: string }; anthropic?: { thinking_blocks?: Json[] } };
};
type ToolDef = { function: { name: string; description?: string; parameters?: Json } };

/** An OpenAI `chat.completion.chunk`, the shape a BYO stream is read as. */
export interface OpenAiChunk {
  id: string;
  model: string;
  choices: { index: number; delta: Json; finish_reason: string | null }[];
  usage?: Json;
}

/** A stateful translator for one native stream. */
export interface NativeStream {
  /** One parsed SSE `data` object in, the OpenAI chunks it becomes (often none) out. */
  feed(event: Json): OpenAiChunk[];
  /** True once the provider has said the stream is complete. */
  readonly done: boolean;
}

// ── shared helpers ─────────────────────────────────────────────────────────

function contentText(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p): p is { type: string; text?: string } => typeof p === 'object' && p !== null && p.type === 'text')
    .map((p) => p.text ?? '')
    .join('');
}

function parseDataUrl(url: string): { mediaType: string; data: string } | undefined {
  if (!url.startsWith('data:') || !url.includes(';base64,')) return undefined;
  const [head, data] = url.slice('data:'.length).split(';base64,', 2);
  return head.startsWith('image/') ? { mediaType: head, data } : undefined;
}

function parseArgs(args: string | undefined): unknown {
  try {
    return JSON.parse(args || '{}');
  } catch {
    return {};
  }
}

function isPlainObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Copy every key this module does not translate (`extraBody`) onto the payload. A plain
 * object merges one level into one the translation built, so
 * `extraBody: { generationConfig: { thinkingConfig } }` adds to the `generationConfig`
 * that `temperature` filled instead of replacing it.
 *
 * @throws {acruxcoreError} `VALIDATION_ERROR` when an `extraBody` key would overwrite a
 *   value the translation set from a named option.
 */
/** The output token limit, from `max_tokens` or OpenAI's newer `max_completion_tokens`
 * (the SDK refuses a call that sets both). */
function outputLimit(body: Json): number | undefined {
  return (body['max_tokens'] ?? body['max_completion_tokens']) as number | undefined;
}

function mergePassthrough(payload: Json, body: Json): void {
  for (const [key, value] of Object.entries(body)) {
    if (TRANSLATED_KEYS.has(key)) continue;
    if (!(key in payload)) {
      payload[key] = value;
      continue;
    }
    const existing = payload[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      const clash = Object.keys(value).filter((k) => k in existing).sort();
      if (clash.length) {
        throw new acruxcoreError(
          `acruxcore: extraBody.${key} sets ${clash.join(', ')}, which the SDK already sets from a named option. Pass it once.`,
          'VALIDATION_ERROR',
        );
      }
      Object.assign(existing, value);
      continue;
    }
    throw new acruxcoreError(
      `acruxcore: extraBody sets '${key}', which the SDK already sets from a named option. Pass it once.`,
      'VALIDATION_ERROR',
    );
  }
}

function openAiUsage(prompt: number, completion: number, total?: number, cached = 0, reasoning = 0): Json {
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total ?? prompt + completion,
    ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    ...(reasoning > 0 ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}),
  };
}

function openAiResponse(
  id: string, model: string, text: string, toolCalls: Json[], finishReason: string | null, usage: Json,
): Json {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finish_reason: finishReason,
    }],
    usage,
  };
}

function chunk(id: string, model: string, delta: Json, finishReason: string | null = null, usage?: Json): OpenAiChunk {
  return { id, model, choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}) };
}

function stopList(stop: unknown): unknown[] {
  return Array.isArray(stop) ? stop : [stop];
}

// ── Anthropic ──────────────────────────────────────────────────────────────

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Anthropic's `input_tokens` leaves out cache reads and writes; OpenAI's `prompt_tokens`
 * is the whole prompt, so the three are added back together. */
function anthropicUsage(u: AnthropicUsage, outputTokens?: number): Json {
  const read = u.cache_read_input_tokens ?? 0;
  const written = u.cache_creation_input_tokens ?? 0;
  const prompt = (u.input_tokens ?? 0) + read + written;
  return openAiUsage(prompt, outputTokens ?? u.output_tokens ?? 0, undefined, read);
}

function anthropicStop(stop: string | null | undefined): string | null {
  if (!stop) return null;
  const map: Record<string, string> = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls' };
  return map[stop] ?? stop;
}

function anthropicBlocks(content: unknown[]): Json[] {
  const blocks: Json[] = [];
  for (const raw of content) {
    const part = raw as { type?: string; text?: string; image_url?: { url?: string } };
    if (part.type === 'text') blocks.push({ type: 'text', text: part.text ?? '' });
    else if (part.type === 'image_url') {
      const url = part.image_url?.url ?? '';
      const data = parseDataUrl(url);
      blocks.push({
        type: 'image',
        source: data ? { type: 'base64', media_type: data.mediaType, data: data.data } : { type: 'url', url },
      });
    }
  }
  return blocks;
}

function withCache(m: Msg, blocks: Json[]): Json[] {
  const last = blocks[blocks.length - 1];
  if (m.cache_control && last) last['cache_control'] = m.cache_control;
  return blocks;
}

function anthropicSystem(messages: Msg[]): unknown {
  const system = messages.filter((m) => m.role === 'system');
  if (system.some((m) => m.cache_control)) {
    return system.map((m) => ({
      type: 'text',
      text: contentText(m.content),
      ...(m.cache_control ? { cache_control: m.cache_control } : {}),
    }));
  }
  const text = system.map((m) => contentText(m.content)).join('\n');
  return text || undefined;
}

/** OpenAI messages to Anthropic's. A `tool` result becomes a `tool_result` block on a user
 * turn, and consecutive results merge into one user turn, since Anthropic wants every
 * result of a parallel call in the turn right after the call. */
function anthropicMessages(messages: Msg[]): { role: string; content: unknown }[] {
  const out: { role: string; content: unknown }[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      const blocks = withCache(m, [{ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: contentText(m.content) }]);
      const prev = out[out.length - 1];
      const prevBlocks = prev && prev.role === 'user' && Array.isArray(prev.content) ? (prev.content as Json[]) : undefined;
      if (prevBlocks && prevBlocks[0]?.['type'] === 'tool_result') prevBlocks.push(...blocks);
      else out.push({ role: 'user', content: blocks });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const blocks: Json[] = [];
      const text = contentText(m.content);
      if (text) blocks.push({ type: 'text', text });
      // Thinking blocks go first, unchanged: Anthropic refuses a tool loop turn with
      // thinking on whose tool_use lost them. They ride on a call's extra_content.
      for (const tc of m.tool_calls) blocks.unshift(...(tc.extra_content?.anthropic?.thinking_blocks ?? []));
      for (const tc of m.tool_calls) {
        blocks.push({ type: 'tool_use', id: tc.id ?? '', name: tc.function?.name ?? '', input: parseArgs(tc.function?.arguments) });
      }
      out.push({ role: 'assistant', content: withCache(m, blocks) });
      continue;
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (Array.isArray(m.content)) out.push({ role, content: withCache(m, anthropicBlocks(m.content)) });
    else if (m.cache_control) out.push({ role, content: withCache(m, [{ type: 'text', text: (m.content as string) ?? '' }]) });
    else out.push({ role, content: (m.content as string | null) ?? '' });
  }
  return out;
}

function anthropicFormatTool(rf: unknown): { name: string; input_schema: unknown } | undefined {
  if (!isPlainObject(rf) || rf['type'] === 'text') return undefined;
  if (rf['type'] === 'json_schema') {
    const js = (rf['json_schema'] ?? {}) as { name?: string; schema?: unknown };
    return { name: js.name || FORMAT_TOOL_GENERIC_NAME, input_schema: js.schema ?? { type: 'object' } };
  }
  return { name: FORMAT_TOOL_GENERIC_NAME, input_schema: { type: 'object' } };
}

function anthropicPayload(body: Json, stream: boolean): { payload: Json; formatTool?: string } {
  const messages = (body['messages'] ?? []) as Msg[];
  const payload: Json = {
    model: body['model'],
    messages: anthropicMessages(messages),
    max_tokens: outputLimit(body) || ANTHROPIC_DEFAULT_MAX_TOKENS,
  };
  const system = anthropicSystem(messages);
  if (system) payload['system'] = system;
  if (body['temperature'] !== undefined) payload['temperature'] = body['temperature'];
  if (body['top_p'] !== undefined) payload['top_p'] = body['top_p'];
  if (body['stop'] !== undefined) payload['stop_sequences'] = stopList(body['stop']);
  if (stream) payload['stream'] = true;

  const formatTool = anthropicFormatTool(body['response_format']);
  const tools = body['tools'] as ToolDef[] | undefined;
  const toolChoice = body['tool_choice'];
  if (formatTool) {
    if (tools?.length) {
      throw new acruxcoreError(
        'acruxcore: an Anthropic BYO call cannot take responseFormat together with tools — Anthropic has no ' +
          'response_format, and the SDK sends it as a forced tool call. Ask for the final answer as a tool call instead.',
        'VALIDATION_ERROR',
      );
    }
    payload['tools'] = [{ ...formatTool, description: FORMAT_TOOL_DESCRIPTION }];
    payload['tool_choice'] = { type: 'tool', name: formatTool.name };
  } else if (tools?.length && toolChoice !== 'none') {
    payload['tools'] = tools.map((t) => ({
      name: t.function.name,
      ...(t.function.description ? { description: t.function.description } : {}),
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }));
    if (toolChoice === 'auto') payload['tool_choice'] = { type: 'auto' };
    else if (toolChoice === 'required') payload['tool_choice'] = { type: 'any' };
    else if (isPlainObject(toolChoice)) {
      payload['tool_choice'] = { type: 'tool', name: (toolChoice['function'] as { name: string }).name };
    }
  }
  mergePassthrough(payload, body);
  // Anthropic refuses a forced tool with thinking on, and the forced tool is the only way
  // it returns response_format, so the structured answer wins.
  if (formatTool) delete payload['thinking'];
  return { payload, formatTool: formatTool?.name };
}

interface AnthropicBlock { type?: string; text?: string; id?: string; name?: string; input?: unknown }

const THINKING_TYPES = new Set(['thinking', 'redacted_thinking']);

/** Put a turn's thinking blocks on its first tool call, where the next request reads them
 * back from (the same place a Gemini thought signature rides). */
function withThinking<T extends Json>(call: T, thinking: Json[]): T {
  if (thinking.length) (call as Json)['extra_content'] = { anthropic: { thinking_blocks: thinking } };
  return call;
}

function anthropicResponse(data: Json, formatTool: string | undefined): Json {
  const blocks = (data['content'] ?? []) as AnthropicBlock[];
  const usage = anthropicUsage((data['usage'] ?? {}) as AnthropicUsage);
  const id = data['id'] as string;
  const model = data['model'] as string;
  if (formatTool) {
    const block = blocks.find((b) => b.type === 'tool_use' && b.name === formatTool);
    if (block) return openAiResponse(id, model, JSON.stringify(block.input ?? {}), [], 'stop', usage);
  }
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  const calls = blocks
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id ?? '', type: 'function', function: { name: b.name ?? '', arguments: JSON.stringify(b.input ?? {}) } }));
  if (calls[0]) withThinking(calls[0], (blocks as unknown as Json[]).filter((b) => THINKING_TYPES.has(String(b['type']))));
  return openAiResponse(id, model, text, calls, anthropicStop(data['stop_reason'] as string | null), usage);
}

/**
 * Anthropic's streamed events to OpenAI chunks. Anthropic numbers content blocks, text and
 * tool_use in one sequence; OpenAI numbers tool calls on their own, so the block index is
 * mapped to a tool-call ordinal.
 */
class AnthropicStream implements NativeStream {
  private id = `msg_${randomUUID().replace(/-/g, '')}`;
  private promptUsage: AnthropicUsage = {};
  private readonly ordinalByBlock = new Map<number, number>();
  private readonly formatBlocks = new Set<number>();
  private suppressed = '';
  private sawFormatBlock = false;
  private readonly thinking: Json[] = [];
  private readonly thinkingByBlock = new Map<number, Json>();
  done = false;

  constructor(private model: string, private readonly formatTool: string | undefined) {}

  feed(event: Json): OpenAiChunk[] {
    const index = event['index'] as number | undefined;
    switch (event['type']) {
      case 'error': {
        const err = (event['error'] ?? {}) as { message?: string };
        throw new acruxcoreError(
          `acruxcore: Anthropic stream ended with an error — ${err.message ?? JSON.stringify(err)}`,
          'PROVIDER_ERROR', undefined, event,
        );
      }
      case 'message_start': {
        const msg = (event['message'] ?? {}) as { id?: string; model?: string; usage?: AnthropicUsage };
        this.id = msg.id ?? this.id;
        this.model = msg.model ?? this.model;
        this.promptUsage = msg.usage ?? {};
        return [];
      }
      case 'content_block_start': {
        const block = (event['content_block'] ?? {}) as AnthropicBlock;
        if (THINKING_TYPES.has(String(block.type)) && index !== undefined) {
          const kept: Json = { ...(block as unknown as Json) };
          this.thinking.push(kept);
          this.thinkingByBlock.set(index, kept);
          return [];
        }
        if (block.type !== 'tool_use' || index === undefined) return [];
        if (this.formatTool && block.name === this.formatTool) {
          this.formatBlocks.add(index);
          this.sawFormatBlock = true;
          return [];
        }
        const ordinal = this.ordinalByBlock.size;
        this.ordinalByBlock.set(index, ordinal);
        const call: Json = { index: ordinal, id: block.id ?? '', type: 'function', function: { name: block.name ?? '', arguments: '' } };
        if (ordinal === 0) withThinking(call, this.thinking);
        return [chunk(this.id, this.model, { tool_calls: [call] })];
      }
      case 'content_block_delta': {
        const delta = (event['delta'] ?? {}) as {
          type?: string; text?: string; partial_json?: string; thinking?: string; signature?: string;
        };
        const kept = index === undefined ? undefined : this.thinkingByBlock.get(index);
        if (kept) {
          if (delta.type === 'thinking_delta') kept['thinking'] = String(kept['thinking'] ?? '') + (delta.thinking ?? '');
          else if (delta.type === 'signature_delta') kept['signature'] = String(kept['signature'] ?? '') + (delta.signature ?? '');
          return [];
        }
        if (delta.type === 'text_delta' && delta.text) {
          if (this.formatTool) {
            this.suppressed += delta.text;
            return [];
          }
          return [chunk(this.id, this.model, { content: delta.text })];
        }
        if (delta.type === 'input_json_delta' && delta.partial_json && index !== undefined) {
          if (this.formatBlocks.has(index)) return [chunk(this.id, this.model, { content: delta.partial_json })];
          const ordinal = this.ordinalByBlock.get(index);
          if (ordinal !== undefined) {
            return [chunk(this.id, this.model, { tool_calls: [{ index: ordinal, function: { arguments: delta.partial_json } }] })];
          }
        }
        return [];
      }
      case 'message_delta': {
        const out: OpenAiChunk[] = [];
        if (this.formatTool && !this.sawFormatBlock && this.suppressed) {
          out.push(chunk(this.id, this.model, { content: this.suppressed }));
          this.suppressed = '';
        }
        let finish = anthropicStop(((event['delta'] ?? {}) as { stop_reason?: string }).stop_reason);
        if (this.formatTool && finish === 'tool_calls') finish = 'stop';
        const outputTokens = ((event['usage'] ?? {}) as { output_tokens?: number }).output_tokens;
        out.push(chunk(this.id, this.model, {}, finish, anthropicUsage(this.promptUsage, outputTokens)));
        return out;
      }
      case 'message_stop':
        this.done = true;
        return [];
      default:
        return [];
    }
  }
}

// ── Gemini ─────────────────────────────────────────────────────────────────

function geminiPart(raw: unknown): Json {
  const part = raw as { type?: string; text?: string; image_url?: { url?: string } };
  if (part.type === 'text') return { text: part.text ?? '' };
  const data = parseDataUrl(part.image_url?.url ?? '');
  if (!data) {
    throw new acruxcoreError(
      'acruxcore: Gemini reads an image only as a data:image/...;base64 URL; send the image bytes inline instead of a link.',
      'VALIDATION_ERROR',
    );
  }
  return { inlineData: { mimeType: data.mediaType, data: data.data } };
}

/** OpenAI messages to Gemini `contents`. A `tool` result becomes a `functionResponse`,
 * which Gemini keys by function name, so the name is looked up from the assistant turn that
 * made the call. Consecutive results merge into one turn, as Gemini wants every response
 * of a parallel call together. */
function geminiContents(messages: Msg[]): { role: string; parts: Json[] }[] {
  const names = new Map<string, string>();
  const out: { role: string; parts: Json[] }[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      const callId = m.tool_call_id ?? '';
      const text = contentText(m.content);
      let response: unknown;
      try {
        response = text ? JSON.parse(text) : {};
      } catch {
        response = { result: text };
      }
      if (!isPlainObject(response)) response = { result: response };
      const fr: Json = { name: names.get(callId) ?? callId, response };
      if (callId && names.has(callId) && !callId.startsWith('acx_')) fr['id'] = callId;
      const part = { functionResponse: fr };
      const prev = out[out.length - 1];
      if (prev && prev.role === 'user' && prev.parts[0] && 'functionResponse' in prev.parts[0]) prev.parts.push(part);
      else out.push({ role: 'user', parts: [part] });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const parts: Json[] = [];
      const text = contentText(m.content);
      if (text) parts.push({ text });
      for (const tc of m.tool_calls) {
        const name = tc.function?.name ?? '';
        const callId = tc.id ?? '';
        if (callId) names.set(callId, name);
        const call: Json = { name, args: parseArgs(tc.function?.arguments) };
        // An id the SDK made up (Gemini sent none) means nothing to Gemini.
        if (callId && !callId.startsWith('acx_')) call['id'] = callId;
        const signature = tc.extra_content?.google?.thought_signature;
        parts.push({ functionCall: call, ...(signature ? { thoughtSignature: signature } : {}) });
      }
      out.push({ role: 'model', parts });
      continue;
    }
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (Array.isArray(m.content)) out.push({ role, parts: m.content.map(geminiPart) });
    else out.push({ role, parts: [{ text: (m.content as string | null) ?? '' }] });
  }
  return out;
}

function geminiPayload(body: Json): Json {
  const messages = (body['messages'] ?? []) as Msg[];
  const payload: Json = { contents: geminiContents(messages) };
  const system = messages.filter((m) => m.role === 'system').map((m) => contentText(m.content)).join('\n');
  if (system) payload['systemInstruction'] = { parts: [{ text: system }] };
  const config: Json = {};
  if (body['temperature'] !== undefined) config['temperature'] = body['temperature'];
  if (outputLimit(body) !== undefined) config['maxOutputTokens'] = outputLimit(body);
  if (body['top_p'] !== undefined) config['topP'] = body['top_p'];
  if (body['stop'] !== undefined) config['stopSequences'] = stopList(body['stop']);
  const rf = body['response_format'];
  if (isPlainObject(rf) && rf['type'] !== 'text') {
    config['responseMimeType'] = 'application/json';
    const schema = rf['type'] === 'json_schema' ? (rf['json_schema'] as { schema?: unknown } | undefined)?.schema : undefined;
    // The full-JSON-Schema field, not the older OpenAPI-subset `responseSchema`, so a
    // zod-generated schema with `$schema` or `additionalProperties` is taken as it is.
    if (schema) config['responseJsonSchema'] = schema;
  }
  if (Object.keys(config).length) payload['generationConfig'] = config;
  const tools = body['tools'] as ToolDef[] | undefined;
  const toolChoice = body['tool_choice'];
  if (tools?.length && toolChoice !== 'none') {
    payload['tools'] = [{
      functionDeclarations: tools.map((t) => ({
        name: t.function.name,
        ...(t.function.description ? { description: t.function.description } : {}),
        // The full-JSON-Schema field: `parameters` is an OpenAPI subset that rejects
        // `additionalProperties`, which every zod-generated schema carries.
        parametersJsonSchema: t.function.parameters ?? { type: 'object', properties: {} },
      })),
    }];
    if (toolChoice === 'auto') payload['toolConfig'] = { functionCallingConfig: { mode: 'AUTO' } };
    else if (toolChoice === 'required') payload['toolConfig'] = { functionCallingConfig: { mode: 'ANY' } };
    else if (isPlainObject(toolChoice)) {
      payload['toolConfig'] = {
        functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [(toolChoice['function'] as { name: string }).name] },
      };
    }
  }
  mergePassthrough(payload, body);
  return payload;
}

interface GeminiUsageMeta {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}
interface GeminiPart { text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { id?: string; name?: string; args?: unknown } }
interface GeminiCandidate { content?: { parts?: GeminiPart[] }; finishReason?: string }

/** Gemini counts thinking apart from the answer and bills it as output; OpenAI counts it
 * inside `completion_tokens`, so the two are added. */
function geminiUsage(meta: GeminiUsageMeta): Json {
  const prompt = meta.promptTokenCount ?? 0;
  const thoughts = meta.thoughtsTokenCount ?? 0;
  const completion = (meta.candidatesTokenCount ?? 0) + thoughts;
  return openAiUsage(prompt, completion, meta.totalTokenCount ?? prompt + completion, meta.cachedContentTokenCount ?? 0, thoughts);
}

function geminiFinish(reason: string | undefined): string | null {
  if (reason === undefined) return null;
  if (reason === 'MAX_TOKENS') return 'length';
  if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(reason)) return 'content_filter';
  return 'stop';
}

function geminiToolCall(part: GeminiPart): Json {
  const fc = part.functionCall ?? {};
  return {
    id: fc.id || `acx_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'function',
    function: { name: fc.name ?? '', arguments: JSON.stringify(fc.args ?? {}) },
    ...(part.thoughtSignature ? { extra_content: { google: { thought_signature: part.thoughtSignature } } } : {}),
  };
}

/** A thought summary (`thought: true`) is the model's reasoning, not its answer. */
function geminiText(parts: GeminiPart[]): string {
  return parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text as string).join('');
}

function geminiResponse(data: Json, model: string): Json {
  const candidates = (data['candidates'] ?? []) as GeminiCandidate[];
  if (!candidates.length) {
    const block = (data['promptFeedback'] as { blockReason?: string } | undefined)?.blockReason;
    throw new acruxcoreError(
      `acruxcore: Gemini returned no answer${block ? ` — prompt blocked: ${block}` : ''}.`,
      'PROVIDER_ERROR', undefined, data,
    );
  }
  const parts = candidates[0].content?.parts ?? [];
  const calls = parts.filter((p) => p.functionCall).map(geminiToolCall);
  const finish = calls.length ? 'tool_calls' : geminiFinish(candidates[0].finishReason);
  return openAiResponse(
    (data['responseId'] as string | undefined) ?? `gemini-${randomUUID()}`,
    (data['modelVersion'] as string | undefined) ?? model,
    geminiText(parts), calls, finish, geminiUsage((data['usageMetadata'] ?? {}) as GeminiUsageMeta),
  );
}

/** Gemini's streamed frames to OpenAI chunks. Gemini sends each function call whole, in one
 * frame, so each becomes one complete tool-call delta. */
class GeminiStream implements NativeStream {
  private id = `gemini-${randomUUID()}`;
  private calls = 0;
  readonly done = false;

  constructor(private model: string) {}

  feed(frame: Json): OpenAiChunk[] {
    if (frame['error']) {
      const err = frame['error'] as { message?: string };
      throw new acruxcoreError(
        `acruxcore: Gemini stream ended with an error — ${err.message ?? JSON.stringify(err)}`,
        'PROVIDER_ERROR', undefined, frame,
      );
    }
    this.id = (frame['responseId'] as string | undefined) ?? this.id;
    this.model = (frame['modelVersion'] as string | undefined) ?? this.model;
    const candidate = ((frame['candidates'] ?? [{}]) as GeminiCandidate[])[0] ?? {};
    const parts = candidate.content?.parts ?? [];
    const delta: Json = {};
    const text = geminiText(parts);
    if (text) delta['content'] = text;
    const toolCalls = parts.filter((p) => p.functionCall).map((p) => ({ index: this.calls++, ...geminiToolCall(p) }));
    if (toolCalls.length) delta['tool_calls'] = toolCalls;
    const reason = candidate.finishReason;
    const finish = reason === undefined ? null : this.calls ? 'tool_calls' : geminiFinish(reason);
    const usage = frame['usageMetadata'] && reason ? geminiUsage(frame['usageMetadata'] as GeminiUsageMeta) : undefined;
    if (!Object.keys(delta).length && finish === null && !usage) return [];
    return [chunk(this.id, this.model, delta, finish, usage)];
  }
}

// ── public entry points ────────────────────────────────────────────────────

/** What one native BYO call sends. */
export interface NativeRequest {
  url: string;
  headers: Record<string, string>;
  payload: Json;
  /** The forced tool an Anthropic `response_format` became; pass it to the reply translation. */
  formatTool?: string;
}

/**
 * Build the native request for one BYO call.
 *
 * @param kind - `'anthropic'` or `'gemini'`.
 * @param baseUrl - The provider's base URL, without a trailing slash.
 * @param apiKey - Sent as `x-api-key` (Anthropic) or `x-goog-api-key` (Gemini).
 * @param body - The OpenAI-shaped body the SDK built, `extraBody` included.
 * @param stream - Whether to ask for a stream.
 * @returns The URL, headers and payload to send.
 * @throws {acruxcoreError} `VALIDATION_ERROR` for a body the native API cannot take.
 */
export function nativeRequest(kind: NativeKind, baseUrl: string, apiKey: string, body: Json, stream: boolean): NativeRequest {
  if (kind === 'anthropic') {
    const { payload, formatTool } = anthropicPayload(body, stream);
    return {
      url: `${baseUrl}/messages`,
      headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'Content-Type': 'application/json' },
      payload,
      formatTool,
    };
  }
  const model = String(body['model']);
  const modelPath = model.startsWith('models/') ? model : `models/${model}`;
  const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  return {
    url: `${baseUrl}/${modelPath}:${method}`,
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    payload: geminiPayload(body),
  };
}

/**
 * Translate a native (non-streamed) reply into an OpenAI `chat.completion` body.
 *
 * @throws {acruxcoreError} `PROVIDER_ERROR` when Gemini returns no candidate.
 */
export function nativeResponse(kind: NativeKind, data: Json, model: string, formatTool: string | undefined): Json {
  return kind === 'anthropic' ? anthropicResponse(data, formatTool) : geminiResponse(data, model);
}

/** A stateful translator for one native stream. */
export function nativeStream(kind: NativeKind, model: string, formatTool: string | undefined): NativeStream {
  return kind === 'anthropic' ? new AnthropicStream(model, formatTool) : new GeminiStream(model);
}
