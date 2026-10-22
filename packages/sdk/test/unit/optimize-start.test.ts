import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { acruxcore } from '../../src/client';

/**
 * Unit tests for `optimize.start`: the request body it sends. The endpoint's
 * behaviour is tested against a real database in
 * `apps/api/src/evaluations/optimize/optimize.test.ts`.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('optimize.start', () => {
  let hub: acruxcore;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    hub = new acruxcore({ apiKey: 'test-key', baseUrl: 'http://localhost:3000', maxRetries: 0, retryInterval: 1 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends judgePromptId as judge_prompt_id', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json({ run_id: 'run-1', status: 'queued' }, 202));

    await hub.optimize.start('prompt-1', {
      datasetId: 'ds-1',
      models: ['gpt-4o-mini'],
      judgeModel: 'gpt-4o-mini',
      judgePromptId: 'judge-1',
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('http://localhost:3000/prompts/prompt-1/optimize');
    expect(JSON.parse(init.body as string)).toEqual({
      dataset_id: 'ds-1',
      models: ['gpt-4o-mini'],
      judge_model: 'gpt-4o-mini',
      judge_prompt_id: 'judge-1',
    });
  });

  it('leaves judge_prompt_id out when no judge prompt is given', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json({ run_id: 'run-1', status: 'queued' }, 202));

    await hub.optimize.start('prompt-1', { datasetId: 'ds-1', models: ['gpt-4o-mini'], judgeModel: 'gpt-4o-mini' });

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).not.toHaveProperty('judge_prompt_id');
  });
});
