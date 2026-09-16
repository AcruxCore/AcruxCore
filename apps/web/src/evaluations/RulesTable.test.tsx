// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/ui';
import { RulesTable } from './RulesTable';
import type { EvalRule } from '@/api/types';

/**
 * What an editor sees on the Rules table (issue #510).
 *
 * Create, change and delete are owner or admin, because a rule scores live
 * traffic continuously. The table used to render Delete and a working enabled
 * switch for everyone, so an editor's only way to learn the bar was to click
 * and read a 403.
 */
function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: qc },
      createElement(ToastProvider, null, children),
    );
  };
}

const RULE = {
  id: 'r1',
  name: 'quality gate',
  criteria: 'answers the question',
  enabled: true,
  sampleRate: 1,
  dailyLimit: null,
  todayCount: 3,
  todayMeanScore: 80,
  judgeModel: 'gpt-4o-mini',
} as unknown as EvalRule;

afterEach(cleanup);

describe('RulesTable role gating', () => {
  it('offers an owner or admin Delete and a live enabled switch', () => {
    render(
      createElement(RulesTable, {
        rules: [RULE],
        onSelectRule: vi.fn(),
        onDeleteRule: vi.fn(),
        canManage: true,
      }),
      { wrapper: wrapper() },
    );

    expect(screen.getByTestId('rule-delete-button')).toBeTruthy();
    expect(screen.getByTestId('rule-enabled-toggle').hasAttribute('disabled')).toBe(false);
    expect(screen.getByTestId('rule-edit-button').textContent).toBe('Edit');
  });

  it('shows an editor the rule without the two controls that would 403', () => {
    render(
      createElement(RulesTable, {
        rules: [RULE],
        onSelectRule: vi.fn(),
        onDeleteRule: vi.fn(),
        canManage: false,
      }),
      { wrapper: wrapper() },
    );

    expect(screen.queryByTestId('rule-delete-button')).toBeNull();
    expect(screen.getByTestId('rule-enabled-toggle').hasAttribute('disabled')).toBe(true);
    // The row still opens — an editor may read the rule, preview it, and build a
    // dataset from it, so the action is named for what it does rather than removed.
    expect(screen.getByTestId('rule-edit-button').textContent).toBe('Open');
    expect(screen.getByText('quality gate')).toBeTruthy();
  });
});
