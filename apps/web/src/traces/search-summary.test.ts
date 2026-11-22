import { describe, expect, it } from 'vitest';
import { searchSummary } from './search-summary';
import type { RetrievalView } from '@/api/types';

const view = (over: Partial<RetrievalView>): RetrievalView => ({
  detectedBy: 'kind', query: 'refunds', documents: [], documentCount: 0, outputCaptured: true, ...over,
});

describe('searchSummary (the span-tree row)', () => {
  it('shows the query, the count and the repeats', () => {
    const documents = [
      { id: 'a', text: 'x', score: null, source: null, metadata: null, truncated: false, repeatedFromSpanId: 't0' },
      { id: 'b', text: 'y', score: null, source: null, metadata: null, truncated: false, repeatedFromSpanId: null },
    ];
    expect(searchSummary(view({ documents, documentCount: 2 }), 'ok')).toBe('“refunds” → 2 docs · 1 repeated');
  });

  it('says "0 docs" only when the output was stored', () => {
    expect(searchSummary(view({}), 'ok')).toBe('“refunds” → 0 docs');
    expect(searchSummary(view({ outputCaptured: false }), 'ok')).toBe('“refunds” → output not stored');
    expect(searchSummary(view({ outputCaptured: false, query: null }), 'error')).toBe('failed');
  });
});
