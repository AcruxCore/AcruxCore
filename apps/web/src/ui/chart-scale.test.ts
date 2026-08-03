import { describe, expect, it } from 'vitest';
import { linePath, niceCeil, scaleY, xCoord } from './chart-scale';

describe('chart-scale', () => {
  it('niceCeil rounds up to a clean bound', () => {
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(7)).toBe(10);
    expect(niceCeil(42)).toBe(50);
    expect(niceCeil(180)).toBe(200);
  });

  it('niceCeil handles negative and already-nice values', () => {
    expect(niceCeil(-5)).toBe(1);
    expect(niceCeil(10)).toBe(10);
    expect(niceCeil(100)).toBe(100);
    expect(niceCeil(2)).toBe(2);
  });

  it('scaleY inverts value→y (0 at bottom, max at top)', () => {
    expect(scaleY(0, 100, 200)).toBe(200);
    expect(scaleY(100, 100, 200)).toBe(0);
    expect(scaleY(50, 100, 200)).toBe(100);
  });

  it('scaleY treats a non-positive max as a flat baseline (no divide-by-zero)', () => {
    expect(scaleY(0, 0, 200)).toBe(200);
    expect(scaleY(5, 0, 200)).toBe(200);
  });

  it('xCoord spreads points evenly across the width', () => {
    expect(xCoord(0, 3, 300)).toBe(0);
    expect(xCoord(2, 3, 300)).toBe(300);
    expect(xCoord(1, 3, 300)).toBe(150);
  });

  it('xCoord returns 0 for a single point or empty series (no divide-by-zero)', () => {
    expect(xCoord(0, 1, 300)).toBe(0);
    expect(xCoord(0, 0, 300)).toBe(0);
  });

  it('linePath builds an SVG polyline path from values', () => {
    expect(linePath([0, 100], 100, 100, 100)).toBe('M0,100 L100,0');
  });

  it('linePath returns an empty string for an empty series (no NaN)', () => {
    expect(linePath([], 100, 100, 100)).toBe('');
  });

  it('linePath handles a single point (moveto only, x=0)', () => {
    expect(linePath([50], 100, 100, 100)).toBe('M0,50');
  });

  it('linePath skips null values as gaps instead of plotting NaN', () => {
    // A null in the middle breaks the path into two segments (M...L... M...).
    expect(linePath([0, null, 100], 100, 200, 100)).toBe('M0,100 M200,0');
  });
});
