import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';

const app = createApp();

/** ISO time `ms` after a fixed start, so span order is explicit. */
const at = (ms: number): string => new Date(Date.UTC(2026, 10, 20, 10, 0, 0) + ms).toISOString();

/** An OpenAI-style completion stored as a JSON string, the way the gateway stores it. */
const completion = (content: string | null) =>
  JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] });

const DOC_PRICING = { id: 'doc-2', text: 'The Q3 pricing test was run by Dana Ortiz from the growth team.', score: 0.82 };
const DOC_NOTES = { id: 'doc-7', text: 'Pricing pages were redesigned in July.', score: 0.41 };
const DOC_OWNER = { id: 'doc-9', text: 'Experiment owners are listed in the growth wiki.', score: 0.66 };

/** An agentic RAG run: search, rewrite, search again (one repeat), a price lookup, an answer. */
function ragTrace(capturePayloads: boolean) {
  return {
    name: 'rag-agent',
    capturePayloads,
    spans: [
      { spanId: 'l1', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: at(0), input: [{ role: 'user', content: 'Who ran the Q3 pricing test?' }], output: completion(null) },
      { spanId: 't1', name: 'search_docs', kind: 'tool', status: 'ok', startTime: at(100), input: { query: 'Q3 pricing test' }, output: [DOC_PRICING, DOC_NOTES] },
      { spanId: 'l2', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: at(200), input: [], output: completion(null) },
      { spanId: 't2', name: 'search_docs', kind: 'tool', status: 'ok', startTime: at(300), input: { query: 'pricing experiment owner' }, output: JSON.stringify([DOC_OWNER, DOC_PRICING]) },
      { spanId: 't3', name: 'get_price', kind: 'tool', status: 'ok', startTime: at(400), input: { sku: 'PRO' }, output: { price: 120, currency: 'USD' } },
      { spanId: 'l3', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: at(500), input: [], output: completion('The Q3 pricing test was run by Dana Ortiz.') },
    ],
  };
}

async function ingest(agent: ReturnType<typeof request.agent>, traces: unknown[]): Promise<string[]> {
  const res = await agent.post('/api/v1/traces').send({ traces }).expect(200);
  return res.body.traceIds as string[];
}

/** The parts of a returned span these tests read. */
interface ReturnedSpan {
  spanId: string;
  children: ReturnedSpan[];
  retrieval?: {
    detectedBy: string;
    query: string | null;
    documentCount: number;
    outputCaptured: boolean;
    documents: Array<{ id: string | null; text: string; repeatedFromSpanId: string | null }>;
  };
}

/** Finds a span anywhere in a returned tree. */
function find(spans: ReturnedSpan[], id: string): ReturnedSpan {
  for (const s of spans) {
    if (s.spanId === id) return s;
    const hit = find(s.children, id);
    if (hit) return hit;
  }
  return null as unknown as ReturnedSpan;
}

/** Text that gzip cannot shrink, so a stored output really is as large as its length. */
const noise = (chars: number, seed: number): string => {
  let x = seed;
  let out = '';
  while (out.length < chars) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += x.toString(36);
  }
  return out.slice(0, chars);
};

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE
    span_payloads, spans, traces, team_trace_settings,
    api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('search steps in GET /api/v1/traces/:id (issue #870)', () => {
  it('adds the query, documents and repeats to search spans only', async () => {
    const { agent } = await authedAgent(app);
    const [traceId] = await ingest(agent, [ragTrace(true)]);

    const res = await agent.get(`/api/v1/traces/${traceId}`).expect(200);
    const t1 = find(res.body.spans, 't1');
    const t2 = find(res.body.spans, 't2');
    if (!t1.retrieval || !t2.retrieval) throw new Error('both searches should have a view');

    expect(t1.retrieval).toMatchObject({ detectedBy: 'shape', query: 'Q3 pricing test', documentCount: 2 });
    expect(t2.retrieval.query).toBe('pricing experiment owner');

    // doc-2 came back again in the second search.
    const repeated = t2.retrieval.documents.find((d) => d.id === 'doc-2');
    expect(repeated?.repeatedFromSpanId).toBe('t1');
    expect(t1.retrieval.documents[0].repeatedFromSpanId).toBeNull();

    // Matching documents against the answer was dropped (unreliable across languages,
    // paraphrase and HTML); no document carries a quoted mark.
    expect(t1.retrieval.documents[0]).not.toHaveProperty('quotedInAnswer');

    // A price lookup and the model calls are not searches.
    expect(find(res.body.spans, 't3')).not.toHaveProperty('retrieval');
    expect(find(res.body.spans, 'l3')).not.toHaveProperty('retrieval');
  });

  it('serves a capture-off trace: tool spans get no view, a retrieval span still shows it searched', async () => {
    const { agent } = await authedAgent(app);
    const trace = ragTrace(false);
    trace.spans.push({ spanId: 'r1', name: 'vector_store', kind: 'retrieval', status: 'ok', startTime: at(600) } as never);
    const [traceId] = await ingest(agent, [trace]);

    const res = await agent.get(`/api/v1/traces/${traceId}`).expect(200);
    expect(find(res.body.spans, 't1')).not.toHaveProperty('retrieval');
    // outputCaptured: false is what keeps "not captured" from reading as "found nothing".
    expect(find(res.body.spans, 'r1').retrieval).toEqual({ detectedBy: 'kind', query: null, documents: [], documentCount: 0, outputCaptured: false });
  });
});

