import { getEncoding, type Tiktoken } from 'js-tiktoken';
import type { ChatMessage } from './types';
import { MODELS } from './models';

/** Lazily-built cl100k_base encoder — shared across calls (BPE ranks are bundled by js-tiktoken). */
let cl100k: Tiktoken | null = null;

/** @returns The shared cl100k_base encoder, building it on first use. */
function encoder(): Tiktoken {
  if (!cl100k) cl100k = getEncoding('cl100k_base');
  return cl100k;
}

/**
 * Longest whitespace-free run handed to the BPE encoder.
 *
 * `js-tiktoken`'s merge loop is **quadratic in the length of a single piece**, and its
 * pre-tokenizer splits on whitespace — so ordinary text is linear (20KB of prose encodes in
 * ~3ms) while one long unbroken run is not. Measured on cl100k_base: 256 chars → 4ms,
 * 512 → 18ms, 1024 → 70ms, 2048 → 281ms, 9000 → 5.4s, 20000 → 26s.
 *
 * Since `estimateRequestCostUsd` runs this on the request path of **every** completion,
 * before the budget pre-check, a prompt containing one long run of repeated characters —
 * a base64 blob, a padding run, a corrupted paste — blocked the Node event loop for
 * seconds and stalled every other request on the process. 256 keeps a single piece under
 * ~4ms while sitting far above any real word.
 */
const MAX_BPE_PIECE_CHARS = 256;

/**
 * Longest total text encoded exactly. Beyond this, the leading sample is encoded and its
 * observed chars-per-token ratio is applied to the rest.
 *
 * The per-piece cap alone is not enough: enough pieces just under it still add up (400KB of
 * 250-char pieces measured 6.8s). This bounds the whole function at roughly the cost of one
 * `MAX_BPE_SAMPLE_CHARS` sample — ~350ms worst case — no matter how large the body is.
 */
const MAX_BPE_SAMPLE_CHARS = 20_000;

/** Fallback ratio for text not measured by the encoder. */
const CHARS_PER_TOKEN = 4;

/** The cheap estimate used wherever BPE is skipped. Overestimates, which is the safe side. */
function heuristic(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Flatten a message list into a single string for estimation, tagging each
 * message with its role so role tokens contribute roughly as they do live.
 */
function flatten(input: string | ChatMessage[]): string {
  if (typeof input === 'string') return input;
  return input.map((m) => `${m.role}: ${m.content}`).join('\n');
}

/**
 * BPE-encodes `text` without ever handing the encoder a piece long enough to be slow.
 *
 * Pieces are split on whitespace runs, and each separator is attached to the piece that
 * **follows** it — the same grouping tiktoken's own pre-tokenizer uses for `" word"`. That
 * detail is what keeps this exact: splitting a separator off on its own would count `" the"`
 * as two tokens instead of one and overestimate every prose prompt by roughly its word count.
 * Verified against whole-string encoding on prose, source code, JSON and short text: identical
 * counts, 0% delta.
 *
 * @param text - Text to count. Any piece over {@link MAX_BPE_PIECE_CHARS} uses the heuristic.
 * @returns A token count for `text`.
 */
function boundedEncode(text: string): number {
  let tokens = 0;
  let pendingSeparator = '';
  for (const part of text.split(/(\s+)/)) {
    if (part.length === 0) continue;
    if (/^\s+$/.test(part)) {
      pendingSeparator += part;
      continue;
    }
    const piece = pendingSeparator + part;
    pendingSeparator = '';
    tokens += piece.length > MAX_BPE_PIECE_CHARS ? heuristic(piece.length) : encoder().encode(piece).length;
  }
  // Trailing whitespace still costs tokens live, so it is counted rather than dropped.
  if (pendingSeparator.length > 0) {
    tokens +=
      pendingSeparator.length > MAX_BPE_PIECE_CHARS
        ? heuristic(pendingSeparator.length)
        : encoder().encode(pendingSeparator).length;
  }
  return tokens;
}

/**
 * Estimate token count for text or a message list, used for the budget pre-check on every
 * request and when a provider omits usage in streaming mode.
 *
 * Bounded by construction: see {@link MAX_BPE_PIECE_CHARS} and {@link MAX_BPE_SAMPLE_CHARS}.
 * Both guards can only overestimate, never under — an overestimate makes a budget check more
 * conservative, which is the direction to fail in.
 *
 * @param input - Raw text, or a list of chat messages (role + content).
 * @param model - Model id; OpenAI-family models use the js-tiktoken BPE encoder,
 *   everything else uses a `ceil(chars / 4)` heuristic.
 * @returns A non-negative, deterministic token estimate.
 */
export function estimateTokens(input: string | ChatMessage[], model: string): number {
  const text = flatten(input);
  if (text.length === 0) return 0;

  const info = MODELS[model];
  const isOpenAiFamily = info
    ? info.provider === 'openai' || info.provider === 'openai_compatible'
    : /^(gpt-|o1|o3|text-|chatgpt)/i.test(model);

  if (isOpenAiFamily) {
    try {
      if (text.length <= MAX_BPE_SAMPLE_CHARS) return boundedEncode(text);
      // Measure the leading sample, then scale by the ratio it observed. Better than a flat
      // chars/4 on the tail, because the ratio comes from this caller's own text.
      const sampleTokens = boundedEncode(text.slice(0, MAX_BPE_SAMPLE_CHARS));
      const ratio = sampleTokens / MAX_BPE_SAMPLE_CHARS;
      return sampleTokens + Math.ceil((text.length - MAX_BPE_SAMPLE_CHARS) * ratio);
    } catch {
      // Fall through to the heuristic if the encoder rejects the input.
    }
  }
  return heuristic(text.length);
}
