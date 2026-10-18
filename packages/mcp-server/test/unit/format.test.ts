import { describe, expect, it } from 'vitest';
import { AcruxCoreApiError } from '../../src/errors';
import { errorResult, listSummary, okResult, truncateText } from '../../src/format';

/** Byte length of a string as UTF-8, which is what the cap is measured in. */
function bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

describe('truncateText', () => {
  it('leaves text that fits alone', () => {
    expect(truncateText('short', 100)).toBe('short');
  });

  it('stays within the byte budget once truncated', () => {
    const long = 'x'.repeat(5000);
    const result = truncateText(long, 500);

    expect(bytes(result)).toBeLessThanOrEqual(500);
    expect(result).toContain('[truncated');
  });

  it('measures bytes rather than characters, so multibyte text is capped correctly', () => {
    // Each emoji is 4 bytes of UTF-8: 200 of them is 800 bytes but only 400 JS chars,
    // so a character-based cap would let this through a 500-byte budget.
    const emoji = '🙂'.repeat(200);
    const result = truncateText(emoji, 500);

    expect(bytes(emoji)).toBeGreaterThan(500);
    expect(bytes(result)).toBeLessThanOrEqual(500);
  });

  it('never emits a broken surrogate pair at the cut', () => {
    const result = truncateText('🙂'.repeat(200), 500);
    // A lone surrogate survives a round trip through the encoder as U+FFFD.
    expect(new TextDecoder().decode(new TextEncoder().encode(result))).toBe(result);
  });
});

describe('okResult', () => {
  it('puts the summary first and the JSON after it', () => {
    const result = okResult('Created prompt "greeting".', { id: 'abc' }, 10_000);
    const text = result.content[0] as { text: string };

    expect(text.text.startsWith('Created prompt "greeting".')).toBe(true);
    expect(text.text).toContain('"id": "abc"');
    expect(result.isError).toBeUndefined();
  });

  it('emits summary only when there is no payload', () => {
    const result = okResult('Done.', undefined, 10_000);
    expect((result.content[0] as { text: string }).text).toBe('Done.');
  });
});

describe('errorResult', () => {
  it('keeps the API error code and its details, because the model acts on them', () => {
    const error = new AcruxCoreApiError(
      'POST /prompts/greeting/production/render',
      400,
      'MISSING_VARIABLES',
      'Required variables are missing: company, name',
      { missing: ['company', 'name'] },
    );

    const result = errorResult(error, 10_000);
    const text = (result.content[0] as { text: string }).text;

    expect(result.isError).toBe(true);
    expect(text).toContain('MISSING_VARIABLES');
    expect(text).toContain('company');
    expect(text).toContain('POST /prompts/greeting/production/render');
  });

  it('handles a plain Error and a non-Error throw', () => {
    expect((errorResult(new TypeError('bad'), 500).content[0] as { text: string }).text).toContain(
      'TypeError: bad',
    );
    expect((errorResult('nope', 500).content[0] as { text: string }).text).toContain('nope');
  });
});

describe('listSummary', () => {
  it('reports how many of how many are shown', () => {
    expect(listSummary('prompts', { data: [1, 2], total: 7, page: 1 })).toBe(
      'Showing 2 of 7 prompts (page 1).',
    );
  });

  it('says nothing was found rather than "showing 0 of 0"', () => {
    expect(listSummary('traces', { data: [], total: 0 })).toBe('No traces found.');
  });
});
