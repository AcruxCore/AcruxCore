import prisma from '../../../../apps/api/src/shared/db/client';
import { resetAuthTables } from '../../../../apps/api/src/test-utils/reset-db';
import {
  callTool,
  callToolExpectingError,
  payloadOf,
  rest,
  startHarness,
  type Harness,
} from './harness';

let harness: Harness;

beforeEach(async () => {
  await resetAuthTables();
  harness = await startHarness();
});

afterEach(async () => {
  await harness?.close();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Ingests one trace with an llm span and a child tool span, and returns its id. */
async function seedTrace(name: string, sessionId: string): Promise<string> {
  const result = await rest<{ traceIds: string[] }>(harness, 'POST', '/traces', {
    traces: [
      {
        name,
        sessionId,
        spans: [
          {
            spanId: 's1',
            name: 'gpt-4o-mini',
            kind: 'llm',
            status: 'ok',
            startTime: '2026-09-01T10:00:00Z',
            endTime: '2026-09-01T10:00:01.200Z',
            model: 'gpt-4o-mini',
            provider: 'openai',
            usage: { promptTokens: 120, completionTokens: 40, totalTokens: 160 },
            costUsd: 0.0000234,
          },
          {
            spanId: 's2',
            parentSpanId: 's1',
            name: 'search_docs',
            kind: 'tool',
            status: 'ok',
            startTime: '2026-09-01T10:00:00.100Z',
            endTime: '2026-09-01T10:00:00.300Z',
          },
        ],
      },
    ],
  });
  return result.traceIds[0];
}

describe('the tool catalog over MCP', () => {
  it('creates a tool on first sync, commits nothing on a repeat, and commits on a real change', async () => {
    const client = harness.client;
    const spec = {
      name: 'get_weather',
      description: 'Get the current weather for a city.',
      parametersSchema: {
        type: 'object',
        properties: { city: { type: 'string', description: 'City name, e.g. Lahore.' } },
        required: ['city'],
      },
      executor: { type: 'client' as const },
    };

    const first = payloadOf<{ toolId: string; versionNumber: number; committed: boolean }>(
      await callTool(client, 'sync_catalog_tool', spec),
    );
    expect(first.versionNumber).toBe(1);
    expect(first.committed).toBe(true);

    // Key order is not a change — the same spec written differently must be a no-op.
    const repeat = payloadOf<{ versionNumber: number; committed: boolean }>(
      await callTool(client, 'sync_catalog_tool', {
        ...spec,
        parametersSchema: {
          required: ['city'],
          properties: { city: { description: 'City name, e.g. Lahore.', type: 'string' } },
          type: 'object',
        },
      }),
    );
    expect(repeat.committed).toBe(false);
    expect(repeat.versionNumber).toBe(1);

    // The description is text the model reads, so changing it is a real change.
    const changed = payloadOf<{ versionNumber: number; committed: boolean }>(
      await callTool(client, 'sync_catalog_tool', {
        ...spec,
        description: 'Get the current weather, in Celsius, for a city.',
      }),
    );
    expect(changed.committed).toBe(true);
    expect(changed.versionNumber).toBe(2);

    const detail = payloadOf<{ tool: { name: string }; versions: unknown[]; aliases: unknown[] }>(
      await callTool(client, 'get_catalog_tool', { tool: 'get_weather' }),
    );
    expect(detail.tool.name).toBe('get_weather');
    expect(detail.versions).toHaveLength(2);

    const listed = await callTool(client, 'list_catalog_tools');
    expect(listed).toContain('Showing 1 of 1 catalog tools');
  });

  it('never claims a version was written from code — that flag belongs to the decorators', async () => {
    await callTool(harness.client, 'sync_catalog_tool', {
      name: 'ping_tool',
      parametersSchema: { type: 'object', properties: {} },
      executor: { type: 'client' },
    });

    const version = await prisma.toolVersion.findFirst({
      where: { tool: { name: 'ping_tool' } },
    });
    // `code` drives the dashboard's "a deploy will overwrite this" warning, and an MCP
    // call is not a decorated function in anyone's source file.
    expect(version?.source).toBe('api');
  });

  it('explains that a definition-only tool has nothing to execute', async () => {
    await callTool(harness.client, 'sync_catalog_tool', {
      name: 'client_side_tool',
      parametersSchema: { type: 'object', properties: {} },
      executor: { type: 'client' },
    });

    const error = await callToolExpectingError(harness.client, 'execute_catalog_tool', {
      tool: 'client_side_tool',
      arguments: {},
    });
    expect(error).toContain('NOT_EXECUTABLE');
  });
});

describe('observability over MCP', () => {
  it('finds a trace, opens it, and can drop the payloads on the way out', async () => {
    const traceId = await seedTrace('support-run', 'session-alpha');

    const found = payloadOf<{ data: Array<{ id: string; name: string; spanCount: number }> }>(
      await callTool(harness.client, 'search_traces', { q: 'support-run' }),
    );
    expect(found.data[0].id).toBe(traceId);
    expect(found.data[0].spanCount).toBe(2);

    const opened = payloadOf<{
      trace: { name: string; totalTokens: number };
      spans: Array<{ spanId: string; children?: unknown[] }>;
    }>(await callTool(harness.client, 'get_trace', { trace_id: traceId }));

    expect(opened.trace.name).toBe('support-run');
    expect(opened.trace.totalTokens).toBe(160);
    // The tool span is nested under the llm span, not flattened alongside it.
    expect(opened.spans).toHaveLength(1);
    expect(opened.spans[0].children).toHaveLength(1);

    const withoutPayloads = await callTool(harness.client, 'get_trace', {
      trace_id: traceId,
      include_payloads: false,
    });
    expect(withoutPayloads).not.toContain('"payload": {');
  });

  it('filters traces by status and model', async () => {
    await seedTrace('ok-run', 'session-alpha');

    const byModel = payloadOf<{ data: unknown[] }>(
      await callTool(harness.client, 'search_traces', { model: 'gpt-4o-mini' }),
    );
    expect(byModel.data).toHaveLength(1);

    const wrongModel = await callTool(harness.client, 'search_traces', { model: 'claude-3' });
    expect(wrongModel).toContain('No traces found.');
  });

  it('aggregates spans into buckets', async () => {
    await seedTrace('run-one', 'session-alpha');
    await seedTrace('run-two', 'session-beta');

    const analytics = payloadOf<{
      totals: { requests: number; costUsd: number };
      buckets: Array<{ key: string }>;
    }>(
      await callTool(harness.client, 'get_trace_analytics', {
        from: '2026-08-01',
        to: '2026-10-01',
        group_by: 'model',
        kind: 'llm',
      }),
    );

    expect(analytics.totals.requests).toBe(2);
    expect(analytics.buckets.map((b) => b.key)).toEqual(['gpt-4o-mini']);
  });

  it('lists sessions and opens one', async () => {
    await seedTrace('run-one', 'session-alpha');
    await seedTrace('run-two', 'session-alpha');

    const sessions = await callTool(harness.client, 'list_sessions', {
      from: '2026-08-01',
      to: '2026-10-01',
    });
    expect(sessions).toContain('sessions');

    const detail = payloadOf<{ traces: unknown[] }>(
      await callTool(harness.client, 'get_session', { session_id: 'session-alpha' }),
    );
    expect(detail.traces).toHaveLength(2);
  });

  it('records feedback against a trace, and the row lands in the database', async () => {
    const traceId = await seedTrace('support-run', 'session-alpha');

    await callTool(harness.client, 'submit_trace_feedback', {
      trace_id: traceId,
      rating: -1,
      label: 'wrong_answer',
      comment: 'Missed the relevant docs.',
      source: 'end_user',
    });

    const row = await prisma.traceFeedback.findFirst({ where: { traceId } });
    expect(row?.label).toBe('wrong_answer');
    expect(row?.rating).toBe(-1);
  });
});

describe('gateway read tools over MCP', () => {
  it('reports an empty model registry rather than failing', async () => {
    const text = await callTool(harness.client, 'list_models');
    expect(text).toContain('0 registered model(s)');
  });

  it('accepts a zero-argument tool called with no arguments at all', async () => {
    // `arguments` is optional in the protocol. A declared-but-empty input schema would
    // make this legal call fail validation, so zero-argument tools declare none.
    const result = await harness.client.callTool({ name: 'list_models' });
    expect(result.isError).toBeFalsy();
  });

  it('reports zero spend for a team that has made no calls', async () => {
    const usage = payloadOf<{ totals: { requests: number; costUsd: number } }>(
      await callTool(harness.client, 'get_gateway_usage', { group_by: 'model' }),
    );
    expect(usage.totals.requests).toBe(0);
  });
});

describe('evaluations over MCP', () => {
  it('creates a dataset, adds examples, and reads them back', async () => {
    const client = harness.client;

    const dataset = payloadOf<{ id: string; name: string }>(
      await callTool(client, 'create_dataset', {
        name: 'manual-review-set',
        overall_feedback: 'Keep responses concise and polite',
      }),
    );
    expect(dataset.name).toBe('manual-review-set');

    await callTool(client, 'add_dataset_example', {
      dataset_id: dataset.id,
      input: { name: 'Bob' },
      criteria: 'Say hi politely, third person',
    });
    await callTool(client, 'add_dataset_example', {
      dataset_id: dataset.id,
      input: { question: 'What about Germany?' },
      criteria: 'Answer in one sentence.',
      history: [
        { role: 'user', content: 'What is the capital of France?' },
        { role: 'assistant', content: 'Paris.' },
      ],
    });

    const detail = payloadOf<{ examples: Array<{ criteria: string }> }>(
      await callTool(client, 'get_dataset', { dataset_id: dataset.id }),
    );
    expect(detail.examples).toHaveLength(2);

    const listed = await callTool(client, 'list_datasets');
    expect(listed).toContain('Showing 1 of 1 datasets');
  });

  it('reports an empty run history without pretending a run scored zero', async () => {
    const text = await callTool(harness.client, 'list_experiment_runs');
    expect(text).toContain('No runs found.');
  });
});
