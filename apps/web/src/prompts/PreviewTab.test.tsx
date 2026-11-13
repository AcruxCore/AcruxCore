// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@/api/types';
import { PreviewTab } from './PreviewTab';

/** One request the Preview sent to the render endpoint, as the server would read it. */
interface SentPreview {
  url: string;
  body: { messages: Message[]; variables: Record<string, unknown> };
}

/**
 * Stubs `fetch` with a stand-in for `POST /prompts/:id/preview` that answers with
 * `respond(body)`, and records every request the Preview sends. The real endpoint's
 * rendering is covered by the API's own supertest suite (`preview.test.ts`); this file
 * covers what the browser is responsible for: what it sends and what it shows.
 */
function stubPreview(respond: (body: SentPreview['body']) => Message[]): SentPreview[] {
  const sent: SentPreview[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as SentPreview['body'];
      sent.push({ url, body });
      return new Response(JSON.stringify({ messages: respond(body) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return sent;
}

/** Renders the Preview for a prompt inside the QueryClientProvider it needs. */
function renderPreview(draft: Message[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  return render(createElement(PreviewTab, { promptId: 'p-1', draft }), { wrapper });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>)['__acxPreviewGadget'];
});

// The Preview shows another member's stored template to whoever opens the tab. nunjucks
// compiles a template into a JavaScript function and lets `''.constructor.constructor`
// reach the Function constructor, so rendering it in the page ran the author's code in
// the viewer's signed-in session. The page must never compile template content itself.
describe('PreviewTab never runs template content in the page', () => {
  it('does not execute a Function-constructor gadget in the stored template', async () => {
    const gadget = "{{ ''.constructor.constructor('globalThis.__acxPreviewGadget = true; return 42')() }}";
    const sent = stubPreview(() => [{ role: 'system', content: '' }]);

    renderPreview([{ role: 'system', content: gadget }]);

    // Checked first: an in-page render runs the gadget while the component mounts.
    expect((globalThis as Record<string, unknown>)['__acxPreviewGadget']).toBeUndefined();
    await waitFor(() => expect(sent).toHaveLength(1));
    expect((globalThis as Record<string, unknown>)['__acxPreviewGadget']).toBeUndefined();
    expect(screen.queryByText('42')).toBeNull();
    // The template went to the server's sandboxed renderer untouched.
    expect(sent[0]!.body.messages).toEqual([{ role: 'system', content: gadget }]);
  });

  it('shows the output the render endpoint returned', async () => {
    const sent = stubPreview(() => [{ role: 'user', content: 'Hello from the sandbox.' }]);

    renderPreview([{ role: 'user', content: 'Hello {{ name }}.' }]);

    expect(await screen.findByText('Hello from the sandbox.')).toBeTruthy();
    expect(sent[0]!.url).toBe('/api/v1/prompts/p-1/preview');
  });
});

// Issue #534: every Preview input reached the template as a string, so a list variable
// showed `arr.join is not a function` and a `{% for %}` loop walked its characters.
describe('PreviewTab list and object variables', () => {
  it('sends a JSON list typed into a field as a list', async () => {
    const sent = stubPreview((b) => [{ role: 'user', content: `got ${JSON.stringify(b.variables)}` }]);
    renderPreview([{ role: 'user', content: 'Avoid: {{ xs | join(", ") }}.' }]);

    fireEvent.change(screen.getByLabelText('xs'), { target: { value: '["age", "religion"]' } });

    expect(await screen.findByText('got {"xs":["age","religion"]}')).toBeTruthy();
    expect(sent.at(-1)!.body.variables).toEqual({ xs: ['age', 'religion'] });
  });

  it('sends a JSON object as an object', async () => {
    const sent = stubPreview((b) => [{ role: 'user', content: `got ${JSON.stringify(b.variables)}` }]);
    renderPreview([{ role: 'user', content: '{{ user.name }}:{% for x in xs %} [{{ x }}]{% endfor %}' }]);

    fireEvent.change(screen.getByLabelText('user'), { target: { value: '{"name": "Ada"}' } });
    fireEvent.change(screen.getByLabelText('xs'), { target: { value: '["a", "b"]' } });

    expect(await screen.findByText('got {"user":{"name":"Ada"},"xs":["a","b"]}')).toBeTruthy();
    expect(sent.at(-1)!.body.variables).toEqual({ user: { name: 'Ada' }, xs: ['a', 'b'] });
  });

  it('keeps text that only looks like JSON as plain text', async () => {
    const sent = stubPreview((b) => [{ role: 'user', content: `got ${JSON.stringify(b.variables)}` }]);
    renderPreview([{ role: 'user', content: 'Status: {{ s }}' }]);

    fireEvent.change(screen.getByLabelText('s'), { target: { value: '[draft]' } });

    expect(await screen.findByText('got {"s":"[draft]"}')).toBeTruthy();
    expect(sent.at(-1)!.body.variables).toEqual({ s: '[draft]' });
  });
});
