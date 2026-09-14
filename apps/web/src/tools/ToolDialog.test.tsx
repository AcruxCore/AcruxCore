// @vitest-environment jsdom
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/ui';
import { ToolDialog } from './ToolDialog';

/** A response object shaped exactly the way `api()` reads it — no real fetch involved. */
function fakeResponse(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * Hosts `ToolDialog` behind a `open`/`onOpenChange` pair a test can drive, plus a
 * "reopen" button — the dialog itself has no trigger, so something outside it must be
 * able to flip `open` back to `true` to simulate the user coming back.
 */
function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        reopen
      </button>
      <ToolDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function renderDialog() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ToastProvider>
          <Harness />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  // RTL's own auto-cleanup only registers when `afterEach` is a real test-runner global
  // (vitest's `test.globals` is off here, matching the rest of this suite), so without
  // this the previous test's dialog stays mounted and its "Commit first version" toast
  // and button leak into the next test's queries.
  cleanup();
  vi.unstubAllGlobals();
});

describe('ToolDialog', () => {
  /**
   * Regression test for finding 3c. The shell POST succeeds, the version POST is
   * refused (e.g. an executor URL that fails the SSRF check), and the user closes the
   * dialog (Escape) to go fix it and reopens it later. The dialog must still offer
   * "Commit first version" for the same name — not throw the stranded shell away and
   * let a retype of the identical name collide with the name the first shell already
   * took (`A tool named 'get_weather' already exists in this team.`).
   */
  it('keeps offering to commit onto the stranded shell after a close and reopen', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url === '/api/v1/tools') {
        return fakeResponse({
          id: 'tool-1',
          name: 'get_weather',
          description: null,
          teamId: 'team-1',
          createdBy: 'user-1',
          createdAt: new Date().toISOString(),
          callable: false,
          versionCount: 0,
          latestVersionNumber: null,
          executorType: null,
          aliases: [],
        });
      }
      // The version commit is refused — the shell survives, but the tool is not usable
      // yet. Any 4xx/5xx body with an `error` envelope makes `api()` throw an ApiError.
      return fakeResponse({ error: { code: 'EXECUTOR_URL_REFUSED', message: 'URL not allowed.' } }, 422);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderDialog();

    const nameInput = screen.getByLabelText('Name');
    fireEvent.change(nameInput, { target: { value: 'get_weather' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create tool' }));

    // The shell was created; the version commit failed, so the dialog now offers to
    // commit onto the stranded shell instead of "Create tool".
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit first version' })).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Close (Escape / Cancel) and reopen, the way the user does to go find the right URL.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'reopen' }));

    // The dialog still remembers the stranded shell — its name field resets (as before),
    // but the moment the same name is retyped it should offer "Commit first version"
    // again, not a plain "Create tool".
    expect(screen.queryByRole('button', { name: 'Commit first version' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'get_weather' } });
    expect(screen.getByRole('button', { name: 'Commit first version' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Commit first version' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    // The retry must commit onto the existing shell (POST .../versions) rather than
    // create a second one (a second POST /tools, which would collide on the name).
    const thirdCall = fetchMock.mock.calls[2];
    expect(thirdCall[0]).toBe('/api/v1/tools/tool-1/versions');
    expect(thirdCall[1]?.method).toBe('POST');
  });

  /**
   * The other half of finding 3c: a stranded shell must not be committed onto once the
   * user has moved on to a different name.
   */
  it('stops offering the stranded shell once the name changes to something else', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url === '/api/v1/tools') {
        return fakeResponse({
          id: 'tool-1',
          name: 'get_weather',
          description: null,
          teamId: 'team-1',
          createdBy: 'user-1',
          createdAt: new Date().toISOString(),
          callable: false,
          versionCount: 0,
          latestVersionNumber: null,
          executorType: null,
          aliases: [],
        });
      }
      return fakeResponse({ error: { code: 'EXECUTOR_URL_REFUSED', message: 'URL not allowed.' } }, 422);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderDialog();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'get_weather' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create tool' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit first version' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'reopen' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'get_forecast' } });

    expect(screen.getByRole('button', { name: 'Create tool' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Commit first version' })).toBeNull();

    // The label is the visible half of the invariant; this is the half that matters.
    // Submitting under the new name must claim a NEW shell rather than commit onto the
    // stranded `get_weather` one, which would hand `get_forecast`'s version to a tool
    // of another name.
    fireEvent.click(screen.getByRole('button', { name: 'Create tool' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock.mock.calls[2][0]).toBe('/api/v1/tools');
  });
});
