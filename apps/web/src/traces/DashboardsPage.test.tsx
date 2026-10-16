// @vitest-environment jsdom
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/ui';
import type { TraceAnalytics, TraceScores } from '@/api/types';
import { DashboardsPage } from './DashboardsPage';

/** A response object shaped exactly the way `api()` reads it — no real fetch involved. */
function fakeResponse(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const TOTALS = {
  requests: 3,
  errorRate: 0,
  promptTokens: 30,
  completionTokens: 6,
  totalTokens: 36,
  costUsd: 0.013,
  latencyMs: { p50: 100, p95: 100, p99: 100 },
};

/** An analytics body from an API that predates `costPerTrace` (deploy skew). */
const ANALYTICS_WITHOUT_COST_PER_TRACE = {
  from: '2026-10-01',
  to: '2026-10-16',
  groupBy: 'day',
  totals: TOTALS,
  buckets: [{ key: '2026-10-10', ...TOTALS }],
} as Omit<TraceAnalytics, 'costPerTrace'>;

const SCORES: TraceScores = {
  from: '2026-10-01',
  to: '2026-10-16',
  feedback: { up: 2, down: 1 },
  rules: [],
  days: [{ day: '2026-10-10', up: 2, down: 1, passed: 0, failed: 0 }],
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/observability']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ToastProvider>
          <DashboardsPage />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DashboardsPage (review of PR #609)', () => {
  it('still renders the totals when the API sends no costPerTrace', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('/api/v1/traces/analytics/scores')) return fakeResponse(SCORES);
        if (url.startsWith('/api/v1/traces/analytics')) return fakeResponse(ANALYTICS_WITHOUT_COST_PER_TRACE);
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    renderPage();

    await waitFor(() => expect(screen.getByTestId('analytics-totals')).toBeTruthy());
    expect(screen.getByText('Requests')).toBeTruthy();
    expect(screen.getByText('Cost / trace p50')).toBeTruthy();
  });

  it('says so when quality scores fail to load, instead of hiding the panel', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('/api/v1/traces/analytics/scores')) {
          return fakeResponse({ error: { code: 'INTERNAL', message: 'boom' } }, 500);
        }
        if (url.startsWith('/api/v1/traces/analytics')) {
          return fakeResponse({ ...ANALYTICS_WITHOUT_COST_PER_TRACE, costPerTrace: { p50: 0.002, p99: 0.01 } });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    renderPage();

    await waitFor(() => expect(screen.getByTestId('quality-panel')).toBeTruthy());
    expect(screen.getByText('Couldn’t load quality scores')).toBeTruthy();
  });
});
