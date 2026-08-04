import type { ChatMessage } from '../../gateway/providers/types';

/**
 * One `llm`-kind span's CAPTURED payload, exactly as it comes off
 * `span_payloads` — deliberately `unknown`, because the payload is whatever
 * its producer wrote and there are several producers with different shapes
 * (see {@link normalizeInput} / {@link normalizeOutput}). Ordered
 * chronologically by the caller.
 */
export interface LlmSpanForHistory {
  input: unknown;
  output: unknown;
}

/** Roles a captured message may carry — anything else is not a chat message. */
const CHAT_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/** True when `value` is object-shaped (and not an array or null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrows a captured value to a chat message: object-shaped with a known
 * `role`. Fields are passed through untouched (never rewritten), so a
 * replayed message is byte-identical to what the model originally saw.
 */
function isChatMessage(value: unknown): value is ChatMessage {
  return isRecord(value) && typeof value['role'] === 'string' && CHAT_ROLES.has(value['role']);
}

/**
 * Normalizes a captured span `input` to the message array sent to the model.
 * Two producers write this field and they disagree on the shape:
 *
 * - `gateway-trace.hook.ts` writes the bare array (`request.messages`).
 * - Both published SDKs' auto-trace writes `{ messages: [...] }`
 *   (`packages/sdk/src/client.ts`, `packages/sdk-python/.../client.py`) — and
 *   a gateway-path `chat({ trace: { sessionId } })` call reports one of these
 *   IN ADDITION to the gateway's own span.
 *
 * Anything else (a hand-ingested span with a free-form `input`, capture from
 * a non-chat call) yields null so the caller can skip the span instead of
 * failing the whole reconstruction.
 *
 * @param input - The raw captured `span_payloads.input`.
 * @returns The messages sent to the model, or null if this payload does not
 *   describe a chat call.
 */
function normalizeInput(input: unknown): ChatMessage[] | null {
  const candidate = Array.isArray(input) ? input : isRecord(input) ? input['messages'] : null;
  if (!Array.isArray(candidate) || candidate.length === 0) return null;
  return candidate.every(isChatMessage) ? (candidate as ChatMessage[]) : null;
}

/**
 * Normalizes a captured span `output` to the assistant message the model
 * returned. Mirrors {@link normalizeInput}'s producer split: the gateway hook
 * captures the full response body (`{ choices: [{ message }] }`), the SDKs
 * capture the bare message.
 *
 * @param output - The raw captured `span_payloads.output`.
 * @returns The assistant message, or null if this payload does not carry one.
 */
function normalizeOutput(output: unknown): ChatMessage | null {
  if (!isRecord(output)) return null;
  const choices = output['choices'];
  if (Array.isArray(choices)) {
    const message = isRecord(choices[0]) ? choices[0]['message'] : null;
    return isChatMessage(message) ? message : null;
  }
  return isChatMessage(output) ? output : null;
}

/**
 * Reconstructs one trace's own new exchange from its `llm`-kind spans, for
 * threading into a later turn's replayed `history` (FAQ Q19). Deliberately
 * trace-scoped — a trace's own spans may already contain resent history from
 * earlier turns if the calling app resends the growing conversation on every
 * call, so this only extracts what THIS trace newly contributed:
 *
 * 0. Every span's payload is normalized first ({@link normalizeInput} /
 *    {@link normalizeOutput}) and a span whose payload describes no chat call
 *    is dropped — history is best-effort, and one unreadable span must never
 *    fail the dataset build around it.
 * 1. From the first usable span's `input`, take only the last `user`-role
 *    message — the new ask for this turn, correct even if earlier turns are
 *    also present in the same array (the newest user message is always last).
 * 2. Append that span's `output`.
 * 3. For each subsequent span (an intra-trace tool-loop follow-up call),
 *    diff its `input` against `[...previous input, previous output]`: any
 *    messages beyond that length are what the client appended (typically a
 *    `tool` role result). Append those, then that span's `output`. If the
 *    lengths/content don't line up (an integration that isn't append-only),
 *    skip the diff and just append the span's `output` — degrade instead of
 *    throwing away the whole reconstruction.
 * 4. A span that neither extends the previous input NOR returns a different
 *    message described the SAME turn twice and is dropped. That is the
 *    gateway-path SDK case: the gateway writes an `llm` span and the SDK
 *    self-reports one for the identical exchange, and without this the turn's
 *    reply would appear twice in the history.
 *
 * @param llmSpans - This trace's `llm`-kind spans, oldest first.
 * @returns The reconstructed exchange for this trace, or `[]` when no span
 *   carried a readable chat payload.
 */
