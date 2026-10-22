import { describe, expect, it } from 'vitest';
import type { McpServerConfig } from '../../src/config';
import { ALL_TOOLSETS } from '../../src/config';
import { ALL_TOOLS } from '../../src/toolsets';
import type { ToolContext } from '../../src/toolsets/types';

const config: McpServerConfig = {
  baseUrl: 'http://localhost:3000/api/v1',
  apiKey: 'acx_sk_test',
  toolsets: [...ALL_TOOLSETS],
  readOnly: false,
  promptAlias: 'production',
  maxTextBytes: 40_000,
  timeoutMs: 60_000,
};

/** A client that answers `GET /runs/:id` with one fixed run and fails on anything else. */
function clientReturning(run: Record<string, unknown>): ToolContext['client'] {
  return {
    get: async (path: string) => {
      if (/^\/runs\/[^/]+$/.test(path)) return run;
      throw new Error(`unexpected GET ${path}`);
    },
  } as unknown as ToolContext['client'];
}

const report = ALL_TOOLS.find((tool) => tool.name === 'get_optimize_report')!;
const runId = '11111111-1111-4111-8111-111111111111';

describe('get_optimize_report on a run that has not drafted yet', () => {
  it('reads a queued run from a server that does not store the run kind yet', async () => {
    // A server older than issue #684 derives `kind` from the grid, and an optimize
    // run's grid is empty until it drafts, so a queued optimize run arrives as
    // "evaluation". An evaluation run freezes its grid when it starts, so an empty
    // grid can only be an undrafted optimize run.
    const client = clientReturning({ id: runId, kind: 'evaluation', status: 'queued', error: null, grid: [] });

    const result = await report.handler({ run_id: runId }, { client, config });

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain('is queued');
  });

  it('still refuses an evaluation run that has a grid', async () => {
    const client = clientReturning({
      id: runId,
      kind: 'evaluation',
      status: 'succeeded',
      error: null,
      grid: [{ cellKey: 'c1', variantKind: 'version', variantLabel: 'v1', model: 'gpt-4o-mini' }],
    });

    await expect(report.handler({ run_id: runId }, { client, config })).rejects.toThrow('is an evaluation run');
  });
});
