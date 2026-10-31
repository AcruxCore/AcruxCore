import { describe, it, expect, vi, afterEach } from 'vitest';
import { acruxcore } from '../../src/client';

/**
 * `traces.list` sends the failure, tag and metadata filters `GET /traces` takes. Before
 * issue #464 none of them existed on `ListTracesOptions`, so a script could not pull the
 * runs the dashboard filters by.
 */
describe('traces.list filters', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends errorType, errorCode, hasWarning, tags and metadata', async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ data: [], total: 0, page: 1, limit: 20 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const hub = new acruxcore({ apiKey: 'k', baseUrl: 'http://localhost:3000/api/v1', maxRetries: 0 });

    await hub.traces.list({
      errorType: 'tool_declared',
      errorCode: 'location_not_found',
      hasWarning: false,
      tags: ['prod', 'nl'],
      metadata: { region: 'eu', tier: 'pro' },
    });

    const params = new URL(urls[0]).searchParams;
    expect(params.get('error_type')).toBe('tool_declared');
    expect(params.get('error_code')).toBe('location_not_found');
    // `false` is a real filter (runs with no warning), so it must be sent, not dropped.
    expect(params.get('has_warning')).toBe('false');
    expect(params.getAll('tags')).toEqual(['prod', 'nl']);
    expect(params.get('metadata[region]')).toBe('eu');
    expect(params.get('metadata[tier]')).toBe('pro');
  });
});