export function buildTraceExchange(llmSpans: LlmSpanForHistory[]): ChatMessage[] {
  const usable = llmSpans
    .map((span) => ({ input: normalizeInput(span.input), message: normalizeOutput(span.output) }))
    .filter((span): span is { input: ChatMessage[]; message: ChatMessage } => span.input !== null && span.message !== null);
  if (usable.length === 0) return [];

  const first = usable[0]!;
  const lastUserMessage = [...first.input].reverse().find((m) => m.role === 'user');
  const exchange: ChatMessage[] = [];
  if (lastUserMessage) exchange.push(lastUserMessage);
  exchange.push(first.message);

  let previousInput = first.input;
  let previousMessage = first.message;
  for (let i = 1; i < usable.length; i++) {
    const span = usable[i]!;
    const expectedPrefix = [...previousInput, previousMessage];
    const extendsPrefix =
      span.input.length > expectedPrefix.length &&
      expectedPrefix.every((m, idx) => JSON.stringify(m) === JSON.stringify(span.input[idx]));

    // Step 4: contributed nothing new — the same turn reported twice.
    if (!extendsPrefix && JSON.stringify(span.message) === JSON.stringify(previousMessage)) continue;

    if (extendsPrefix) {
      exchange.push(...span.input.slice(expectedPrefix.length));
    }
    exchange.push(span.message);

    previousInput = span.input;
    previousMessage = span.message;
  }

  return exchange;
}

/**
 * Trims a history down to something a provider will actually accept, by
 * dropping messages whose tool-call partner is missing:
 *
 * - From the END, an assistant message carrying `tool_calls` with no tool
 *   result after it — a trace that was abandoned mid tool-loop. OpenAI
 *   rejects an unanswered `tool_calls` outright.
 * - From the FRONT, anything before the first `user` message — an orphan
 *   `tool` result (or an assistant `tool_calls` whose results were cut) left
 *   behind by {@link capHistoryBytes}. Trimming to a `user` boundary also
 *   keeps the array valid for Anthropic, which requires the conversation to
 *   open with a user message.
 *
 * Idempotent, so it is safe to apply both at build time and again before a
 * replay (`cell.processor`) for rows written before it existed.
 *
 * @param messages - The history, oldest first.
 * @returns A replayable subrange, or `[]` if nothing replayable remains.
 */
export function sanitizeForReplay(messages: ChatMessage[]): ChatMessage[] {
  let end = messages.length;
  while (end > 0) {
    const last = messages[end - 1]!;
    if (last.role === 'assistant' && last.tool_calls && last.tool_calls.length > 0) end -= 1;
    else break;
  }

  let start = 0;
  while (start < end && messages[start]!.role !== 'user') start += 1;

  return start === 0 && end === messages.length ? messages : messages.slice(start, end);
}

/**
 * Drops the oldest messages from `messages` until the JSON-serialized array
 * fits within `maxBytes`, then repairs the cut with
 * {@link sanitizeForReplay} — trimming by raw size alone can slice a tool
 * round trip in half and leave a leading `tool` result that every provider
 * rejects, which would fail every run cell for that example. A truncated
 * history beats none, so this never throws or returns null for an
 * over-budget input.
 *
 * @param messages - The reconstructed history, oldest first.
 * @param maxBytes - The serialized-size ceiling.
 * @returns `messages` unchanged if already within budget and replayable,
 *   otherwise a replayable suffix of it that fits (possibly empty).
 */
export function capHistoryBytes(messages: ChatMessage[], maxBytes: number): ChatMessage[] {
  let remaining = messages;
  while (remaining.length > 0 && Buffer.byteLength(JSON.stringify(remaining), 'utf8') > maxBytes) {
    remaining = remaining.slice(1);
  }
  return sanitizeForReplay(remaining);
}
