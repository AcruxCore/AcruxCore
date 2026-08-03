import type { ChatMessage, ChatCompletionChoice } from '@/api/types';

/** Hard cap on tool-calling round-trips before the playground stops with a notice. */
export const MAX_TOOL_ITERATIONS = 10;

/** A tool call the model requested, with its arguments parsed from the JSON string. */
export interface PendingToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** A result the caller supplies for one pending tool call. */
export interface ToolResultInput {
  toolCallId: string;
  content: string;
}

/** Outcome of inspecting a model choice: whether the loop is done and what calls are pending. */
export interface LoopStep {
  done: boolean;
  assistantMessage: ChatMessage;
  pendingCalls: PendingToolCall[];
}

/**
 * Inspects a model choice: if it carries tool_calls, returns them parsed as pending
 * (loop continues); otherwise marks the loop done.
 *
 * @param _messages - Current transcript (unused here; kept for call-site symmetry).
 * @param choice - The model's returned choice.
 * @returns Whether the loop is done, the assistant message to append, and pending calls.
 */
export function nextLoopStep(_messages: ChatMessage[], choice: ChatCompletionChoice): LoopStep {
  const calls = choice.message.tool_calls ?? [];
  const isCalling = choice.finish_reason === 'tool_calls' && calls.length > 0;
  return {
    done: !isCalling,
    assistantMessage: { role: 'assistant', content: choice.message.content ?? null, ...(calls.length > 0 ? { tool_calls: calls } : {}) },
    pendingCalls: calls.map((c) => ({ id: c.id, name: c.function.name, arguments: safeParse(c.function.arguments) })),
  };
}

/** Parses a tool-call arguments string; returns {} on malformed JSON (never throws). */
function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Extends the transcript with the assistant tool_calls message followed by one
 * `tool` message per result, ready to re-send to the model.
 */
export function appendToolResults(messages: ChatMessage[], assistantMessage: ChatMessage, results: ToolResultInput[]): ChatMessage[] {
  return [
    ...messages,
    assistantMessage,
    ...results.map((r): ChatMessage => ({ role: 'tool', tool_call_id: r.toolCallId, content: r.content })),
  ];
}
