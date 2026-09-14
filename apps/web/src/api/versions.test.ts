// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVersions } from './versions';
import type { VersionListItem } from './types';

/** A response object shaped exactly the way `api()` reads it — no real fetch involved. */
function fakeResponse(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Wraps a hook in the QueryClientProvider `useVersions` needs. */
function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

/** A version row, cheap to generate in bulk. */
function version(n: number): VersionListItem {
  return {
    id: `v${n}`,
    versionNumber: n,
    variables: [],
    createdBy: 'user-1',
    createdAt: new Date().toISOString(),
    model: null,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useVersions', () => {
  /**
   * Regression test for 6b: `useVersions` hardcoded `limit: 100` against a server that
   * caps `limit` at 100, so a prompt with more than 100 committed versions silently lost
   * its oldest ones from the promote/rollback control. This asserts a second page is
   * actually requested and its rows make it into the result.
   */
  it('follows pages past the server-enforced 100-row limit', async () => {
    const qc = new QueryClient();
    const all = Array.from({ length: 120 }, (_, i) => version(i + 1));
    const fetchMock = vi.fn(async (url: string) => {
      const page = Number(new URL(url, 'http://x').searchParams.get('page') ?? '1');
      const limit = Number(new URL(url, 'http://x').searchParams.get('limit') ?? '100');
      const data = all.slice((page - 1) * limit, page * limit);
      return fakeResponse({ data, total: all.length, page, limit });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useVersions('prompt-1'), { wrapper: wrapper(qc) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(120);
    expect(result.current.data?.[0].versionNumber).toBe(1);
    expect(result.current.data?.[119].versionNumber).toBe(120);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
