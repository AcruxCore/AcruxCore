import { translateResourceSpans } from './otlp-translator';
import type { RawResourceSpans } from './otlp.types';

function kv(key: string, value: unknown): { key: string; value: any } {
  if (typeof value === 'string') return { key, value: { stringValue: value } };
  if (typeof value === 'number') return { key, value: { intValue: String(value) } };
  return { key, value: { stringValue: String(value) } };
}

describe('translateResourceSpans', () => {
  it('maps an OpenInference LLM span into an IngestTrace, leaving cost to ingest', () => {
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
    // Priced later by `SpanPricer`, where the team's own model prices are known.
    expect(span.costUsd).toBeUndefined();
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

  it('names the trace after its root span, trimming a trailing run id (issue #362)', () => {
    // Every OTLP trace used to fall through to the timestamp fallback because the
    // translator never set a name — so the trace list read as a wall of near-identical
    // timestamps for exactly the users who wrote no AcruxCore code. The uuid suffix is
    // trimmed so two runs of the same crew share a searchable name.
    const traceIdHex = '3'.repeat(32);
    const traces = translateResourceSpans([
      {
        resourceAttributes: [],
        spans: [
          {
            traceId: traceIdHex, spanId: 'aa'.repeat(4),
            name: 'Crew_5f1fcf48-de64-42cf-b927-5c060836053',
            startTimeUnixNano: '1700000000000000000',
            attributes: [kv('openinference.span.kind', 'CHAIN')],
          },
          {
            traceId: traceIdHex, spanId: 'bb'.repeat(4), parentSpanId: 'aa'.repeat(4),
            name: 'Haiku Writer._execute_core',
            startTimeUnixNano: '1700000000100000000',
            attributes: [kv('openinference.span.kind', 'AGENT')],
          },
        ],
      },
    ]);
    expect(traces[0].name).toBe('Crew');
  });

  it('trims a run id embedded mid-name, not only a trailing one (issue #362)', () => {
    // The shape CrewAI actually emits is `Crew_<uuid>.kickoff` — the run id sits in the
    // middle, so an end-anchored trim never fired and every trace still got a unique
    // name, which is the exact problem #362 set out to remove. Captured from a real
    // `crewai` 1.15 export against a local gateway.
    const traceIdHex = '4'.repeat(32);
    const traces = translateResourceSpans([
      {
        resourceAttributes: [],
        spans: [
          {
            traceId: traceIdHex, spanId: 'aa'.repeat(4),
            name: 'Crew_cb0ce46d-b1a1-4a6c-bb61-93f6fbc2b95a.kickoff',
            startTimeUnixNano: '1700000000000000000',
            attributes: [kv('openinference.span.kind', 'CHAIN')],
          },
        ],
      },
    ]);
    expect(traces[0].name).toBe('Crew.kickoff');
  });

  it('sets no name from a batch of orphans, because an orphan is usually a leaf', () => {
    // OTLP flushes leaves before their still-open parents, so a span whose parent is
    // merely absent from this batch is almost always a child of a root that arrived
    // earlier or has not arrived yet. Naming the run after it would name the run after
    // one of its leaves; the timestamp fallback stands until the real root turns up.
    const traces = translateResourceSpans([
      {
        resourceAttributes: [],
        spans: [
          {
            traceId: '4'.repeat(32), spanId: 'bb'.repeat(4), parentSpanId: 'not-in-this-batch',
            name: 'tool-call',
            startTimeUnixNano: '1700000000100000000',
            attributes: [kv('openinference.span.kind', 'TOOL')],
          },
        ],
      },
    ]);
    expect(traces[0].name).toBeUndefined();
  });

  it('picks the earliest root when a batch holds several, since a run starts first', () => {
    const traceIdHex = '5'.repeat(32);
    const traces = translateResourceSpans([
      {
        resourceAttributes: [],
        spans: [
          {
            traceId: traceIdHex, spanId: 'bb'.repeat(4), name: 'later-orphan',
            startTimeUnixNano: '1700000000500000000',
            attributes: [kv('openinference.span.kind', 'TOOL')],
          },
          {
            traceId: traceIdHex, spanId: 'aa'.repeat(4), name: 'the-run',
            startTimeUnixNano: '1700000000000000000',
            attributes: [kv('openinference.span.kind', 'CHAIN')],
          },
        ],
      },
    ]);
    expect(traces[0].name).toBe('the-run');
  });

  it('sets no name when trimming leaves nothing, so the timestamp fallback still applies', () => {
    const traces = translateResourceSpans([
      {
        resourceAttributes: [],
        spans: [
          {
            traceId: '6'.repeat(32), spanId: 'aa'.repeat(4),
            name: '5f1fcf48-de64-42cf-b927-5c060836053a',
            startTimeUnixNano: '1700000000000000000',
            attributes: [kv('openinference.span.kind', 'CHAIN')],
          },
        ],
      },
    ]);
    expect(traces[0].name).toBeUndefined();
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

  describe('OpenTelemetry GenAI semantic conventions (gen_ai.*) — issue #757', () => {
    /** One span carrying only `gen_ai.*` keys, translated on its own. */
    function genAiSpan(attributes: ReturnType<typeof kv>[], name = 'chat gpt-4o-mini') {
      return translateResourceSpans([
        {
          resourceAttributes: [],
          spans: [
            {
              traceId: '9'.repeat(32),
              spanId: '1'.repeat(16),
              name,
              startTimeUnixNano: '1700000000000000000',
              attributes,
            },
          ],
        },
      ])[0];
    }

    it('maps a chat span to an llm span with model, provider and usage', () => {
      const span = genAiSpan([
        kv('gen_ai.operation.name', 'chat'),
        kv('gen_ai.provider.name', 'openai'),
        kv('gen_ai.request.model', 'gpt-4o-mini'),
        kv('gen_ai.response.model', 'gpt-4o-mini-2024-07-18'),
        kv('gen_ai.usage.input_tokens', 100),
        kv('gen_ai.usage.output_tokens', 20),
        kv('gen_ai.usage.cache_read.input_tokens', 40),
      ]).spans[0];

      expect(span.kind).toBe('llm');
      // The response model is the one that actually ran; the pricer strips the date suffix.
      expect(span.model).toBe('gpt-4o-mini-2024-07-18');
      expect(span.provider).toBe('openai');
      // No totalTokens here: IngestService derives it from prompt + completion for every path.
      expect(span.usage).toEqual({ promptTokens: 100, completionTokens: 20, cachedTokens: 40 });
    });

    it.each([
      ['chat', 'llm'],
      ['text_completion', 'llm'],
      ['generate_content', 'llm'],
      ['embeddings', 'embedding'],
      ['execute_tool', 'tool'],
      ['invoke_agent', 'agent'],
      ['create_agent', 'agent'],
      ['retrieval', 'retrieval'],
      ['some_future_operation', 'other'],
    ])('maps gen_ai.operation.name=%s to kind %s', (operation, kind) => {
      expect(genAiSpan([kv('gen_ai.operation.name', operation)]).spans[0].kind).toBe(kind);
    });

    it('falls back to the request model, the older gen_ai.system and the older token names', () => {
      const span = genAiSpan([
        kv('gen_ai.operation.name', 'chat'),
        kv('gen_ai.system', 'anthropic'),
        kv('gen_ai.request.model', 'claude-sonnet-4-5'),
        kv('gen_ai.usage.prompt_tokens', 7),
        kv('gen_ai.usage.completion_tokens', 3),
      ]).spans[0];

      expect(span.model).toBe('claude-sonnet-4-5');
      expect(span.provider).toBe('anthropic');
      expect(span.usage).toEqual({ promptTokens: 7, completionTokens: 3 });
    });

    it('moves message content out of attributes and into input/output', () => {
      const span = genAiSpan([
        kv('gen_ai.operation.name', 'chat'),
        kv('gen_ai.request.model', 'gpt-4o-mini'),
        kv('gen_ai.system_instructions', 'secret system prompt'),
        kv('gen_ai.input.messages', '[{"role":"user","parts":[{"type":"text","content":"secret question"}]}]'),
        kv('gen_ai.output.messages', '[{"role":"assistant","parts":[{"type":"text","content":"secret answer"}]}]'),
      ]).spans[0];

      expect(span.input).toEqual({
        system_instructions: 'secret system prompt',
        messages: '[{"role":"user","parts":[{"type":"text","content":"secret question"}]}]',
      });
      expect(span.output).toBe('[{"role":"assistant","parts":[{"type":"text","content":"secret answer"}]}]');
      expect(JSON.stringify(span.attributes)).not.toContain('secret');
      expect(span.attributes).toEqual({ 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'gpt-4o-mini' });
    });

    it('reassembles the flattened gen_ai.prompt.N / gen_ai.completion.N keys (OpenLLMetry)', () => {
      const span = genAiSpan([
        kv('gen_ai.operation.name', 'chat'),
        kv('gen_ai.prompt.0.role', 'user'),
        kv('gen_ai.prompt.0.content', 'secret question'),
        kv('gen_ai.completion.0.role', 'assistant'),
        kv('gen_ai.completion.0.content', 'secret answer'),
      ]).spans[0];

      expect(span.input).toEqual([{ role: 'user', content: 'secret question' }]);
      expect(span.output).toEqual([{ role: 'assistant', content: 'secret answer' }]);
      expect(JSON.stringify(span.attributes)).not.toContain('secret');
    });

    it('moves tool-call arguments and result into input/output on an execute_tool span', () => {
      const span = genAiSpan([
        kv('gen_ai.operation.name', 'execute_tool'),
        kv('gen_ai.tool.name', 'get_weather'),
        kv('gen_ai.tool.call.arguments', '{"city":"Rome"}'),
        kv('gen_ai.tool.call.result', '{"temp":21}'),
      ], 'execute_tool get_weather').spans[0];

      expect(span.kind).toBe('tool');
      expect(span.input).toBe('{"city":"Rome"}');
      expect(span.output).toBe('{"temp":21}');
      expect(span.attributes).toEqual({ 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'get_weather' });
    });

    it('reads the session id from gen_ai.conversation.id', () => {
      expect(genAiSpan([kv('gen_ai.operation.name', 'chat'), kv('gen_ai.conversation.id', 'conv-42')]).sessionId).toBe(
        'conv-42',
      );
    });

    // ---- Review follow-ups on PR #772 ----

    it('maps gen_ai.operation.name=invoke_workflow to kind chain', () => {
      expect(genAiSpan([kv('gen_ai.operation.name', 'invoke_workflow')]).spans[0].kind).toBe('chain');
    });

    it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
      'maps an operation name that is an Object.prototype member (%s) to "other", not a function',
      (operation) => {
        expect(genAiSpan([kv('gen_ai.operation.name', operation)]).spans[0].kind).toBe('other');
      },
    );

    it.each(['constructor', 'toString'])(
      'maps an OpenInference kind that is an Object.prototype member (%s) to "other"',
      (kindRaw) => {
        expect(genAiSpan([kv('openinference.span.kind', kindRaw)]).spans[0].kind).toBe('other');
      },
    );

    it('reads no usage on an invoke_agent span, so it is not counted on top of its child llm spans', () => {
      const span = genAiSpan([
        kv('gen_ai.operation.name', 'invoke_agent'),
        kv('gen_ai.request.model', 'gpt-4o-mini'),
        kv('gen_ai.usage.input_tokens', 300),
        kv('gen_ai.usage.output_tokens', 50),
      ]).spans[0];
      expect(span.kind).toBe('agent');
      expect(span.usage).toBeUndefined();
      // The aggregate counts are not thrown away: they stay visible as attributes.
      expect(span.attributes).toMatchObject({ 'gen_ai.usage.input_tokens': 300, 'gen_ai.usage.output_tokens': 50 });
    });

    it('gives an embeddings span with only input tokens a zero completion count, so it can be priced', () => {
      const span = genAiSpan([
        kv('gen_ai.operation.name', 'embeddings'),
        kv('gen_ai.request.model', 'text-embedding-3-small'),
        kv('gen_ai.usage.input_tokens', 50),
      ]).spans[0];
      expect(span.usage).toEqual({ promptTokens: 50, completionTokens: 0 });
    });

    it("reads OpenLLMetry's underscore cache-read name, gen_ai.usage.cache_read_input_tokens", () => {
      const span = genAiSpan([
        kv('gen_ai.operation.name', 'chat'),
        kv('gen_ai.usage.input_tokens', 100),
        kv('gen_ai.usage.output_tokens', 5),
        kv('gen_ai.usage.cache_read_input_tokens', 80),
      ]).spans[0];
      expect(span.usage?.cachedTokens).toBe(80);
    });

    it('caps a cache-read count above the prompt count, as the native path does, instead of dropping it', () => {
      const span = genAiSpan([
        kv('gen_ai.operation.name', 'chat'),
        kv('gen_ai.usage.input_tokens', 20),
        kv('gen_ai.usage.output_tokens', 5),
        kv('gen_ai.usage.cache_read.input_tokens', 80),
      ]).spans[0];
      expect(span.usage?.cachedTokens).toBe(20);
    });

    it('ignores token counts that are not non-negative integers', () => {
      const span = genAiSpan([
        kv('gen_ai.operation.name', 'chat'),
        { key: 'gen_ai.usage.input_tokens', value: { doubleValue: 12.5 } },
        kv('gen_ai.usage.output_tokens', -4),
      ]).spans[0];
      expect(span.usage).toBeUndefined();
    });

    it('moves the retrieval query and documents out of attributes into input/output', () => {
      const span = genAiSpan([
        kv('gen_ai.operation.name', 'retrieval'),
        kv('gen_ai.data_source.id', 'kb-1'),
        kv('gen_ai.retrieval.query.text', 'my secret question'),
        kv('gen_ai.retrieval.documents', '[{"content":"secret doc"}]'),
      ]).spans[0];
      expect(span.input).toBe('my secret question');
      expect(span.output).toBe('[{"content":"secret doc"}]');
      expect(JSON.stringify(span.attributes)).not.toContain('secret');
    });

    it('keeps gen_ai.prompt.name in attributes, since it names a template and is not an indexed message', () => {
      const span = genAiSpan([kv('gen_ai.operation.name', 'chat'), kv('gen_ai.prompt.name', 'analyze-code')]).spans[0];
      expect(span.attributes).toEqual({ 'gen_ai.operation.name': 'chat', 'gen_ai.prompt.name': 'analyze-code' });
    });

    it('keeps every content source when a span carries more than one, instead of dropping all but the first', () => {
      const span = genAiSpan([
        kv('gen_ai.operation.name', 'chat'),
        kv('gen_ai.prompt', 'legacy'),
        kv('gen_ai.prompt.0.content', 'flattened'),
      ]).spans[0];
      expect(span.input).toEqual({ 'gen_ai.prompt': 'legacy', 'gen_ai.prompt.*': [{ content: 'flattened' }] });
    });

    it('keeps gen_ai content and usage on a span that also carries an OpenInference kind', () => {
      const span = genAiSpan([
        kv('openinference.span.kind', 'LLM'),
        kv('gen_ai.request.model', 'gpt-4o-mini'),
        kv('gen_ai.usage.input_tokens', 10),
        kv('gen_ai.usage.output_tokens', 2),
        kv('gen_ai.prompt.0.content', 'hello'),
        kv('gen_ai.completion.0.content', 'bye'),
      ]).spans[0];
      expect(span.kind).toBe('llm');
      expect(span.input).toEqual([{ content: 'hello' }]);
      expect(span.output).toEqual([{ content: 'bye' }]);
      expect(span.usage).toEqual({ promptTokens: 10, completionTokens: 2 });
    });

    it("moves OpenLLMetry's traceloop.entity.input/output out of attributes", () => {
      const span = genAiSpan([
        kv('traceloop.span.kind', 'workflow'),
        kv('traceloop.entity.input', 'secret in'),
        kv('traceloop.entity.output', 'secret out'),
      ]).spans[0];
      expect(span.input).toBe('secret in');
      expect(span.output).toBe('secret out');
      expect(JSON.stringify(span.attributes)).not.toContain('secret');
    });

    it('lets the OpenInference kind win when a span carries both vocabularies', () => {
      const span = genAiSpan([
        kv('openinference.span.kind', 'CHAIN'),
        kv('gen_ai.operation.name', 'chat'),
      ]).spans[0];
      expect(span.kind).toBe('chain');
    });
  });

  // Attribute shapes copied from a real google-adk 2.13.0 run with
  // ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN=1 against gemini-3.8-flash, and from the
  // google-adk 1.0.0 source for the oldest tool span names.
  describe('Google ADK legacy spans (gen_ai.system=gcp.vertex.agent) — issue #773', () => {
    function adkSpan(attributes: ReturnType<typeof kv>[], name: string) {
      return translateResourceSpans([
        {
          resourceAttributes: [],
          spans: [
            {
              traceId: '7'.repeat(32),
              spanId: '3'.repeat(16),
              name,
              startTimeUnixNano: '1700000000000000000',
              attributes,
            },
          ],
        },
      ])[0].spans[0];
    }

    const llmRequest =
      '{"model": "gemini-3.8-flash", "contents": [{"parts": [{"text": "What is the weather in Lahore?"}], "role": "user"}]}';
    const llmResponse =
      '{"model_version":"gemini-3.8-flash","content":{"parts":[{"text":"Sunny, 24C."}],"role":"model"}}';

    it('maps call_llm to an llm span with the model, a real provider and its content', () => {
      const span = adkSpan(
        [
          kv('gen_ai.system', 'gcp.vertex.agent'),
          kv('gen_ai.request.model', 'gemini-3.8-flash'),
          kv('gcp.vertex.agent.invocation_id', 'e-1'),
          kv('gcp.vertex.agent.session_id', 'sess-1'),
          kv('gcp.vertex.agent.event_id', 'ev-1'),
          kv('gcp.vertex.agent.llm_request', llmRequest),
          kv('gcp.vertex.agent.llm_response', llmResponse),
          kv('gen_ai.usage.input_tokens', 93),
          kv('gen_ai.usage.output_tokens', 47),
        ],
        'call_llm',
      );
      expect(span.kind).toBe('llm');
      expect(span.model).toBe('gemini-3.8-flash');
      expect(span.provider).toBe('gemini');
      expect(span.input).toBe(llmRequest);
      expect(span.output).toBe(llmResponse);
      expect(Object.keys(span.attributes ?? {})).not.toContain('gcp.vertex.agent.llm_request');
      expect(Object.keys(span.attributes ?? {})).not.toContain('gcp.vertex.agent.llm_response');
      expect(span.attributes).toMatchObject({ 'gcp.vertex.agent.event_id': 'ev-1' });
    });

    it('reads no usage on call_llm, since its generate_content child already carries the same counts', () => {
      const span = adkSpan(
        [
          kv('gen_ai.system', 'gcp.vertex.agent'),
          kv('gen_ai.request.model', 'gemini-3.8-flash'),
          kv('gen_ai.usage.input_tokens', 93),
          kv('gen_ai.usage.output_tokens', 47),
        ],
        'call_llm',
      );
      expect(span.usage).toBeUndefined();
      // The counts stay visible in attributes.
      expect(span.attributes).toMatchObject({ 'gen_ai.usage.input_tokens': 93, 'gen_ai.usage.output_tokens': 47 });
    });

    it('moves the ADK tool content out of attributes and ignores the "{}" placeholders', () => {
      const span = adkSpan(
        [
          kv('gen_ai.operation.name', 'execute_tool'),
          kv('gen_ai.tool.name', 'get_weather'),
          kv('gcp.vertex.agent.llm_request', '{}'),
          kv('gcp.vertex.agent.llm_response', '{}'),
          kv('gcp.vertex.agent.tool_call_args', '{"city": "Lahore"}'),
          kv('gcp.vertex.agent.tool_response', '{"city": "Lahore", "forecast": "sunny, 24C"}'),
        ],
        'execute_tool get_weather',
      );
      expect(span.kind).toBe('tool');
      expect(span.input).toBe('{"city": "Lahore"}');
      expect(span.output).toBe('{"city": "Lahore", "forecast": "sunny, 24C"}');
      expect(JSON.stringify(span.attributes)).not.toContain('gcp.vertex.agent.tool');
      expect(JSON.stringify(span.attributes)).not.toContain('gcp.vertex.agent.llm_');
    });

    it.each(['execute_tool get_weather', 'tool_call [get_weather]', 'tool_response [get_weather]', 'tool_response'])(
      'maps an ADK tool span named %p with no operation name to kind tool',
      (name) => {
        const span = adkSpan(
          [kv('gen_ai.system', 'gcp.vertex.agent'), kv('gcp.vertex.agent.tool_call_args', '{"city": "Lahore"}')],
          name,
        );
        expect(span.kind).toBe('tool');
        expect(span.provider).toBeUndefined();
      },
    );

    it('moves the send_data content (gcp.vertex.agent.data) out of attributes', () => {
      const span = adkSpan(
        [kv('gcp.vertex.agent.event_id', 'ev-2'), kv('gcp.vertex.agent.data', '[{"parts":[{"text":"secret"}]}]')],
        'send_data',
      );
      expect(span.input).toBe('[{"parts":[{"text":"secret"}]}]');
      expect(JSON.stringify(span.attributes)).not.toContain('secret');
    });

    it('does not report gcp.vertex.agent as the provider when the model is unknown', () => {
      const span = adkSpan(
        [kv('gen_ai.system', 'gcp.vertex.agent'), kv('gen_ai.request.model', 'my-local-model')],
        'call_llm',
      );
      expect(span.kind).toBe('llm');
      expect(span.provider).toBeUndefined();
    });

    it('leaves other gcp.vertex.agent spans with no operation name as kind other', () => {
      const span = adkSpan([kv('gen_ai.system', 'gcp.vertex.agent')], 'handle_context_caching');
      expect(span.kind).toBe('other');
    });
  });
});
