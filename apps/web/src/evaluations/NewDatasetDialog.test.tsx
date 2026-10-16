// @vitest-environment jsdom
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ToastProvider } from '@/ui';
import { NewDatasetDialog } from './NewDatasetDialog';

function renderDialog() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ToastProvider>
          <NewDatasetDialog open onOpenChange={() => {}} />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('NewDatasetDialog', () => {
  afterEach(cleanup);

  it('tells the user the next screen can import a file, not only add rows by hand', () => {
    renderDialog();
    expect(screen.getByText(/import a CSV or JSON file/i)).toBeTruthy();
    expect(screen.queryByText(/Add examples by hand on the next screen/)).toBeNull();
  });
});
