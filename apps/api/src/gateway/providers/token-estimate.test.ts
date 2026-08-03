import { getEncoding } from 'js-tiktoken';
import { estimateTokens } from './token-estimate';
import type { ChatMessage } from './types';

describe('estimateTokens', () => {
  it('returns a positive count for OpenAI-family text', () => {
    const n = estimateTokens('Hello, streaming world!', 'gpt-4o-mini');
    expect(n).toBeGreaterThan(0);
  });

  it('is deterministic across calls', () => {
    const a = estimateTokens('The quick brown fox jumps.', 'gpt-4o-mini');
    const b = estimateTokens('The quick brown fox jumps.', 'gpt-4o-mini');
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
  });

  it('counts messages by joining role and content', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Say hi.' },
    ];
    const n = estimateTokens(messages, 'gpt-4o-mini');
    expect(n).toBeGreaterThan(0);
  });

  it('falls back to a chars/4 heuristic for unknown non-OpenAI models', () => {
    const text = 'abcdefghij'; // 10 chars → ceil(10/4) = 3
    expect(estimateTokens(text, 'mistral-large-latest')).toBe(3);
  });

  // js-tiktoken's merge loop is quadratic in the length of a single whitespace-free piece.
  // This ran on the request path of EVERY completion (the budget pre-check), so one prompt
  // holding a long run of repeated characters blocked the event loop for seconds — 5.4s at
  // 9000 chars, 26s at 20000 — stalling every other request on the process.
  it('stays fast on a long unbroken run of characters', () => {
    // Warm the encoder first, so its one-off construction is not counted.
    estimateTokens('warm up the encoder', 'gpt-4o-mini');

    const started = Date.now();
    const n = estimateTokens('x'.repeat(50_000), 'gpt-4o-mini');
    const elapsed = Date.now() - started;

    expect(n).toBeGreaterThan(0);
    // Before the fix this input took minutes. The bound is generous so the test cannot
    // flake on a loaded machine while still failing loudly if the guard is removed.
    expect(elapsed).toBeLessThan(1000);
  });

  it('stays fast when many pieces sit just under the per-piece cap', () => {
    estimateTokens('warm up the encoder', 'gpt-4o-mini');
    // The per-piece guard alone does not bound this — 400KB of 250-char pieces measured
    // 6.8s — which is what the total-sample cap is for.
    const text = `${'x'.repeat(250)} `.repeat(1600); // ~400KB

    const started = Date.now();
    const n = estimateTokens(text, 'gpt-4o-mini');
    const elapsed = Date.now() - started;

    expect(n).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1000);
  });

  // The guards must not change the answer for text that was never slow, or every budget
  // pre-check silently drifts. These counts come from encoding the whole string at once.
  it('matches whole-string BPE counts for ordinary text', () => {
    const encoder = getEncoding('cl100k_base');
    const samples = [
      'Hi Alice, what is the weather in London?',
      'The quick brown fox jumps over the lazy dog. '.repeat(114), // ~5KB of prose
      'const x = foo.bar(baz, 42); // comment here\n'.repeat(100), // source code
      JSON.stringify({ a: 'hello world', b: [1, 2, 3], c: { d: 'nested value here' } }).repeat(50),
    ];
    for (const sample of samples) {
      expect(estimateTokens(sample, 'gpt-4o-mini')).toBe(encoder.encode(sample).length);
    }
  });

  it('never underestimates the pathological input', () => {
    const encoder = getEncoding('cl100k_base');
    // 2000 chars is short enough to encode exactly here (~280ms) for the comparison.
    const text = 'x'.repeat(2000);
    expect(estimateTokens(text, 'gpt-4o-mini')).toBeGreaterThanOrEqual(encoder.encode(text).length);
  });
});
