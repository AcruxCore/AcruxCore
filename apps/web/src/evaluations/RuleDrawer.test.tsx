// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/ui';
import type { EvalRule } from '@/api/types';
import { RuleDrawer } from './RuleDrawer';

vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ canManageTeam: true, canWrite: true }) }));

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

const DELETED_JUDGE = '0f05c80d-05ad-46e3-a702-627e1120eabc';
const DELETED_FILTER = '13b19dd4-9791-4373-a6da-1d55a739bb2c';

const RULE: EvalRule = {
  id: 'rule-1',
  name: 'tone',
  criteria: 'polite',
  judgeModel: 'gpt-4o-mini',
  judgePromptId: DELETED_JUDGE,
  sampleRate: 0.1,
  dailyLimit: null,
  alertBelow: null,
  enabled: true,
  filter: { promptId: DELETED_FILTER },
} as unknown as EvalRule;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Issue #581: a soft-deleted judge prompt 404s, so the drawer showed "Built-in judge" and
// a Save that touched nothing else sent `judgePromptId: null`, switching how the rule grades.
describe('RuleDrawer with a prompt that has since been deleted', () => {
  it('keeps the deleted judge and filter prompts when the rule is saved unchanged', async () => {
    const patches: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          patches.push(JSON.parse(String(init.body)));
          return fakeResponse(RULE);
        }
        if (url.includes(`/prompts/${DELETED_JUDGE}`) || url.includes(`/prompts/${DELETED_FILTER}`)) {
          return fakeResponse({ error: { code: 'NOT_FOUND', message: 'Prompt not found' } }, 404);
        }
        return fakeResponse([]);
      }),
    );

    render(createElement(RuleDrawer, { open: true, onOpenChange: vi.fn(), rule: RULE }), {
      wrapper: wrapper(new QueryClient({ defaultOptions: { queries: { retry: false } } })),
    });

    await waitFor(() => expect(screen.getAllByText(/Deleted prompt/).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({ judgePromptId: DELETED_JUDGE, filter: { promptId: DELETED_FILTER } });
  });

  // A lookup that fails for another reason is not a deleted prompt, and its arrival must
  // not reset what the user already typed.
  it('does not call a prompt deleted on a 500, and keeps edits made while the lookup ran', async () => {
    let failLookup: () => void = () => {};
    const lookupFailed = new Promise<void>((resolve) => {
      failLookup = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith(`/prompts/${DELETED_JUDGE}`)) {
          await lookupFailed;
          return fakeResponse({ error: { code: 'INTERNAL', message: 'boom' } }, 500);
        }
        if (url.endsWith(`/prompts/${DELETED_FILTER}`)) return fakeResponse({ id: DELETED_FILTER, name: 'support-reply' });
        return fakeResponse([]);
      }),
    );

    render(createElement(RuleDrawer, { open: true, onOpenChange: vi.fn(), rule: RULE }), {
      wrapper: wrapper(new QueryClient({ defaultOptions: { queries: { retry: false } } })),
    });

    const nameInput = await screen.findByDisplayValue('tone');
    fireEvent.change(nameInput, { target: { value: 'tone v2' } });
    failLookup();

    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    expect(screen.getByDisplayValue('tone v2')).toBeTruthy();
    expect(screen.getByText('Prompt name unavailable')).toBeTruthy();
    expect(screen.queryByText(/Deleted prompt/)).toBeNull();
  });
});
