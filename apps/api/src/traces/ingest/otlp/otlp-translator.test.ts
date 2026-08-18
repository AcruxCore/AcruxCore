import { translateResourceSpans } from './otlp-translator';
import type { RawResourceSpans } from './otlp.types';

function kv(key: string, value: unknown): { key: string; value: any } {
  if (typeof value === 'string') return { key, value: { stringValue: value } };
  if (typeof value === 'number') return { key, value: { intValue: String(value) } };
  return { key, value: { stringValue: String(value) } };
}

describe('translateResourceSpans', () => {
  it('maps an OpenInference LLM span into an IngestTrace with computed cost', () => {
    const traceIdHex = 'a'.repeat(32);
    const input: RawResourceSpans[] = [
      {
        resourceAttributes: [],
        spans: [
          {
            traceId: traceIdHex,
            spanId: 'b'.repeat(16),
            name: 'ChatOpenAI',
            startTimeUnixNano: '1700000000000000000',
            endTimeUnixNano: '1700000000500000000',
            status: { code: 1 },
            attributes: [
              kv('openinference.span.kind', 'LLM'),
              kv('llm.model_name', 'gpt-4o-mini'),
              kv('llm.token_count.prompt', 100),
              kv('llm.token_count.completion', 20),
              kv('llm.token_count.total', 120),
              kv('input.value', '{"role":"user"}'),
              kv('output.value', 'hello'),
            ],
          },
        ],
      },
    ];

    const traces = translateResourceSpans(input);

    expect(traces).toHaveLength(1);
    expect(traces[0].traceId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(traces[0].spans).toHaveLength(1);
    const span = traces[0].spans[0];
    expect(span.spanId).toBe('b'.repeat(16));
    expect(span.kind).toBe('llm');
    expect(span.model).toBe('gpt-4o-mini');
    expect(span.usage).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120 });
    expect(span.costUsd).toBeCloseTo((100 / 1e6) * 0.15 + (20 / 1e6) * 0.6, 9);
    expect(span.status).toBe('ok');
    expect(span.startTime).toBe('2023-11-14T22:13:20.000Z');
    expect(span.endTime).toBe('2023-11-14T22:13:20.500Z');
    expect(span.input).toBe('{"role":"user"}');
    expect(span.output).toBe('hello');
  });

  it('keeps payload-bearing attributes out of `attributes` while still promoting them to input/output', () => {
    const traces = translateResourceSpans([
      {
        resourceAttributes: [],
        spans: [
          {
            traceId: '7'.repeat(32),
            spanId: '8'.repeat(16),
            name: 'ChatOpenAI',
            startTimeUnixNano: '1700000000000000000',
            attributes: [
              kv('openinference.span.kind', 'LLM'),
              kv('input.value', 'secret prompt text'),
              kv('output.value', 'secret completion text'),
              kv('llm.input_messages.0.message.content', 'secret user turn'),
              kv('llm.output_messages.0.message.content', 'secret assistant turn'),
              kv('retrieval.documents.0.document.content', 'secret retrieved chunk'),
              kv('llm.model_name', 'gpt-4o-mini'),
            ],
          },
        ],
      },
    ]);

    const span = traces[0].spans[0];
    // Promoted through the redacted, capture-gated channel …
    expect(span.input).toBe('secret prompt text');
    expect(span.output).toBe('secret completion text');
    // … and absent from the unredacted, always-persisted attributes column.
    expect(span.attributes).toEqual({
      'openinference.span.kind': 'LLM',
      'llm.model_name': 'gpt-4o-mini',
    });
  });

  it('reassembles retrieval.documents.* attributes into span.output on a RETRIEVER span, and strips them from attributes', () => {
    const traces = translateResourceSpans([
      {
        resourceAttributes: [],
        spans: [
          {
            traceId: 'd'.repeat(32),
            spanId: 'e'.repeat(16),
            name: 'vector-search',
            startTimeUnixNano: '1700000000000000000',
            attributes: [
              kv('openinference.span.kind', 'RETRIEVER'),
              kv('input.value', 'what is the refund policy?'),
              kv('retrieval.documents.0.document.content', 'doc one text'),
              kv('retrieval.documents.0.document.score', 0.9),
              kv('retrieval.documents.1.document.content', 'doc two text'),
              kv('retrieval.documents.1.document.score', 0.7),
            ],
          },
        ],
      },
    ]);

    const span = traces[0].spans[0];
    expect(span.input).toBe('what is the refund policy?');
    expect(span.output).toEqual([
      { content: 'doc one text', score: 0.9 },
      { content: 'doc two text', score: 0.7 },
    ]);
    for (const key of Object.keys(span.attributes ?? {})) {
      expect(key.startsWith('retrieval.documents.')).toBe(false);
    }
  });

  it('does not choke on an empty arrayValue / kvlistValue attribute', () => {
    const traces = translateResourceSpans([
      {
        resourceAttributes: [],
        spans: [
          {
            traceId: '9'.repeat(32),
            spanId: 'a'.repeat(16),
            name: 'agent-with-no-tool-calls',
            startTimeUnixNano: '1700000000000000000',
            attributes: [
              kv('openinference.span.kind', 'AGENT'),
              // protobufjs omits an empty repeated field, so a real empty list
              // attribute decodes with no `values` key at all.
              { key: 'tags', value: { arrayValue: {} } },
              { key: 'metadata', value: { kvlistValue: {} } },
            ],
          },
        ],
      },
    ]);

    const span = traces[0].spans[0];
    expect(span.attributes!.tags).toEqual([]);
    expect(span.attributes!.metadata).toEqual({});
  });

  it('treats a decoded UNSET status (`{}` — proto3 omits the zero value) as "unset"', () => {
    const traces = translateResourceSpans([
      {
        resourceAttributes: [],
        spans: [
          {
            traceId: 'b'.repeat(32),
            spanId: 'c'.repeat(16),
            name: 'still-running',
            startTimeUnixNano: '1700000000000000000',
            status: {},
            attributes: [kv('openinference.span.kind', 'CHAIN')],
          },
        ],
      },
    ]);
    expect(traces[0].spans[0].status).toBe('unset');
  });

  it('maps span kinds RERANKER/GUARDRAIL/EVALUATOR/PROMPT/UNKNOWN to "other"', () => {
    const unknownKinds = ['RERANKER', 'GUARDRAIL', 'EVALUATOR', 'PROMPT', 'UNKNOWN', 'SOMETHING_NEW'];
    for (const kind of unknownKinds) {
      const traces = translateResourceSpans([
        {
          resourceAttributes: [],
          spans: [
            {
              traceId: 'c'.repeat(32),
              spanId: 'd'.repeat(16),
              name: 'x',
              startTimeUnixNano: '1700000000000000000',
              attributes: [kv('openinference.span.kind', kind)],
            },
          ],
        },
      ]);
      expect(traces[0].spans[0].kind).toBe('other');
    }
  });

  it('falls back to a generic "other" span, preserving all raw attributes, for a non-OpenInference span', () => {
    const traces = translateResourceSpans([
      {
        resourceAttributes: [],
        spans: [
          {
            traceId: 'e'.repeat(32),
            spanId: 'f'.repeat(16),
            name: 'some.unmapped.span',
            startTimeUnixNano: '1700000000000000000',
            attributes: [kv('gen_ai.system', 'openai'), kv('custom.thing', 'value')],
          },
        ],
      },
    ]);

    const span = traces[0].spans[0];
    expect(span.kind).toBe('other');
    expect(span.model).toBeUndefined();
    expect(span.attributes).toEqual({ 'gen_ai.system': 'openai', 'custom.thing': 'value' });
  });

  it('groups two spans sharing a trace id into one IngestTrace with a parent link', () => {
    const traceIdHex = '1'.repeat(32);
    const traces = translateResourceSpans([
      {
        resourceAttributes: [],
        spans: [
          {
            traceId: traceIdHex, spanId: 'aa'.repeat(4), name: 'root',
            startTimeUnixNano: '1700000000000000000',
            attributes: [kv('openinference.span.kind', 'AGENT')],
          },
          {
            traceId: traceIdHex, spanId: 'bb'.repeat(4), parentSpanId: 'aa'.repeat(4), name: 'tool-call',
            startTimeUnixNano: '1700000000100000000',
            attributes: [kv('openinference.span.kind', 'TOOL')],
          },
        ],
      },
    ]);

    expect(traces).toHaveLength(1);
    expect(traces[0].spans).toHaveLength(2);
    // Insertion order is preserved (Map iteration order): spans[0] is the root
    // (pushed first), spans[1] is the tool-call child.
    expect(traces[0].spans[0].spanId).toBe('aa'.repeat(4));
    expect(traces[0].spans[1].spanId).toBe('bb'.repeat(4));
    expect(traces[0].spans[1].parentSpanId).toBe('aa'.repeat(4));
  });

  it('reads sessionId from an OpenInference session.id attribute on any span in the trace', () => {
    const traces = translateResourceSpans([
      {
        resourceAttributes: [],
        spans: [
          {
            traceId: '2'.repeat(32), spanId: 'aa'.repeat(4), name: 'root',
            startTimeUnixNano: '1700000000000000000',
            attributes: [kv('openinference.span.kind', 'AGENT'), kv('session.id', 'sess-123')],
          },
        ],
      },
    ]);
    expect(traces[0].sessionId).toBe('sess-123');
  });
});
