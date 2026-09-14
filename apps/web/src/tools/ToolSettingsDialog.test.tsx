// @vitest-environment jsdom
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolDetail } from '@/api';
import { ToastProvider } from '@/ui';
import { ToolSettingsDialog } from './ToolSettingsDialog';

/** A tool row shaped the way the readiness DTO returns it. */
function tool(over: Partial<ToolDetail> = {}): ToolDetail {
  return {
    id: 't-1',
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    teamId: 'team-1',
    createdBy: 'u-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    callable: true,
    versionCount: 1,
    latestVersionNumber: 1,
    executorType: 'client',
    aliases: [],
    ...over,
  };
}

/**
 * Hosts `ToolSettingsDialog` behind a `tool` prop a test can update in place — simulating
 * a `GET /tools/:id` (or the `POST /tools/sync` it follows) refetch landing while the
 * dialog stays open, without the dialog ever closing.
 */
function Harness() {
  const [t, setT] = useState<ToolDetail>(tool());
  return (
    <>
      <button
        type="button"
        onClick={() => setT((prev) => ({ ...prev, description: 'Refreshed by a background sync.' }))}
      >
        sync
      </button>
      <ToolSettingsDialog tool={t} open onOpenChange={() => {}} onDeleted={() => {}} />
    </>
  );
}

function renderDialog() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <Harness />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe('ToolSettingsDialog', () => {
  /**
   * Regression test for finding 5c. The reset effect depended on `tool.name`/
   * `tool.description`, so a `POST /tools/sync` that changes either while the dialog is
   * open — and the query refetches — re-ran the effect and threw away whatever the user
   * had typed but not yet saved. The effect must reset only on open, or on the tool's
   * identity (`tool.id`) changing — never on its contents changing.
   */
  it('keeps an in-progress edit when the tool prop changes contents while the dialog stays open', () => {
    renderDialog();

    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'get_weather_v2' } });
    expect(nameInput.value).toBe('get_weather_v2');

    // The description changed underneath the dialog (a concurrent sync), but the dialog
    // never closed and the tool is still the same tool. The trigger sits outside the
    // dialog's portal, which the dialog marks `aria-hidden` while open — `hidden: true`
    // is what lets the query see it anyway.
    fireEvent.click(screen.getByRole('button', { name: 'sync', hidden: true }));

    expect(nameInput.value).toBe('get_weather_v2');
  });
});
