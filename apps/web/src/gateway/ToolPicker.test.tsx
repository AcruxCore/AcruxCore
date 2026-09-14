// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolSummary } from '@/api';
import { ToolPicker } from './ToolPicker';

/** A tool row shaped the way the readiness DTO returns it. */
function tool(over: Partial<ToolSummary> = {}): ToolSummary {
  return {
    id: 't-1',
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    teamId: 'team-1',
    createdBy: 'u-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    callable: true,
    versionCount: 3,
    latestVersionNumber: 3,
    executorType: 'http',
    aliases: [{ alias: 'production', versionNumber: 2 }],
    ...over,
  };
}

afterEach(() => {
  cleanup();
});

describe('ToolPicker', () => {
  /**
   * Regression test for finding 4c. The Playground's picker filtered on name only and had
   * no reference to `callable` anywhere, so a version-less tool selected here reached
   * `useToolLoop`'s `tool_refs: [{ name }]` and the gateway resolver failed with "has no
   * versions, so alias production does not exist yet" — the exact silent-shell failure
   * this PR fixed one component over, in the prompt's own tool picker.
   */
  it('disables a non-callable tool with the same badge and explanation as the prompt picker', () => {
    const notCallable = tool({ id: 't-2', name: 'send_email', callable: false, versionCount: 0, latestVersionNumber: null, executorType: null, aliases: [] });
    const onChange = vi.fn();
    render(
      <ToolPicker tools={[tool(), notCallable]} selectedIds={[]} onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Select tools…' }));

    const option = screen.getByRole('option', { name: /send_email/ }) as HTMLButtonElement;
    expect(option.disabled).toBe(true);
    expect(option.getAttribute('title')).toBe(
      'This tool has no version on production yet, so nothing can call it.',
    );
    expect(screen.queryByText('no version')).toBeTruthy();

    fireEvent.click(option);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('leaves a callable tool selectable with no badge', () => {
    const onChange = vi.fn();
    render(<ToolPicker tools={[tool()]} selectedIds={[]} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Select tools…' }));

    const option = screen.getByRole('option', { name: 'get_weather' }) as HTMLButtonElement;
    expect(option.disabled).toBe(false);
    expect(option.getAttribute('title')).toBeNull();

    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith(['t-1']);
  });

  /**
   * Regression test for finding 4d. This picker had its own inline `t.name.includes(q)`
   * copy of the search predicate — the prompt's tools tab and `catalog.ts`'s own
   * `filterTools` both also match on description, so the same query behaved
   * differently depending on which of the three copies happened to run it. Collapsing
   * onto the shared {@link filterTools} is what makes a description match here too.
   */
  it('matches the shared filterTools predicate, including on description', () => {
    const onChange = vi.fn();
    render(
      <ToolPicker
        tools={[tool(), tool({ id: 't-2', name: 'send_email', description: 'Deliver a message.' })]}
        selectedIds={[]}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Select tools…' }));
    fireEvent.change(screen.getByPlaceholderText('Search tools…'), { target: { value: 'deliver' } });

    expect(screen.getByRole('option', { name: 'send_email' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'get_weather' })).toBeNull();
  });
});
