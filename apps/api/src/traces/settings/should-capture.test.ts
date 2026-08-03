import { shouldCapture } from './should-capture';

describe('shouldCapture', () => {
  it('returns the team default when no per-request override is given', () => {
    expect(shouldCapture(false)).toBe(false);
    expect(shouldCapture(true)).toBe(true);
    expect(shouldCapture(false, undefined)).toBe(false);
    expect(shouldCapture(true, undefined)).toBe(true);
  });

  it('per-request override wins over the team default (both directions)', () => {
    expect(shouldCapture(false, true)).toBe(true); // force on while team default off
    expect(shouldCapture(true, false)).toBe(false); // force off while team default on
  });
});
