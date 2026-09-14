// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromptPicker } from './PromptPicker';

/** A response object shaped exactly the way `api()` reads it — no real fetch involved. */
function fakeResponse(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Wraps a hook/component in the QueryClientProvider `useAllPrompts` needs. */
function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PromptPicker', () => {
  /**
   * Regression test for 6c: `usePrompts({ search })` only ever searched the server's
   * first 20-row page, so a team with more prompts than that had no way to reach one
   * past it from this picker unless its name happened to match nothing better-ranked.
   * Backing the picker with `useAllPrompts` (which pages past the server's page-size cap)
   * makes a prompt on what used to be page 2 (rows 101-105, past the 100-row page size)
   * selectable by typing its name.
   */
  it('finds and selects a prompt beyond the first page', async () => {
    const qc = new QueryClient();
    const all = Array.from({ length: 105 }, (_, i) => ({
      id: `p-${i + 1}`,
      name: `prompt-${i + 1}`,
      description: null,
      createdAt: new Date().toISOString(),
    }));
    const fetchMock = vi.fn(async (url: string) => {
      const page = Number(new URL(url, 'http://x').searchParams.get('page') ?? '1');
      const limit = Number(new URL(url, 'http://x').searchParams.get('limit') ?? '100');
      const data = all.slice((page - 1) * limit, page * limit);
      return fakeResponse({ data, total: all.length, page, limit });
    });
    vi.stubGlobal('fetch', fetchMock);

    const onChange = vi.fn();
    render(
      createElement(PromptPicker, { value: null, onChange }),
      { wrapper: wrapper(qc) },
    );

    // The 105th prompt sits on the (unrequested-by-name) second page — proves the
    // picker actually paged past the first 100 rather than truncating there.
    fireEvent.focus(screen.getByPlaceholderText('Search prompts…'));
    fireEvent.change(screen.getByPlaceholderText('Search prompts…'), { target: { value: 'prompt-105' } });

    const option = await screen.findByRole('button', { name: 'prompt-105' });
    fireEvent.click(option);

    expect(onChange).toHaveBeenCalledWith({ id: 'p-105', name: 'prompt-105' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