describe('search count in GET /api/v1/traces (issue #870)', () => {
  it('counts search steps per trace and says 0 for a run that never searched', async () => {
    const { agent } = await authedAgent(app);
    const [ragId, priceId] = await ingest(agent, [
      ragTrace(true),
      {
        name: 'price-only',
        spans: [{ spanId: 'p1', name: 'get_price', kind: 'tool', status: 'ok', startTime: at(0), input: { sku: 'PRO' }, output: { price: 120 } }],
      },
    ]);

    const res = await agent.get('/api/v1/traces').expect(200);
    const byId = Object.fromEntries(res.body.data.map((t: { id: string; searchCount: number }) => [t.id, t.searchCount]));
    expect(byId[ragId]).toBe(2);
    expect(byId[priceId]).toBe(0);
  });

  it('counts the same way in a content search (q=), which runs in a bounded transaction', async () => {
    const { agent } = await authedAgent(app);
    const [ragId] = await ingest(agent, [ragTrace(true)]);

    const res = await agent.get('/api/v1/traces').query({ q: 'Dana Ortiz' }).expect(200);
    expect(res.body.data.map((t: { id: string; searchCount: number }) => [t.id, t.searchCount])).toEqual([[ragId, 2]]);
  });

  it('counts a search whose output is over 1 MB, as the detail view does', async () => {
    const { agent } = await authedAgent(app);
    const docs = Array.from({ length: 600 }, (_, i) => ({ id: `d${i}`, text: noise(2_000, i + 1) }));
    const [traceId] = await ingest(agent, [
      {
        name: 'big-search',
        spans: [
          { spanId: 'b1', name: 'search_docs', kind: 'tool', status: 'ok', startTime: at(0), input: { query: 'q' }, output: docs },
          { spanId: 'b2', name: 'search_docs', kind: 'tool', status: 'ok', startTime: at(100), input: { query: 'q' }, output: { matches: docs } },
        ],
      },
    ]);
    const stored = await prisma.$queryRaw<{ bytes: number }[]>`SELECT max(pg_column_size(output))::int AS bytes FROM span_payloads`;
    expect(stored[0].bytes).toBeGreaterThan(1_048_576);

    const detail = await agent.get(`/api/v1/traces/${traceId}`).expect(200);
    expect(find(detail.body.spans, 'b1').retrieval?.documentCount).toBe(600);
    const list = await agent.get('/api/v1/traces').expect(200);
    expect(list.body.data.find((t: { id: string }) => t.id === traceId).searchCount).toBe(2);
  });
});

describe('the SDK toolKind marker (issue #870, layer 3)', () => {
  it('forces a search on a string-returning tool and turns detection off on a marked plain tool, in detail and list', async () => {
    const { agent } = await authedAgent(app);
    const [traceId] = await ingest(agent, [
      {
        name: 'marked-tools',
        spans: [
          {
            spanId: 'm1', name: 'search_kb', kind: 'tool', status: 'ok', startTime: at(0),
            input: { query: 'refund window' }, output: 'Doc 1: Refunds take 5 days.\n\nDoc 2: Express is 2 days.',
            attributes: { toolKind: 'retrieval' },
          },
          {
            spanId: 'm2', name: 'list_products', kind: 'tool', status: 'ok', startTime: at(100),
            input: { category: 'chairs' }, output: [{ text: 'Aeron Chair, mesh back' }, { text: 'Leap Chair' }],
            attributes: { toolKind: 'tool' },
          },
        ],
      },
    ]);

    const detail = await agent.get(`/api/v1/traces/${traceId}`).expect(200);
    expect(find(detail.body.spans, 'm1').retrieval).toMatchObject({
      detectedBy: 'marker',
      query: 'refund window',
      documentCount: 2,
      documents: [
        { id: null, text: 'Doc 1: Refunds take 5 days.' },
        { id: null, text: 'Doc 2: Express is 2 days.' },
      ],
    });
    expect(find(detail.body.spans, 'm2')).not.toHaveProperty('retrieval');

    const list = await agent.get('/api/v1/traces').expect(200);
    expect(list.body.data.find((t: { id: string }) => t.id === traceId).searchCount).toBe(1);
  });
});
