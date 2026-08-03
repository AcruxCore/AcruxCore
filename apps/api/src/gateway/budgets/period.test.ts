import { computeResetsAt } from './period';

describe('computeResetsAt', () => {
  it("'day' → next UTC midnight", () => {
    const from = new Date('2026-07-03T14:37:00.000Z');
    expect(computeResetsAt('day', from)?.toISOString()).toBe('2026-07-04T00:00:00.000Z');
  });

  it("'day' at exactly midnight → the following midnight (strictly future)", () => {
    const from = new Date('2026-07-03T00:00:00.000Z');
    expect(computeResetsAt('day', from)?.toISOString()).toBe('2026-07-04T00:00:00.000Z');
  });

  it("'week' → next Monday 00:00 UTC (from a Friday)", () => {
    // 2026-07-03 is a Friday. Next Monday is 2026-07-06.
    const from = new Date('2026-07-03T09:00:00.000Z');
    expect(computeResetsAt('week', from)?.toISOString()).toBe('2026-07-06T00:00:00.000Z');
  });

  it("'week' from a Monday → the following Monday", () => {
    // 2026-07-06 is a Monday.
    const from = new Date('2026-07-06T12:00:00.000Z');
    expect(computeResetsAt('week', from)?.toISOString()).toBe('2026-07-13T00:00:00.000Z');
  });

  it("'month' → first of next month 00:00 UTC", () => {
    const from = new Date('2026-07-03T23:59:00.000Z');
    expect(computeResetsAt('month', from)?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it("'month' in December rolls the year over", () => {
    const from = new Date('2026-12-15T00:00:00.000Z');
    expect(computeResetsAt('month', from)?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it("'total' → null (never resets)", () => {
    expect(computeResetsAt('total', new Date())).toBeNull();
  });
});
