import { detectRetrieval } from './detect-retrieval';
import { annotateRetrieval } from './annotate-retrieval';
import type { SpanNode } from '../query.types';
import { extractQuery } from './extract-query';

/** A tool span with the given input and output. */
const tool = (output: unknown, input: unknown = { query: 'q' }) => ({ kind: 'tool', payload: { input, output } });

describe('detectRetrieval — tool spans decided by output shape', () => {
  it('detects a LangChain document list', () => {
    const view = detectRetrieval(
      tool([
        { page_content: 'The Q3 pricing test was run by Dana.', metadata: { source: 'pricing-2024.md' } },
        { page_content: 'Pricing changed in July.', metadata: { source: 'notes.md' } },
      ]),
    );
    expect(view?.detectedBy).toBe('shape');
    expect(view?.documents).toHaveLength(2);
    expect(view?.documents[0]).toMatchObject({ text: 'The Q3 pricing test was run by Dana.', source: 'pricing-2024.md' });
  });

  it('detects Pinecone-style matches with the text in metadata', () => {
    const view = detectRetrieval(
      tool({ matches: [{ id: 'a1', score: 0.82, metadata: { text: 'Refunds take 5 days.' } }] }),
    );
    expect(view?.documents[0]).toMatchObject({ id: 'a1', score: 0.82, text: 'Refunds take 5 days.' });
  });

  it('detects our support tutorial shape {id, title, body} and uses the title as source', () => {
    const view = detectRetrieval(
      tool([{ id: 'returns', body: 'You can return an item within 30 days.', title: 'Returns' }]),
    );
    expect(view?.documents[0]).toMatchObject({ id: 'returns', source: 'Returns' });
  });

  it('parses an output stored as a JSON string', () => {
    const view = detectRetrieval(tool(JSON.stringify([{ text: 'Express shipping takes 1 to 2 days.', score: 0.7 }])));
    expect(view?.documents[0].score).toBe(0.7);
  });

  it.each([
    ['a price', { price: 120, currency: 'USD' }],
    ['an availability list with no text field', { available: true, rooms: [{ type: 'double', count: 2 }] }],
    ['a SQL row list with name fields', [{ name: 'Aeron Chair', total_revenue: 4185 }]],
    ['a formatted string', 'Doc 1: Refunds take 5 days.\n\nDoc 2: Shipping takes 3 days.'],
    ['an empty list', []],
  ])('does not treat %s as a search', (_label, output) => {
    expect(detectRetrieval(tool(output))).toBeNull();
  });

  it('needs at least half of the items to carry text', () => {
    expect(detectRetrieval(tool([{ text: 'one' }, { id: 1 }, { id: 2 }]))).toBeNull();
    expect(detectRetrieval(tool([{ text: 'one' }, { text: 'two' }, { id: 2 }]))).not.toBeNull();
  });

  it('reads OpenInference reassembled documents with metadata as a JSON string', () => {
    const view = detectRetrieval({
      kind: 'retrieval',
      payload: {
        input: 'refund window',
        output: [{ content: 'Refunds take 5 days.', id: 'd1', score: 0.8, metadata: '{"source":"a.md"}' }],
      },
    });
    expect(view).toMatchObject({ detectedBy: 'kind', query: 'refund window' });
    expect(view?.documents[0]).toMatchObject({ id: 'd1', source: 'a.md', metadata: { source: 'a.md' } });
  });

  it('caps a huge list at 50 documents and long text at 2,000 characters', () => {
    const output = Array.from({ length: 5000 }, (_, i) => ({ id: `d${i}`, text: 'x'.repeat(3000) }));
    const view = detectRetrieval(tool(output));
    expect(view?.documentCount).toBe(5000);
    expect(view?.documents).toHaveLength(50);
    expect(view?.documents[0].text).toHaveLength(2000);
    expect(view?.documents[0].truncated).toBe(true);
  });
});

describe('detectRetrieval — retrieval spans', () => {
  it('is a search even when nothing came back', () => {
    expect(detectRetrieval({ kind: 'retrieval', payload: { input: { question: 'x' }, output: [] } })).toEqual({
      detectedBy: 'kind',
      query: 'x',
      documents: [],
      documentCount: 0,
      outputCaptured: true,
    });
  });

  it('is a search with no payload captured', () => {
    expect(detectRetrieval({ kind: 'retrieval' })).toEqual({ detectedBy: 'kind', query: null, documents: [], documentCount: 0, outputCaptured: false });
  });

  it('leaves llm and payload-less tool spans alone', () => {
    expect(detectRetrieval({ kind: 'llm', payload: { input: [], output: [{ text: 'hello there' }] } })).toBeNull();
    expect(detectRetrieval({ kind: 'tool' })).toBeNull();
  });
});

