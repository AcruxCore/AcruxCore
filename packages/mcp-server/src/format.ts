import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AcruxCoreApiError } from './errors';

/**
 * What a tool handler returns.
 *
 * Aliased to the SDK's own `CallToolResult` rather than redeclared, so a protocol
 * revision that adds a field to a tool result cannot silently drift from what we emit.
 */
export type ToolResult = CallToolResult;

/** Appended by {@link truncateText} to a result it had to cut. */
const TRUNCATION_MARKER =
  '\n\n[truncated: response exceeded the size limit — narrow the query, ' +
  'use a smaller `limit`, or fetch one item at a time]';

/**
 * Tells whether {@link okResult} had to cut a result to fit its byte budget.
 *
 * Lets a tool retry with a smaller payload instead of returning JSON cut mid-value.
 *
 * @param result - A result built by {@link okResult}.
 * @returns True when its text ends in the truncation marker.
 */
export function isTruncated(result: ToolResult): boolean {
  const first = result.content[0];
  return first?.type === 'text' && first.text.endsWith(TRUNCATION_MARKER);
}

/**
 * Truncates text to a byte budget, appending a marker that says so.
 *
 * Byte-based rather than character-based because the budget exists to protect a context
 * window, and a UTF-8 multibyte character costs more than one. The cut is made on a
 * character boundary by shrinking from the end, so the result is never invalid UTF-8.
 *
 * @param text - Text to cap.
 * @param maxBytes - Maximum bytes of UTF-8 to keep.
 * @returns The text unchanged, or a truncated copy ending in a `[truncated …]` marker.
 */
export function truncateText(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;

  const marker = TRUNCATION_MARKER;
  const budget = Math.max(0, maxBytes - encoder.encode(marker).length);

  let end = Math.min(text.length, budget);
  while (end > 0 && encoder.encode(text.slice(0, end)).length > budget) {
    // Shrink by a quarter of the overshoot: a UTF-8 character is at most 4 bytes, so
    // this always removes at least one character and converges in a few passes.
    end -= Math.ceil((encoder.encode(text.slice(0, end)).length - budget) / 4);
  }
  return text.slice(0, Math.max(0, end)) + marker;
}

/**
 * Builds a successful tool result: a one-line human summary, then the JSON payload.
 *
 * Both halves earn their place. The summary is what a model reads when it only needs to
 * know the call worked ("Promoted alias production to version 3"); the JSON is what it
 * reads when it needs a field. Returning only JSON makes every result a parsing job;
 * returning only prose throws away the ids the next call needs.
 *
 * @param summary - One line describing what happened.
 * @param payload - Structured data to include, or `undefined` for summary-only.
 * @param maxBytes - Byte budget for the whole result.
 * @returns An MCP `CallToolResult`-shaped object.
 */
export function okResult(summary: string, payload: unknown, maxBytes: number): ToolResult {
  const text =
    payload === undefined
      ? summary
      : `${summary}\n\n${JSON.stringify(payload, null, 2)}`;
  return { content: [{ type: 'text', text: truncateText(text, maxBytes) }] };
}

/**
 * Builds a failed tool result.
 *
 * MCP reports tool failures in-band (`isError: true`) rather than as a JSON-RPC error,
 * precisely so the model sees them and can retry differently. An `AcruxCoreApiError`
 * renders with its code and details intact; anything else renders its message.
 *
 * @param error - The thrown value.
 * @param maxBytes - Byte budget for the message.
 * @returns An MCP `CallToolResult` with `isError` set.
 */
export function errorResult(error: unknown, maxBytes: number): ToolResult {
  const text =
    error instanceof AcruxCoreApiError
      ? error.toToolText()
      : error instanceof Error
        ? `${error.name}: ${error.message}`
        : `Unexpected error: ${String(error)}`;
  return { content: [{ type: 'text', text: truncateText(text, maxBytes) }], isError: true };
}

/**
 * Formats the `{ data, total, page, limit }` envelope the list endpoints return.
 *
 * @param noun - Plural noun for the summary line, e.g. `prompts`.
 * @param page - The list response.
 * @returns A summary line naming how many of how many are shown.
 */
export function listSummary(
  noun: string,
  page: { data?: unknown[]; total?: number; page?: number; limit?: number },
): string {
  const shown = page.data?.length ?? 0;
  const total = page.total ?? shown;
  const pageNo = page.page ?? 1;
  if (total === 0) return `No ${noun} found.`;
  return `Showing ${shown} of ${total} ${noun} (page ${pageNo}).`;
}
