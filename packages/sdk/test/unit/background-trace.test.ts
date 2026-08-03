import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server, type RequestListener } from 'node:http';
import { acruxcore } from '../../src/client';
import { acrux } from '../../src/tools';

/**
 * The regression test for the 572 ms an awaited `POST /traces` used to add to every
 * traced BYO call (spec: "Background trace reporting", 2026-07-30).
 *
 * Both endpoints are real loopback HTTP servers rather than mocks — the traces stub
 * answers deliberately slowly, so "did the call wait for it?" is a deterministic
 * assertion rather than a statistical one.
 */

const TRACE_DELAY_MS = 400;

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

/** One OpenAI-shaped completion, optionally asking for a tool. */
function completion(content: string | null, toolCall?: { name: string; args: string }) {
  return {
    id: 'c1',
    model: 'stub-model',
    choices: [
      {
        index: 0,
        finish_reason: toolCall ? 'tool_calls' : 'stop',
        message: {
          role: 'assistant',
          content,
          ...(toolCall
            ? {
                tool_calls: [
                  { id: 'tc1', type: 'function', function: { name: toolCall.name, arguments: toolCall.args } },
                ],
              }
            : {}),
        },
      },
    ],
    usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 },
  };
}

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers = [];
});

describe('trace reporting is off the critical path', () => {
  it('chat() returns before a slow POST /traces completes, and the trace still lands', async () => {
    const traceBodies: { traces: { traceId?: string; spans: unknown[] }[] }[] = [];

    const acruxBase = await listen((req, res) => {
      void readBody(req).then((raw) => {
        // Deliberately slow, standing in for a distant server.
        setTimeout(() => {
          traceBodies.push(JSON.parse(raw));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ accepted: 1, traceIds: ['11111111-1111-4111-8111-111111111111'] }));
        }, TRACE_DELAY_MS);
      });
    });

    const providerBase = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(completion('pong')));
    });

    const hub = new acruxcore({ apiKey: 'k', baseUrl: `${acruxBase}/api/v1` });

    const started = Date.now();
    const result = await hub.chat({
      model: 'stub-model',
      messages: [{ role: 'user', content: 'ping' }],
      provider: { baseUrl: providerBase, apiKey: 'p' },
      // Tracing left at its BYO default of on — that is the point of the test.
    });
    const elapsed = Date.now() - started;

    expect(result.content).toBe('pong');
    // The whole bug: this used to be >= TRACE_DELAY_MS.
    expect(elapsed).toBeLessThan(TRACE_DELAY_MS / 2);
    expect(traceBodies).toHaveLength(0); // in flight, not yet answered

    await hub.flush();

    expect(traceBodies).toHaveLength(1); // nothing lost
    expect(traceBodies[0].traces).toHaveLength(1);
    expect(traceBodies[0].traces[0].spans).toHaveLength(1);
    await hub.close();
  });

  it('a tool loop with client-side tools awaits no trace write at all', async () => {
    let traceRequests = 0;
    const acruxBase = await listen((req, res) => {
      void readBody(req).then(() => {
        traceRequests++;
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ accepted: 1, traceIds: ['11111111-1111-4111-8111-111111111111'] }));
        }, TRACE_DELAY_MS);
      });
    });

    let round = 0;
    const providerBase = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(round++ === 0 ? completion(null, { name: 'add', args: '{"a":2,"b":3}' }) : completion('5')));
    });

    const add = acrux.tool(
      {
        name: 'add',
        description: 'Adds two numbers.',
        parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
      },
      ({ a, b }: { a: number; b: number }) => String(a + b),
    );

    const hub = new acruxcore({ apiKey: 'k', baseUrl: `${acruxBase}/api/v1` });

    const started = Date.now();
    const loop = await hub.runToolLoop({
      model: 'stub-model',
      messages: [{ role: 'user', content: 'what is 2 + 3?' }],
      tools: [add],
      // The stub answers every path slowly, and a declared tool would otherwise sync
      // itself to the catalog first — a round-trip this test is not measuring.
      sync: false,
      provider: { baseUrl: providerBase, apiKey: 'p' },
    });
    const elapsed = Date.now() - started;

    expect(loop.content).toBe('5');
    // Two rounds' llm spans plus the tool spans, none of them awaited.
    expect(elapsed).toBeLessThan(TRACE_DELAY_MS / 2);

    await hub.flush();
    expect(traceRequests).toBeGreaterThanOrEqual(1);
    await hub.close();
  });

  it('close() flushes what is still buffered', async () => {
    let received = 0;
    const acruxBase = await listen((req, res) => {
      void readBody(req).then(() => {
        received++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ accepted: 1, traceIds: ['11111111-1111-4111-8111-111111111111'] }));
      });
    });
    const providerBase = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(completion('ok')));
    });

    const hub = new acruxcore({ apiKey: 'k', baseUrl: `${acruxBase}/api/v1` });
    await hub.chat({
      model: 'stub-model',
      messages: [{ role: 'user', content: 'hi' }],
      provider: { baseUrl: providerBase, apiKey: 'p' },
    });
    await hub.close();

    expect(received).toBe(1);
  });

  it('a failed trace report never surfaces in chat()', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const acruxBase = await listen((req, res) => {
      void readBody(req).then(() => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'INVALID_SPAN_PARENT' } }));
      });
    });
    const providerBase = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(completion('still fine')));
    });

    const hub = new acruxcore({ apiKey: 'k', baseUrl: `${acruxBase}/api/v1`, maxRetries: 0 });
    const result = await hub.chat({
      model: 'stub-model',
      messages: [{ role: 'user', content: 'hi' }],
      provider: { baseUrl: providerBase, apiKey: 'p' },
    });

    expect(result.content).toBe('still fine');
    await expect(hub.flush()).resolves.toBeUndefined();
    // The warning names the status AND the API's error code, so a rejected batch is
    // diagnosable from the one line it prints.
    const warned = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('trace report failed'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('400');
    expect(warned[0]).toContain('INVALID_SPAN_PARENT');
    await hub.close();
    warn.mockRestore();
  });

  it('public trace() still awaits and still returns a traceId', async () => {
    const acruxBase = await listen((req, res) => {
      void readBody(req).then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ accepted: 1, traceIds: ['22222222-2222-4222-8222-222222222222'] }));
      });
    });

    const hub = new acruxcore({ apiKey: 'k', baseUrl: `${acruxBase}/api/v1` });
    const result = await hub.trace({
      name: 'manual',
      spans: [
        {
          spanId: 's1',
          name: 'retrieval',
          kind: 'retrieval',
          status: 'ok',
          startTime: '2026-07-30T00:00:00.000Z',
          endTime: '2026-07-30T00:00:00.000Z',
        },
      ],
    });

    expect(result.traceId).toBe('22222222-2222-4222-8222-222222222222');
    await hub.close();
  });
});
