// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditTab } from './AuditTab';

const actor = { id: 'u-1', email: 'dev@example.com' };

function stubAudit(entries: object[]) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ data: entries, total: entries.length, page: 1, limit: 20 }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )));
}

describe('AuditTab', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows which version an alias moved from and to, so a rollback can be traced', async () => {
    stubAudit([
      { id: 'a-2', event: 'alias_promoted', actor, createdAt: '2026-10-16T10:01:00Z',
        metadata: { alias: 'production', fromVersionNumber: 2, toVersionNumber: 1 } },
      { id: 'a-1', event: 'alias_promoted', actor, createdAt: '2026-10-16T10:00:00Z',
        metadata: { alias: 'production', fromVersionNumber: 1, toVersionNumber: 2 } },
    ]);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AuditTab promptId="p-1" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('production · v2 → v1')).toBeTruthy();
    expect(screen.getByText('production · v1 → v2')).toBeTruthy();
  });
});
