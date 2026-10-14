// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/ui';
import { JudgeModelField } from './JudgeModelField';
import { JudgePromptField } from './JudgePromptField';

/** A response object shaped exactly the way `api()` reads it — no real fetch involved. */
function fakeResponse(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, createElement(ToastProvider, null, children));
  };
}

/** No retries, so a failed request settles as an error at once. */
function quietClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('JudgeModelField', () => {
  it('does not claim the team has no models when the models request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ error: 'boom' }, 500)));

    render(createElement(JudgeModelField, { id: 'judge', value: '', onChange: vi.fn(), grades: 'every result' }), {
      wrapper: wrapper(quietClient()),
    });

    await screen.findByTestId('judge-load-error');
    expect(screen.queryByText('No models registered yet.')).toBeNull();
    expect(screen.queryByTestId('judge-create-model')).toBeNull();
  });

  it('offers to create a model when the team really has none', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse([])));

    render(createElement(JudgeModelField, { id: 'judge', value: '', onChange: vi.fn(), grades: 'every result' }), {
      wrapper: wrapper(quietClient()),
    });

    await screen.findByTestId('judge-create-model');
  });
});

describe('JudgePromptField', () => {
  it('still selects the new prompt when committing the starter template fails', async () => {
    // Without this, the prompt is left behind unselected and each retry
    // creates "Receipts judge 2", "3", and so on.
    const created = { id: 'p-1', name: 'Receipts judge', description: null, createdAt: new Date().toISOString() };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST' && url.endsWith('/prompts')) return fakeResponse(created, 201);
        if (init?.method === 'POST' && url.includes('/versions')) return fakeResponse({ error: { message: 'nope' } }, 500);
        return fakeResponse({ data: [], total: 0, page: 1, limit: 100 });
      }),
    );
    const onChange = vi.fn();

    render(
      createElement(JudgePromptField, {
        id: 'jp',
        value: null,
        onChange,
        newPromptName: 'Receipts judge',
        grades: 'every result',
      }),
      { wrapper: wrapper(quietClient()) },
    );

    fireEvent.click(screen.getByTestId('jp-create'));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ id: 'p-1', name: 'Receipts judge' }));
  });
});
