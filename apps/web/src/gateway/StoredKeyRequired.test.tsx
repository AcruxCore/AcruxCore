// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const connections = vi.hoisted(() => ({ current: {} as { data?: unknown[]; isSuccess: boolean } }));
vi.mock('@/api', () => ({ useConnections: () => connections.current }));

import { StoredKeyRequired } from './StoredKeyRequired';

afterEach(() => cleanup());

function renderPanel() {
  render(<MemoryRouter><StoredKeyRequired feature="The Playground" /></MemoryRouter>);
}

describe('StoredKeyRequired', () => {
  it('does not tell a team to add a credential before its credentials have loaded', () => {
    // A team with a credential but no model saw "Add a credential" until the list
    // loaded, and for good if that request failed.
    connections.current = { data: undefined, isSuccess: false };
    renderPanel();
    expect(screen.queryByText('Add a credential')).toBeNull();
    expect(screen.getByText('Add a model')).toBeTruthy();
  });

  it('asks for a credential once the list has loaded empty', () => {
    connections.current = { data: [], isSuccess: true };
    renderPanel();
    expect(screen.getByText('Add a credential')).toBeTruthy();
  });
});
