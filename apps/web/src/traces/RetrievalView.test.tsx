// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RetrievalView } from './RetrievalView';
import type { RetrievedDocument } from '@/api/types';

afterEach(cleanup);

const doc = (over: Partial<RetrievedDocument>): RetrievedDocument => ({
  id: 'doc-1', text: 'The test was run by Dana.', score: 0.82, source: 'pricing.md', metadata: null,
  truncated: false, repeatedFromSpanId: null, ...over,
});

describe('RetrievalView', () => {
  it('shows the query and one card per document with its marks', () => {
    render(createElement(RetrievalView, {
      view: { outputCaptured: true, detectedBy: 'shape', query: 'pricing experiment owner', documentCount: 2, documents: [
        doc({ id: 'wiki-3' }),
        doc({ id: 'pricing-4', repeatedFromSpanId: 't1' }),
      ] },
      stepOf: (spanId: string) => (spanId === 't1' ? 1 : undefined),
    }));
    expect(screen.getByTestId('retrieval-query').textContent).toContain('pricing experiment owner');
    expect(screen.getAllByTestId('retrieval-doc')).toHaveLength(2);
    expect(screen.getByText('repeated from step 1')).toBeTruthy();
    expect(screen.getAllByText('0.82')).toHaveLength(2);
  });

  it('counts repeated documents in the header', () => {
    render(createElement(RetrievalView, {
      view: { outputCaptured: true, detectedBy: 'shape', query: 'q', documentCount: 3, documents: [
        doc({ id: 'a', repeatedFromSpanId: 't0' }), doc({ id: 'b' }), doc({ id: 'c' }),
      ] },
      stepOf: () => undefined,
    }));
    expect(screen.getByTestId('retrieval-counts').textContent).toBe('3 documents · 1 repeated');
  });

  it('shows a document as one line and opens its full multi-line text on click', () => {
    render(createElement(RetrievalView, {
      view: { outputCaptured: true, detectedBy: 'marker', query: 'q', documentCount: 1, documents: [
        doc({ id: null, source: null, text: 'Doc 1: Refunds\nare paid\nwithin\n5 days.' }),
      ] },
      stepOf: () => undefined,
    }));
    const row = screen.getByTestId('retrieval-doc');
    expect(screen.getByTestId('retrieval-doc-preview').textContent).toBe('Doc 1: Refunds');
    expect(screen.queryByTestId('retrieval-doc-text')).toBeNull();
    fireEvent.click(row.querySelector('button')!);
    expect(screen.getByTestId('retrieval-doc-text').textContent).toBe('Doc 1: Refunds\nare paid\nwithin\n5 days.');
  });

  it('shows the first 5 documents, then all on request', () => {
    const documents = Array.from({ length: 10 }, (_, i) => doc({ id: `d${i + 1}` }));
    render(createElement(RetrievalView, {
      view: { outputCaptured: true, detectedBy: 'shape', query: 'q', documentCount: 10, documents },
      stepOf: () => undefined,
    }));
    const ids = () => screen.getAllByTestId('retrieval-doc').map((li) => li.getAttribute('data-doc-rank'));
    expect(ids()).toEqual(['1', '2', '3', '4', '5']);
    fireEvent.click(screen.getByText('Show 5 more'));
    expect(ids()).toHaveLength(10);
  });

  it('says so when the search came back empty', () => {
    render(createElement(RetrievalView, { view: { outputCaptured: true, detectedBy: 'kind', query: 'x', documentCount: 0, documents: [] }, stepOf: () => undefined }));
    expect(screen.getByText('Searched, nothing came back.')).toBeTruthy();
  });

  it('says how many documents the API left out', () => {
    render(createElement(RetrievalView, { view: { outputCaptured: true, detectedBy: 'shape', query: null, documentCount: 120, documents: [doc({})] }, stepOf: () => undefined }));
    expect(screen.getByText('Showing 1 of 120 documents.')).toBeTruthy();
  });

  it('offers the hidden documents by how many are hidden, not by the total', () => {
    const documents = Array.from({ length: 50 }, (_, i) => doc({ id: `d${i + 1}` }));
    render(createElement(RetrievalView, { view: { outputCaptured: true, detectedBy: 'shape', query: null, documentCount: 120, documents }, stepOf: () => undefined }));
    expect(screen.getByText('Show 45 more')).toBeTruthy();
    expect(screen.queryByText(/Show all/)).toBeNull();
  });

  it('says the output was not stored, instead of "nothing came back"', () => {
    render(createElement(RetrievalView, { view: { outputCaptured: false, detectedBy: 'marker', query: 'x', documentCount: 0, documents: [] }, stepOf: () => undefined }));
    expect(screen.getByText('No output was stored for this search.')).toBeTruthy();
    expect(screen.queryByText('Searched, nothing came back.')).toBeNull();
    expect(screen.queryByTestId('retrieval-counts')).toBeNull();
  });

  it('says the search failed when the step errored before returning', () => {
    render(createElement(RetrievalView, { failed: true, view: { outputCaptured: false, detectedBy: 'marker', query: 'x', documentCount: 0, documents: [] }, stepOf: () => undefined }));
    expect(screen.getByText('The search failed before returning documents.')).toBeTruthy();
  });
});
