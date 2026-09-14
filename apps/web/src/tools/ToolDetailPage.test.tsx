// @vitest-environment jsdom
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/ui';
import { AuthProvider } from '@/auth/AuthContext';
import type { Me, ToolDetail, ToolVersionListItem } from '@/api';
import { ToolDetailPage } from './ToolDetailPage';

/** A response object shaped exactly the way `api()` reads it — no real fetch involved. */
function fakeResponse(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const ME: Me = {
  user: { id: 'u-1', email: 'owner@example.com', displayName: 'Owner' },
  team: { id: 'team-1', name: 'Team' },
  role: 'owner',
};

/** production → v2 (code-authored), staging → v1 — the readiness DTO's own `aliases`. */
const TOOL: ToolDetail = {
  id: 'tool-1',
  name: 'get_weather',
  description: 'Get the weather.',
  teamId: 'team-1',
  createdBy: 'u-1',
  createdAt: '2026-09-01T00:00:00.000Z',
  callable: true,
  versionCount: 2,
  latestVersionNumber: 2,
  executorType: 'http',
  aliases: [
    { alias: 'production', versionNumber: 2 },
    { alias: 'staging', versionNumber: 1 },
  ],
};

const VERSIONS: ToolVersionListItem[] = [
  {
    id: 'v-2',
    toolId: 'tool-1',
    versionNumber: 2,
    description: 'v2',
    changelog: null,
    source: 'code',
    createdBy: 'u-1',
    createdAt: '2026-09-02T00:00:00.000Z',
  },
  {
    id: 'v-1',
    toolId: 'tool-1',
    versionNumber: 1,
    description: 'v1',
    changelog: null,
    source: 'dashboard',
    createdBy: 'u-1',
    createdAt: '2026-09-01T00:00:00.000Z',
  },
];

function renderPage() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/tools/tool-1']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ToastProvider>
          <AuthProvider>
            <Routes>
              <Route path="/tools/:id" element={<ToolDetailPage />} />
            </Routes>
          </AuthProvider>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ToolDetailPage', () => {
  /**
   * Regression test for finding 4a. The page used to hold two independent alias reads:
   * the readiness DTO's own `aliases` (used nowhere) and a second `GET
   * /tools/:id/aliases` whose `isLoading`/`isError` were never rendered after Versions and
   * Aliases merged into one tab. A failed (or in this test, simply un-mocked) second
   * request used to leave `aliasList` at `[]` silently — no production/staging badges, no
   * "Defined in code" badge, no promote control, and no error on screen. This asserts the
   * whole page renders correctly off `GET /tools/:id` alone, and fails loudly (via the
   * fetch mock's `throw`) if any code path still requests `/aliases` a second time.
   */
  it('reads every alias off the tool resource, with no second aliases request', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/v1/auth/me') return fakeResponse(ME);
      if (url === '/api/v1/tools/tool-1') return fakeResponse(TOOL);
      if (url.startsWith('/api/v1/tools/tool-1/versions')) {
        return fakeResponse({ data: VERSIONS, total: 2, page: 1, limit: 100 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    // "Defined in code" only renders once `production`'s version (v2, source `code`) is
    // known — reachable solely through `tool.data.aliases` + `versions.data`.
    await waitFor(() => expect(screen.getByTestId('defined-in-code')).toBeTruthy());
    expect(screen.getAllByText('production').length).toBeGreaterThan(0);
    expect(screen.getAllByText('staging').length).toBeGreaterThan(0);
    // v1 (staging) has an alias pointing elsewhere (production) it can be promoted to.
    expect(screen.getAllByText('Point here…').length).toBeGreaterThan(0);

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/aliases'))).toBe(false);
  });
});
