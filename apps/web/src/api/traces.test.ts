import { describe, expect, it } from 'vitest';
import { traceQuery } from './traces';
import type { TraceFilters } from './types';

/**
 * Every filter the bar can hold, with a distinguishable value, so a mapping that drops
 * one is visible as a missing query param rather than as a list that quietly refuses to
 * narrow.
 */
const EVERY_FILTER: Required<Omit<TraceFilters, 'page' | 'limit'>> = {
  from: '2026-09-01',
  to: '2026-09-08',
  status: 'error',
  errorType: 'http_status',
  errorCode: 'location_not_found',
  hasWarning: true,
  model: 'gpt-4o-mini',
  sessionId: 'sess-1',
  promptVersionId: '4772e4b5-b34f-4cda-bc9e-f3df4de9426f',
  promptId: 'a290cf2f-a724-4389-8bea-da8b53229e00',
  minLatencyMs: 1200,
  minCostUsd: 0.01,
  minTokens: 500,
  minScore: 80,
  maxScore: 95,
  q: 'visit london',
  qIn: 'input',
  tags: ['prod'],
  metadata: { env: 'prod' },
};

describe('traceQuery', () => {
  /**
   * The regression this file exists for. `error_type` and `has_warning` reached the URL
   * and rendered as chips while this mapper still dropped them, so the page showed a
   * filter that did nothing — the most confusing failure a filter can have, because
   * every visible sign says it worked.
   */
  it('sends a query param for every filter it is given', () => {
    const query = traceQuery(EVERY_FILTER);
    const missing = Object.keys(EVERY_FILTER).filter((key) => {
      const values = Object.values(query).filter((v) => v !== undefined);
      const expected = EVERY_FILTER[key as keyof typeof EVERY_FILTER];
      return !values.some((v) => JSON.stringify(v) === JSON.stringify(expected) || String(v) === String(expected));
    });
    expect(missing).toEqual([]);
  });

  it('maps the failure-kind filters to the names the API reads', () => {
    const query = traceQuery({ errorType: 'tool_declared', hasWarning: false });
    expect(query['error_type']).toBe('tool_declared');
    expect(query['has_warning']).toBe('false');
  });

  it('sends the tool owner\'s own slug as error_code, not as free text', () => {
    // Issue #460. Folding it into `q` would be a substring match over the whole
    // attributes JSON, which counts runs that only mention the slug.
    const query = traceQuery({ errorCode: 'location_not_found' });
    expect(query['error_code']).toBe('location_not_found');
    expect(query['q']).toBeUndefined();
  });

  it('omits has_warning entirely when it is unset', () => {
    // Absent means "either". Sending `has_warning=false` instead would hide every
    // warned trace from an unfiltered list.
    expect(traceQuery({ status: 'error' })['has_warning']).toBeUndefined();
  });
});
