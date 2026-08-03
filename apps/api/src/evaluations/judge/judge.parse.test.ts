import { parseVerdict } from './judge.parse';

describe('judge.parse', () => {
  it('parses a strict-JSON verdict and clamps score to 0-100', () => {
    expect(parseVerdict('{"score": 80, "passed": true, "reason": "third person"}'))
      .toEqual({ score: 80, passed: true, reason: 'third person' });
  });

  it('extracts JSON even with surrounding prose', () => {
    expect(parseVerdict('Sure: {"score": 40, "passed": false, "reason": "used I"} done')!.score).toBe(40);
  });

  it('returns null for non-JSON / invalid shape', () => {
    expect(parseVerdict('no json here')).toBeNull();
    expect(parseVerdict('{"score": "high"}')).toBeNull();
  });

  it('clamps out-of-range scores', () => {
    expect(parseVerdict('{"score": 250, "passed": true, "reason": "x"}')!.score).toBe(100);
  });

  it('clamps negative scores to 0', () => {
    expect(parseVerdict('{"score": -10, "passed": true, "reason": "x"}')!.score).toBe(0);
  });

  it('rounds a non-integer score rather than rejecting it', () => {
    // LLMs occasionally emit a fractional score (e.g. 85.5). It should be
    // rounded to the nearest integer, not treated as a malformed verdict.
    expect(parseVerdict('{"score": 85.5, "passed": true, "reason": "close"}')!.score).toBe(86);
    expect(parseVerdict('{"score": 42.4, "passed": false, "reason": "meh"}')!.score).toBe(42);
  });

  it('handles an unescaped closing brace inside the reason string', () => {
    expect(
      parseVerdict('{"score": 80, "passed": true, "reason": "closing brace only }"}')
    ).toEqual({ score: 80, passed: true, reason: 'closing brace only }' });
  });

  it('handles an escaped quote inside the reason string', () => {
    expect(
      parseVerdict('{"score": 60, "passed": false, "reason": "she said \\"stop\\" and left"}')
    ).toEqual({ score: 60, passed: false, reason: 'she said "stop" and left' });
  });
});
