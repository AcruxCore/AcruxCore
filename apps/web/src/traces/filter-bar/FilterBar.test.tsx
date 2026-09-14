// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilterBar } from './FilterBar';
import type { TraceFacets } from '@/api';

/** A response object shaped exactly the way `api()` reads it — no real fetch involved. */
function fakeResponse(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Wraps the bar in the QueryClientProvider its facets query needs. The bar itself
 * renders no router-aware component — the URL state lives on the page above it. */
function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

const EMPTY_FACETS: TraceFacets = { tags: [], metadataKeys: [], models: [], errorCodes: [] };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('FilterBar', () => {
  /**
   * Regression test for the FilterBar finding in the 6c review (PR #469 review-fixes,
   * Task 6). The chip-label lookup used to ride the same `usePrompts({ search })` call as
   * the `prompt:` suggestion popover, so a committed `prompt:<id>` chip naming a prompt
   * outside whatever the (empty, unsearched) first page happened to hold fell back to a
   * short id instead of its name — a chip is not itself a search, so there was never a
   * `search` term that could have found it. Switching the label lookup to `useAllPrompts`
   * fixes this; this asserts a prompt on what used to be page 2 (rows 101-105, past the
   * 100-row page size) renders by name, not by a truncated id.
   */
  it('resolves a committed prompt chip to its name even when it is beyond the first page', async () => {
    const qc = new QueryClient();
    const targetId = '11111111-0000-0000-0000-000000000105';
    const all = Array.from({ length: 105 }, (_, i) => ({
      id: i === 104 ? targetId : `p-${i + 1}`,
      name: i === 104 ? 'prompt-105' : `prompt-${i + 1}`,
      description: null,
      createdAt: new Date().toISOString(),
    }));
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/traces/facets')) return fakeResponse(EMPTY_FACETS);
      const page = Number(new URL(url, 'http://x').searchParams.get('page') ?? '1');
      const limit = Number(new URL(url, 'http://x').searchParams.get('limit') ?? '100');
      const data = all.slice((page - 1) * limit, page * limit);
      return fakeResponse({ data, total: all.length, page, limit });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      createElement(FilterBar, {
        value: { promptId: targetId },
        onChange: vi.fn(),
        surface: 'traces',
        hideSavedViews: true,
      }),
      { wrapper: wrapper(qc) },
    );

    // `Badge` doesn't forward `data-testid`, so the chip's rendered text is the
    // reliable handle here — the fallback label (`prompt:` + a truncated id) would
    // show up as different text entirely, not as a variant of this one.
    await screen.findByText('prompt:prompt-105');
    expect(screen.queryByText(`prompt:${targetId.slice(0, 8)}`)).toBeNull();
  });
});
