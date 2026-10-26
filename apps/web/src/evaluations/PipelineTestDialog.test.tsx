// @vitest-environment jsdom
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/ui';
import { PipelineTestDialog } from './PipelineTestDialog';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Serves one committed candidate of a run graded by judge prompt version `jv-1`. */
function serve(overrides: { report?: Response; judgeVersion?: Response }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).replace(/^.*\/api\/v1/, '').split('?')[0];
      if (path === '/runs/r1/candidates/c1') {
        return json(200, { id: 'c1', promptId: 'p1', messages: [], rationale: null, label: 'candidate-B', createdAt: '', versionNumber: 7 });
      }
      if (path === '/runs/r1/report') {
        return overrides.report ?? json(200, { status: 'succeeded', judge: { model: 'gpt-4.1', promptVersionId: 'jv-1' } });
      }
      if (path === '/runs/r1') return json(200, { id: 'r1', status: 'succeeded', datasetId: 'ds-1', grid: [{ model: 'gpt-4o-mini' }] });
      if (path === '/prompts/p1') return json(200, { id: 'p1', name: 'support-agent' });
      if (path === '/prompt-versions/jv-1') {
        return overrides.judgeVersion ?? json(200, { promptId: 'jp-1', promptName: 'house-judge', versionNumber: 3, messages: [], variables: [], tools: [], model: null });
      }
      return json(404, { error: { code: 'NOT_FOUND', message: `no route ${path}` } });
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ToastProvider>
          <PipelineTestDialog open onOpenChange={() => {}} runId="r1" candidateId="c1" />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PipelineTestDialog judge', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("grades with the run's own judge prompt version", async () => {
    serve({});
    const code = await screen.findByText(/compare_local/);
    expect(code.textContent).toContain('judge("gpt-4.1", judge_prompt_id="jp-1", judge_prompt_version=3)');
    expect(screen.queryByTestId('pipeline-test-judge-warning')).toBeNull();
  });

  it('says so when the judge prompt the run graded with can no longer be read', async () => {
    serve({ judgeVersion: json(404, { error: { code: 'NOT_FOUND', message: 'Prompt version not found' } }) });
    const warning = await screen.findByTestId('pipeline-test-judge-warning');
    expect(warning.textContent).toMatch(/can no longer be read/);
    const code = await screen.findByText(/compare_local/);
    expect(code.textContent).toContain('# This run graded with a judge prompt that can no longer be read');
  });

  it("shows no code when the run's judge could not be loaded, instead of claiming it recorded none", async () => {
    serve({ report: json(500, { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } }) });
    expect(await screen.findByTestId('pipeline-test-judge-error')).toBeTruthy();
    expect(screen.queryByText(/compare_local/)).toBeNull();
    expect(screen.queryByText(/did not record its judge/)).toBeNull();
  });
});
