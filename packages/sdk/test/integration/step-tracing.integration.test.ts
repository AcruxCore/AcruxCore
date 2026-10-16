import { createServer, type Server } from 'http';
import { acruxcore } from '../../src/client';
import prisma from '../../../../apps/api/src/shared/db/client';
import { signupTestUserWithApiKey } from '../../../../apps/api/src/test-utils/auth';
import type { IngestSpan, TraceSpan } from '../../src/types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createApp } = require('../../../../apps/api/app');

/**
 * Step tracing against the real `apps/api` app and Postgres (issue #612).
 *
 * `step-tracing.test.ts` proves what the SDK sends; this file proves the server stores
 * it. Each test reports a step tree, reads the trace back and checks every span arrived.
 * Only the BYO model provider is faked — the one outbound call to a paid third party.
 *
 * Several tests repeat a bug the Python SDK had on PR #613; two of them (marked) also
 * fail on the SDK released before this change, with no step involved.
 */

const app = createApp();
let api: Server;
let provider: Server;
let apiBase = '';
let providerBase = '';
let script: unknown[] = [];

function reply(toolCall = false) {
  return {
    id: 'c1',
    model: 'stub-model',
    choices: [{
      index: 0,
      finish_reason: toolCall ? 'tool_calls' : 'stop',
      message: toolCall
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }
        : { role: 'assistant', content: 'done' },
    }],
    usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
  };
}

const LOOKUP_DEF = {
  type: 'function' as const,
  function: { name: 'lookup', parameters: { type: 'object', properties: {} } },
};
const hi = [{ role: 'user' as const, content: 'hi' }];

beforeAll(async () => {
  api = createServer(app);
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
  apiBase = `http://127.0.0.1:${(api.address() as { port: number }).port}/api/v1`;
  provider = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(script.length ? script.shift() : reply()));
    });
  });
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', () => r()));
  providerBase = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((r) => api.close(() => r()));
  await new Promise<void>((r) => provider.close(() => r()));
  await prisma.$disconnect();
});

beforeEach(() => {
  script = [];
});

async function client(): Promise<acruxcore> {
  const { apiKey } = await signupTestUserWithApiKey(app);
  return new acruxcore({ apiKey, baseUrl: apiBase, maxRetries: 0, provider: { baseUrl: providerBase, apiKey: 'pk' } });
}

function flatten(spans: TraceSpan[]): TraceSpan[] {
  return spans.flatMap((s) => [s, ...flatten(s.children)]);
}

async function stored(hub: acruxcore, traceId: string): Promise<TraceSpan[]> {
  await hub.traces.flush();
  return flatten((await hub.traces.get(traceId)).spans);
}

describe('step tracing against the real API', () => {
  it('stores a step tree larger than one 200-span batch whole', async () => {
    const hub = await client();
    const traceId = hub.traces.step('agent', { kind: 'agent' }, (root) => {
      for (let n = 0; n < 250; n++) hub.traces.step(`tool-${n}`, { kind: 'tool' }, () => undefined);
      return root.traceId;
    });
    expect(await stored(hub, traceId)).toHaveLength(251);
    await hub.gateway.close();
  });

  it('honours a capturePayloads opt-out routed into a step', async () => {
    const hub = await client();
    const traceId = await hub.traces.step('handle', { input: { ticket: 'refund' } }, async (step) => {
      await hub.traces.ingest({
        traceId: step.traceId, capturePayloads: false,
        spans: [{ spanId: 'pii-1', parentSpanId: step.spanId, name: 'pii-lookup', kind: 'tool', status: 'ok',
          startTime: '2026-10-17T00:00:00Z', endTime: '2026-10-17T00:00:01Z', input: { ssn: '123-45-6789' } }],
      }, { wait: false });
      return step.traceId;
    });
    const spans = await stored(hub, traceId);
    const byName = Object.fromEntries(spans.map((s) => [s.name, s]));
    expect(JSON.stringify(byName['pii-lookup'].payload ?? null)).not.toContain('123-45-6789');
    // The opt-out covers the routed span only; the step keeps its own input.
    expect(byName.handle.payload?.input).toEqual({ ticket: 'refund' });
    await hub.gateway.close();
  });

  it('stores two BYO tool loops in one step', async () => {
    script = [reply(true), reply(), reply(true), reply()];
    const hub = await client();
    const traceId = await hub.traces.step('handle', async (step) => {
      for (let i = 0; i < 2; i++) {
        await hub.gateway.runToolLoop({
          model: 'stub-model', messages: hi, toolDefs: [LOOKUP_DEF], dispatch: () => 'ok', trace: { traceId: step.traceId },
        });
      }
      return step.traceId;
    });
    const kinds = (await stored(hub, traceId)).map((s) => s.kind);
    expect(kinds.filter((k) => k === 'tool')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'llm')).toHaveLength(4);
    await hub.gateway.close();
  });

  it('stores a nested step that ends after its root, and the call inside it', async () => {
    const hub = await client();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let background!: Promise<unknown>;
    const traceId = await hub.traces.step('root', { kind: 'agent' }, async (step) => {
      background = hub.traces.step('late-child', async () => {
        await gate;
        await hub.gateway.chat({ model: 'stub-model', messages: hi });
      });
      return step.traceId;
    });
    release();
    await background;
    const spans = await stored(hub, traceId);
    expect(spans.map((s) => s.name).sort()).toEqual(['late-child', 'root', 'stub-model']);
    await hub.gateway.close();
  });

  // The two below fail on the SDK released before #612 with no step involved.

  it('keeps every tool span of two tool loops on one trace (shipped bug)', async () => {
    script = [reply(true), reply(), reply(true), reply()];
    const hub = await client();
    const opts = { model: 'stub-model', messages: hi, toolDefs: [LOOKUP_DEF], dispatch: () => 'ok' };
    const first = await hub.gateway.runToolLoop(opts);
    await hub.traces.flush();
    await hub.gateway.runToolLoop({ ...opts, trace: { traceId: first.traceId } });
    const kinds = (await stored(hub, first.traceId!)).map((s) => s.kind);
    expect(kinds.filter((k) => k === 'tool')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'llm')).toHaveLength(4);
    await hub.gateway.close();
  });

  it('does not merge a queued capturePayloads opt-out away (shipped bug)', async () => {
    const hub = await client();
    const span = (spanId: string, name: string, input: unknown): IngestSpan =>
      ({ spanId, name, kind: 'chain', status: 'ok', startTime: '2026-10-17T00:00:00Z', input });
    const opened = await hub.traces.ingest({ name: 't', spans: [span('a', 'open', { x: 1 })] });
    // The first queued entry goes out at once; the two behind it are sent together.
    await hub.traces.ingest({ traceId: opened.traceId, spans: [span('f', 'in-flight', { x: 0 })] }, { wait: false });
    await hub.traces.ingest({ traceId: opened.traceId, spans: [span('b', 'public', { x: 2 })] }, { wait: false });
    await hub.traces.ingest({ traceId: opened.traceId, capturePayloads: false, spans: [span('c', 'pii', { ssn: '123-45-6789' })] }, { wait: false });
    const byName = Object.fromEntries((await stored(hub, opened.traceId)).map((s) => [s.name, s]));
    expect(JSON.stringify(byName.pii.payload ?? null)).not.toContain('123-45-6789');
    expect(byName.public.payload?.input).toEqual({ x: 2 });
    await hub.gateway.close();
  });
});
