// @vitest-environment jsdom
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/ui';
import { AddExampleDialog } from './AddExampleDialog';

function tree(open: boolean) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ToastProvider>
          <AddExampleDialog datasetId="ds-1" open={open} onOpenChange={() => {}} />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function openManualTab() {
  const tab = screen.getByRole('tab', { name: 'Manual' });
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
}

describe('AddExampleDialog', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('opens with an empty Expected box, not the previous example\'s value (PR #602 review)', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } })));
    const view = render(tree(true));
    openManualTab();
    const expected = () => screen.getByTestId('add-example-expected') as HTMLTextAreaElement;
    fireEvent.change(expected(), { target: { value: '{"category": "billing"}' } });
    expect(expected().value).toBe('{"category": "billing"}');

    view.rerender(tree(false));
    view.rerender(tree(true));
    openManualTab();
    expect(expected().value).toBe('');
  });
});
