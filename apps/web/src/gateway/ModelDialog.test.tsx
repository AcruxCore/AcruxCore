// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayModel } from '@/api';

/** Runware's list, as `GET /gateway/connections/:id/models` returns it. */
const RUNWARE_LIST = {
  ok: true,
  models: [
    { id: 'deepseek-v4-flash', pricing: { inputPricePerM: 0.076, outputPricePerM: 0.153, cachedInputPricePerM: 0.014 } },
    { id: 'minimax-m3', pricing: { inputPricePerM: 0.3, outputPricePerM: 1.2, cachedInputPricePerM: 0.06 } },
    { id: 'openai-gpt-5-5', pricing: { inputPricePerM: 1.25, outputPricePerM: 10 } },
    { id: 'unpriced-model' },
  ],
};

const api = vi.hoisted(() => ({
  lists: {} as Record<string, unknown>,
  updates: [] as Array<{ id: string; body: Record<string, unknown> }>,
}));

// Each hook returns the same object on every render, as react-query does; a fresh array per
// render would re-run the dialog's reset effect forever.
vi.mock('@/api', () => {
  const connections = {
    data: [
      { id: 'cred-rw', label: 'Runware', provider: 'runware' },
      { id: 'cred-oa', label: 'OpenAI', provider: 'openai' },
    ],
  };
  const models = { data: [] };
  const create = { isPending: false, mutateAsync: async () => undefined };
  const update = {
    isPending: false,
    mutateAsync: async (arg: { id: string; body: Record<string, unknown> }) => api.updates.push(arg),
  };
  const listResults: Record<string, { data: unknown; isFetching: boolean }> = {};
  return {
    ApiError: class ApiError extends Error {},
    useConnections: () => connections,
    useConnectionModels: (id: string) => {
      if (listResults[id]?.data !== api.lists[id]) listResults[id] = { data: api.lists[id], isFetching: false };
      return listResults[id] ?? { data: undefined, isFetching: false };
    },
    useModels: () => models,
    useCreateModel: () => create,
    useUpdateModel: () => update,
  };
});

import { ToastProvider } from '@/ui';
import { ModelDialog } from './ModelDialog';

function gatewayModel(over: Partial<GatewayModel>): GatewayModel {
  return {
    id: 'm-1',
    publicName: 'm',
    upstreamModel: 'minimax-m3',
    credentialId: 'cred-rw',
    inputPricePerM: null,
    outputPricePerM: null,
    cachedInputPricePerM: null,
    fallbacks: [],
    ...over,
  } as GatewayModel;
}

function view(open: boolean, model?: GatewayModel | null) {
  return (
    <ToastProvider>
      <ModelDialog open={open} onOpenChange={() => {}} model={model} />
    </ToastProvider>
  );
}

const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const prices = () => [field('model-in').value, field('model-out').value, field('model-cached').value];

/** Picks a row from the upstream-model list, as a click on it does. */
function pick(id: string) {
  const box = field('model-upstream');
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value: id } });
  fireEvent.mouseDown(screen.getByRole('option', { name: id }));
}

beforeEach(() => {
  // jsdom has no layout, so the picker's scroll-into-view call has nothing to call.
  Element.prototype.scrollIntoView = () => {};
  api.lists = { 'cred-rw': RUNWARE_LIST, 'cred-oa': { ok: false, error: 'HTTP 500' } };
  api.updates = [];
});
afterEach(() => cleanup());

describe('ModelDialog price copy', () => {
  it('opens Edit on a model with that model’s saved prices, after editing another one', () => {
    const y = gatewayModel({ id: 'y', upstreamModel: 'openai-gpt-5-5', inputPricePerM: 0.5, outputPricePerM: 2 });
    const x = gatewayModel({ id: 'x', upstreamModel: 'minimax-m3', inputPricePerM: 0.31, outputPricePerM: 1.21 });
    const { rerender } = render(view(true, y));
    expect(prices()).toEqual(['0.5', '2', '']);
    rerender(view(false, null));
    rerender(view(true, x));
    expect(prices()).toEqual(['0.31', '1.21', '']);
    expect(screen.queryByText(/Prices copied/)).toBeNull();
  });

  it('opens New model with empty prices after editing a model', () => {
    const y = gatewayModel({ id: 'y', upstreamModel: 'openai-gpt-5-5', inputPricePerM: 0.5, outputPricePerM: 2 });
    const { rerender } = render(view(true, y));
    rerender(view(false, null));
    rerender(view(true, null));
    expect(prices()).toEqual(['', '', '']);
  });

  it('replaces the saved prices when an edit picks another upstream model', () => {
    render(view(true, gatewayModel({ inputPricePerM: 0.3, outputPricePerM: 1.2 })));
    pick('openai-gpt-5-5');
    expect(prices()).toEqual(['1.25', '10', '']);
    expect(screen.getByText(/Prices copied from Runware/).textContent).toContain('openai-gpt-5-5');
  });

  it('keeps a price typed during the edit when another upstream model is picked', () => {
    render(view(true, gatewayModel({ inputPricePerM: 0.3, outputPricePerM: 1.2 })));
    fireEvent.change(field('model-out'), { target: { value: '9' } });
    pick('openai-gpt-5-5');
    expect(prices()).toEqual(['1.25', '9', '']);
  });

  it('puts the saved prices back when an edit returns to its own upstream model', () => {
    render(view(true, gatewayModel({ inputPricePerM: 0.29, outputPricePerM: 1.19 })));
    pick('deepseek-v4-flash');
    expect(prices()).toEqual(['0.076', '0.153', '0.014']);
    pick('minimax-m3');
    expect(prices()).toEqual(['0.29', '1.19', '']);
    expect(screen.queryByText(/Prices copied/)).toBeNull();
  });

  it('clears the saved prices on save when an edit picks a model the list has no price for', async () => {
    render(view(true, gatewayModel({ inputPricePerM: 0.3, outputPricePerM: 1.2 })));
    pick('unpriced-model');
    expect(prices()).toEqual(['', '', '']);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
    });
    expect(api.updates[0]?.body).toMatchObject({ upstreamModel: 'unpriced-model', inputPricePerM: null, outputPricePerM: null });
  });

  it('shows no copy note when every price was typed before the pick', () => {
    render(view(true, null));
    fireEvent.change(field('model-in'), { target: { value: '1' } });
    fireEvent.change(field('model-out'), { target: { value: '2' } });
    fireEvent.change(field('model-cached'), { target: { value: '0.5' } });
    pick('minimax-m3');
    expect(prices()).toEqual(['1', '2', '0.5']);
    expect(screen.queryByText(/Prices copied/)).toBeNull();
  });

  it('names the provider the prices came from after the credential changes', () => {
    render(view(true, null));
    pick('minimax-m3');
    fireEvent.change(field('model-cred'), { target: { value: 'cred-oa' } });
    expect(prices()).toEqual(['0.3', '1.2', '0.06']);
    expect(screen.getByText(/Prices copied/).textContent).toContain('Runware');
    expect(screen.queryByText(/Prices copied from OpenAI/)).toBeNull();
  });
});