describe('detectRetrieval — the toolKind marker set by the SDK decorator', () => {
  const marked = (toolKind: unknown, output: unknown, input: unknown = { query: 'refund window' }) => ({
    kind: 'tool',
    attributes: { toolKind },
    payload: { input, output },
  });

  it('turns detection off for a tool marked kind="tool", even with a document-shaped output', () => {
    expect(detectRetrieval(marked('tool', [{ text: 'Refunds take 5 days.' }]))).toBeNull();
  });

  it('reads documents from a tool marked kind="retrieval" and says the marker decided', () => {
    const view = detectRetrieval(marked('retrieval', [{ text: 'Refunds take 5 days.' }]));
    expect(view).toMatchObject({ detectedBy: 'marker', query: 'refund window', documentCount: 1 });
  });

  it.each([
    ['Doc 1: Refunds take 5 days.\n\nDoc 2: Express is 2 days.'],
    ['[1] Refunds take 5 days.\n[2] Express is 2 days.'],
    ['Source 1 - Refunds take 5 days.\nSource 2 - Express is 2 days.'],
    ['Document #1: Refunds take 5 days. Document #2: Express is 2 days.'],
  ])('splits a numbered formatted string into one document per label: %j', (output) => {
    const view = detectRetrieval(marked('retrieval', output));
    expect(view?.documentCount).toBe(2);
    expect(view?.documents.map((d) => d.id)).toEqual([null, null]);
    expect(view?.documents[0].text).toMatch(/Refunds take 5 days\.$/);
    expect(view?.documents[1].text).toMatch(/Express is 2 days\.$/);
  });

  it('keeps a string with one label or none as a single block', () => {
    expect(detectRetrieval(marked('retrieval', 'Refunds take 5 days.\n\nExpress is 2 days.'))?.documents).toHaveLength(1);
    expect(detectRetrieval(marked('retrieval', 'Doc 1: Refunds take 5 days.'))?.documents[0]).toMatchObject({
      id: null,
      text: 'Doc 1: Refunds take 5 days.',
    });
  });

  it('does not split an unmarked tool that returns a numbered string', () => {
    expect(detectRetrieval({ kind: 'tool', payload: { input: { query: 'q' }, output: 'Doc 1: a.\nDoc 2: b.' } })).toBeNull();
  });

  it('is still a search with zero documents or no payload when marked kind="retrieval"', () => {
    expect(detectRetrieval(marked('retrieval', []))).toMatchObject({ detectedBy: 'marker', documentCount: 0 });
    expect(detectRetrieval({ kind: 'tool', attributes: { toolKind: 'retrieval' } })).toMatchObject({
      detectedBy: 'marker',
      query: null,
      documentCount: 0,
    });
  });

  it('ignores an unknown toolKind value and falls back to the shape check', () => {
    expect(detectRetrieval(marked('vector', [{ text: 'Refunds take 5 days.' }]))?.detectedBy).toBe('shape');
  });
});

describe('extractQuery', () => {
  it.each([
    ['a string input', 'refund window', 'refund window'],
    ['a question argument', { question: 'When?' }, 'When?'],
    ['a query argument beside others', { query: 'q3 pricing', k: 5 }, 'q3 pricing'],
    ['the only string argument', { topic: 'returns', limit: 5 }, 'returns'],
    ['a JSON string input', '{"q":"shipping"}', 'shipping'],
  ])('reads %s', (_label, input, expected) => {
    expect(extractQuery(input)).toBe(expected);
  });

  it('returns null with two unnamed string arguments', () => {
    expect(extractQuery({ a: 'x', b: 'y' })).toBeNull();
  });
});

