import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type RequestListener } from 'node:http';
import { acruxcore } from '../../src/client';
import type { ToolLoopEvent } from '../../src';

/**
 * `reasoningEffort` reaches the model, and the provider's cached and reasoning token
 * counts reach the caller and the trace (issues #593, #594).
 *
 * Both the AcruxCore API and the BYO provider are real loopback HTTP servers, so what is
 * asserted is the exact JSON that crossed the wire.
 */

let servers: Server[] = [];

/** Starts an http server on a free port and returns its base URL. */
async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

/** Reads a request body to completion. */
function readBody(req: Parameters<RequestListener>[0]): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw));
  });
}

/** The nested usage object an OpenAI-shaped provider returns. */
const NESTED_USAGE = {
  prompt_tokens: 1200,
  completion_tokens: 300,
  total_tokens: 1500,
  prompt_tokens_details: { cached_tokens: 1024 },
  completion_tokens_details: { reasoning_tokens: 256 },
};

/** One OpenAI-shaped completion. */
function completion(usage: Record<string, unknown>) {
  return {
    id: 'c1',
    model: 'stub-model',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'pong' } }],
    usage,
  };
}

/** One SSE stream: a text delta, a finish frame, then a usage-only frame. */
function sse(usage: Record<string, unknown>): string {
  const frames = [
    { id: 's1', model: 'stub-model', choices: [{ index: 0, delta: { content: 'po' }, finish_reason: null }] },
    { id: 's1', model: 'stub-model', choices: [{ index: 0, delta: { content: 'ng' }, finish_reason: 'stop' }] },
    { id: 's1', model: 'stub-model', choices: [], usage },
  ];
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
}

interface Recorded {
  providerBodies: Record<string, unknown>[];
  spans: { usage?: Record<string, unknown> }[];
}

/** Boots an AcruxCore stub that records `/traces` and a provider stub that records bodies. */
async function stubs(opts: { stream?: boolean; usage?: Record<string, unknown> } = {}) {
  const rec: Recorded = { providerBodies: [], spans: [] };
  const usage = opts.usage ?? NESTED_USAGE;
  const acruxBase = await listen((req, res) => {
    void readBody(req).then((raw) => {
      const body = JSON.parse(raw) as { traces: { spans: { usage?: Record<string, unknown> }[] }[] };
      for (const t of body.traces) rec.spans.push(...t.spans);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: 1, traceIds: ['11111111-1111-4111-8111-111111111111'] }));
    });
  });
  const providerBase = await listen((req, res) => {
    void readBody(req).then((raw) => {
      rec.providerBodies.push(JSON.parse(raw));
      if (opts.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sse(usage));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(completion(usage)));
      }
    });
  });
  const hub = new acruxcore({ apiKey: 'k', baseUrl: `${acruxBase}/api/v1` });
  const provider = { baseUrl: `${providerBase}/v1`, apiKey: 'sk-test' };
  return { rec, hub, provider };
}

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers = [];
});

