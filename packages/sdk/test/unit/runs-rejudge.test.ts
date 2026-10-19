import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { acruxcore } from '../../src/client';
import { acruxcoreError } from '../../src/error';

/**
 * Unit tests for `runs.rejudge` (issue #639): the request it sends and the result it
 * returns. The endpoint's behaviour is tested against a real database in
 * `apps/api/src/evaluations/runs/runs.rejudge.test.ts`.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('runs.rejudge', () => {
  let hub: acruxcore;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    hub = new acruxcore({ apiKey: 'test-key', baseUrl: 'http://localhost:3000', maxRetries: 0, retryInterval: 1 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to only_unscored and maps the response to camelCase', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json({ run_id: 'run-1', status: 'running', rejudging: 9 }, 202));

    const result = await hub.runs.rejudge('run-1');

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('http://localhost:3000/runs/run-1/rejudge');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ only_unscored: true });
    expect(result).toEqual({ runId: 'run-1', status: 'running', rejudging: 9 });
  });

  it('onlyUnscored: false re-grades every result', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json({ run_id: 'run-1', status: 'succeeded', rejudging: 0 }));

    const result = await hub.runs.rejudge('run-1', { onlyUnscored: false });

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ only_unscored: false });
    expect(result.rejudging).toBe(0);
  });

  it('throws the API error for a run still in flight', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json({ error: { code: 'RUN_IN_FLIGHT', message: 'This run is still running.' } }, 409),
    );

    const err = await hub.runs.rejudge('run-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(acruxcoreError);
    expect(err).toMatchObject({ statusCode: 409, body: { error: { code: 'RUN_IN_FLIGHT' } } });
  });
});