describe('detectRetrieval — review findings on PR #872', () => {
  const marked = (output: unknown) => ({ kind: 'tool', attributes: { toolKind: 'retrieval' }, payload: { input: { query: 'q' }, output } });

  it('turns a marked tool\'s list of strings into one document per string', () => {
    const view = detectRetrieval(marked(['Refunds take 5 days.', 'Express is 2 days.', 'Gift cards never expire.']));
    expect(view?.documentCount).toBe(3);
    expect(view?.documents.map((d) => d.text)).toEqual(['Refunds take 5 days.', 'Express is 2 days.', 'Gift cards never expire.']);
  });

  it('reads a list of strings under a list field', () => {
    expect(detectRetrieval(marked({ results: ['a passage', 'another passage'] }))?.documentCount).toBe(2);
  });

  it('shows an empty list wrapped in an object as nothing came back', () => {
    expect(detectRetrieval(marked({ matches: [], total: 0 }))).toMatchObject({ documentCount: 0, documents: [] });
  });

  it('reads a retrieval span\'s formatted string, list of strings and id-only items', () => {
    const span = (output: unknown) => ({ kind: 'retrieval', payload: { input: { query: 'q' }, output } });
    expect(detectRetrieval(span('Doc 1: Refunds take 5 days.\n\nDoc 2: Express is 2 days.'))?.documentCount).toBe(2);
    expect(detectRetrieval(span(['Refunds take 5 days.']))?.documentCount).toBe(1);
    const ids = detectRetrieval(span([{ id: 'd1', score: 0.9 }, { id: 'd2', score: 0.8 }]));
    expect(ids?.documentCount).toBe(2);
    expect(ids?.documents[0]).toMatchObject({ id: 'd1', score: 0.9, text: '' });
  });

  it.each([
    ['chat messages', [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]],
    ['MCP text content parts', [{ type: 'text', text: 'Sunny, 22C' }]],
  ])('does not take %s for documents', (_label, output) => {
    expect(detectRetrieval(tool(output))).toBeNull();
  });

  it('says whether the output was stored, so "not captured" never reads as "found nothing"', () => {
    expect(detectRetrieval({ kind: 'tool', attributes: { toolKind: 'retrieval' }, payload: { input: { query: 'x' }, output: null } })).toMatchObject({
      documentCount: 0,
      outputCaptured: false,
    });
    expect(detectRetrieval({ kind: 'retrieval' })?.outputCaptured).toBe(false);
    expect(detectRetrieval({ kind: 'retrieval', payload: { input: {}, output: [] } })?.outputCaptured).toBe(true);
  });

  it('does not split at in-text citations or at a number out of sequence', () => {
    const wiki = 'Paris is the capital of France [1] with an estimated population of 2,102,650 [2] residents.';
    expect(detectRetrieval(marked(wiki))?.documentCount).toBe(1);
    const prose = 'Doc 1: Refunds follow the rules in policy document 3. They take 5 days.\n\nDoc 2: Express is 2 days.';
    const view = detectRetrieval(marked(prose));
    expect(view?.documentCount).toBe(2);
    expect(view?.documents[0].text).toContain('policy document 3. They take 5 days.');
  });
});

describe('annotateRetrieval — repeats', () => {
  const node = (spanId: string, name: string, startedAt: string, output: unknown) =>
    ({
      spanId,
      parentSpanId: null,
      kind: 'retrieval',
      name,
      status: 'ok',
      startedAt,
      attributes: {},
      payload: { input: { query: 'q' }, output, variables: null, toolSetId: null, toolChoice: null },
      children: [],
    }) as unknown as SpanNode;

  it('does not mark unrelated documents that share a positional id as repeated', () => {
    const s1 = node('s1', 'search', '2026-01-01T00:00:00Z', [{ id: 1, text: 'Refunds take 5 days.' }, { id: 2, text: 'Returns within 30 days.' }]);
    const s2 = node('s2', 'search', '2026-01-01T00:00:01Z', [{ id: 1, text: 'Express shipping is 2 days.' }, { id: 2, text: 'Gift cards never expire.' }]);
    annotateRetrieval([s1, s2]);
    expect(s2.retrieval?.documents.map((d) => d.repeatedFromSpanId)).toEqual([null, null]);
  });

  it('still marks the same document returned again', () => {
    const s1 = node('s1', 'search', '2026-01-01T00:00:00Z', [{ id: 'doc-7', text: 'Refunds take 5 days.' }]);
    const s2 = node('s2', 'search', '2026-01-01T00:00:01Z', [{ id: 'doc-7', text: 'Refunds take 5 days.' }]);
    annotateRetrieval([s1, s2]);
    expect(s2.retrieval?.documents[0].repeatedFromSpanId).toBe('s1');
  });
});
