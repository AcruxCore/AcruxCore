import { describe, it, expect, vi, afterEach } from 'vitest';
import { acruxcore } from '../../src/client';

/** `traces.listFeedback` narrows the feed with the filters `GET /traces/feedback` takes. */
describe('traces.listFeedback filters', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends rating and promptId, and nothing when none is given', async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ data: [], total: 0, page: 1, limit: 20 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const hub = new acruxcore({ apiKey: 'k', baseUrl: 'http://localhost:3000/api/v1', maxRetries: 0 });

    await hub.traces.listFeedback({ page: 2, limit: 100, rating: 'down', promptId: 'p-1' });
    await hub.traces.listFeedback();

    expect(new URL(urls[0]).searchParams.toString()).toBe('page=2&limit=100&rating=down&prompt_id=p-1');
    expect(new URL(urls[1]).search).toBe('');
  });
});