describe('reasoningEffort and cached/reasoning token usage', () => {
  it('gateway chat sends reasoning_effort and reads the flat cached/reasoning counts', async () => {
    const bodies: Record<string, unknown>[] = [];
    const gatewayBase = await listen((req, res) => {
      void readBody(req).then((raw) => {
        bodies.push(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(completion({
          prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500,
          cached_tokens: 1024, reasoning_tokens: 256,
        })));
      });
    });
    const hub = new acruxcore({ apiKey: 'k', baseUrl: `${gatewayBase}/api/v1` });

    const result = await hub.gateway.chat({
      model: 'o4-mini', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'high',
    });

    expect(bodies[0]!['reasoning_effort']).toBe('high');
    expect(result.usage).toEqual({
      promptTokens: 1200, completionTokens: 300, totalTokens: 1500, cachedTokens: 1024, reasoningTokens: 256,
    });
  });

  it('BYO chat sends reasoning_effort, reads the nested counts, and reports cachedTokens on its span', async () => {
    const { rec, hub, provider } = await stubs();

    const result = await hub.gateway.chat({
      model: 'o4-mini', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'low', provider,
    });
    await hub.gateway.flush();

    expect(rec.providerBodies[0]!['reasoning_effort']).toBe('low');
    expect(result.usage).toEqual({
      promptTokens: 1200, completionTokens: 300, totalTokens: 1500, cachedTokens: 1024, reasoningTokens: 256,
    });
    expect(rec.spans).toHaveLength(1);
    expect(rec.spans[0]!.usage).toEqual({
      promptTokens: 1200, completionTokens: 300, totalTokens: 1500, cachedTokens: 1024,
    });
  });

  it('omits the counts when the provider reports zero, and sends no reasoning_effort unless asked', async () => {
    const { rec, hub, provider } = await stubs({
      usage: {
        prompt_tokens: 10, completion_tokens: 2, total_tokens: 12,
        prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 },
      },
    });

    const result = await hub.gateway.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], provider });
    await hub.gateway.flush();

    expect('reasoning_effort' in rec.providerBodies[0]!).toBe(false);
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 2, totalTokens: 12 });
    expect(rec.spans[0]!.usage).toEqual({ promptTokens: 10, completionTokens: 2, totalTokens: 12 });
  });

  it('BYO streaming chat sends reasoning_effort and reports cachedTokens on its span', async () => {
    const { rec, hub, provider } = await stubs({ stream: true });

    const stream = await hub.gateway.chat({
      model: 'o4-mini', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'medium', provider, stream: true,
    });
    let text = '';
    for await (const chunk of stream) text += chunk.delta.content ?? '';
    await hub.gateway.flush();

    expect(text).toBe('pong');
    expect(rec.providerBodies[0]!['reasoning_effort']).toBe('medium');
    expect(rec.spans[0]!.usage).toEqual({
      promptTokens: 1200, completionTokens: 300, totalTokens: 1500, cachedTokens: 1024,
    });
  });

  it('BYO runToolLoop sends reasoning_effort and reports cachedTokens on its llm span', async () => {
    const { rec, hub, provider } = await stubs();

    await hub.gateway.runToolLoop({
      model: 'o4-mini', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'high', provider,
    });
    await hub.gateway.flush();

    expect(rec.providerBodies[0]!['reasoning_effort']).toBe('high');
    const llm = rec.spans.find((s) => (s as { kind?: string }).kind === 'llm');
    expect(llm!.usage).toEqual({ promptTokens: 1200, completionTokens: 300, totalTokens: 1500, cachedTokens: 1024 });
  });

  it('BYO streaming runToolLoop sends reasoning_effort and reports cachedTokens on its llm span', async () => {
    const { rec, hub, provider } = await stubs({ stream: true });

    const events = await hub.gateway.runToolLoop({
      model: 'o4-mini', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'low', provider, stream: true,
    });
    const seen: ToolLoopEvent[] = [];
    for await (const e of events) seen.push(e);
    await hub.gateway.flush();

    expect(rec.providerBodies[0]!['reasoning_effort']).toBe('low');
    const llm = rec.spans.find((s) => (s as { kind?: string }).kind === 'llm');
    expect(llm!.usage).toEqual({ promptTokens: 1200, completionTokens: 300, totalTokens: 1500, cachedTokens: 1024 });
  });

  it('runPromptWithTools passes reasoningEffort through to the provider', async () => {
    const { rec, hub, provider } = await stubs();

    await hub.gateway.runPromptWithTools(
      {
        messages: [{ role: 'user', content: 'hi' }],
        model: 'o4-mini',
        versionId: null,
        variables: {},
        toolResolutions: [],
      } as unknown as Parameters<typeof hub.gateway.runPromptWithTools>[0],
      { reasoningEffort: 'high', provider },
    );

    expect(rec.providerBodies[0]!['reasoning_effort']).toBe('high');
  });

  it('never reports a cached count larger than the prompt count, which the server would reject', async () => {
    const { rec, hub, provider } = await stubs({
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 50 } },
    });

    await hub.gateway.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], provider });
    await hub.gateway.flush();

    expect(rec.spans[0]!.usage).toEqual({ promptTokens: 10, completionTokens: 2, totalTokens: 12 });
  });
});
