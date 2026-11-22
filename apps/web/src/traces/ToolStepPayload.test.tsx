// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolStepPayload } from './ToolStepPayload';
import type { Span } from '@/api/types';

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const searchSpan = {
  spanId: 't1', name: 'search_kb', kind: 'tool', status: 'ok', attributes: {}, children: [],
  payload: { input: { query: 'refunds' }, output: [{ text: 'Refunds take 5 days.' }] },
  retrieval: {
    detectedBy: 'shape', query: 'refunds', documentCount: 1,
    documents: [{ id: null, text: 'Refunds take 5 days.', score: null, source: null, metadata: null, truncated: false, repeatedFromSpanId: null }],
  },
} as unknown as Span;

const render1 = () => render(createElement(ToolStepPayload, { span: searchSpan, stepOf: () => undefined }));

describe('ToolStepPayload on a search step', () => {
  it('switches between documents and JSON from the top of the step', () => {
    render1();
    expect(screen.getByTestId('retrieval-view')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'JSON' }));
    expect(screen.queryByTestId('retrieval-view')).toBeNull();
    expect(screen.getByText('Output')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Documents' }));
    expect(screen.getByTestId('retrieval-view')).toBeTruthy();
  });

  it('remembers the last choice for the next search step it opens', () => {
    render1();
    fireEvent.click(screen.getByRole('tab', { name: 'JSON' }));
    cleanup();
    render1();
    expect(screen.queryByTestId('retrieval-view')).toBeNull();
    expect(screen.getByRole('tab', { name: 'JSON' }).getAttribute('aria-selected')).toBe('true');
  });
});
