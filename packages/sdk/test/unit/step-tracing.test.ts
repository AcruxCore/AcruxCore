import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { acruxcore } from '../../src/client';
import { acruxcoreError } from '../../src/error';
import type { IngestSpan, TraceInput } from '../../src/types';
import * as stepsModule from '../../src/steps';
import { stepTraceName } from '../../src/steps';
import { randomUUID } from 'node:crypto';
import v8 from 'node:v8';
import vm from 'node:vm';

/** The per-root span cap, when this build has one. */
const stepLimits = (stepsModule as { stepLimits?: { maxSpans: number } }).stepLimits;

/**
 * Tracing an app's own steps, and the `chat()` gaps that made it hard (issue #612, the
 * TypeScript half of #610).
 *
 * One loopback server stands in for the platform API and a BYO provider. Its
 * `POST /traces` applies the two checks the real ingest service makes — every
 * `parentSpanId` must be in the request or already stored, and a `spanId` may not repeat
 * within one entry — so a report the real server would reject is lost here too.
 *
 * The section at the end holds one test per bug the Python SDK shipped with on PR #613,
 * so the TypeScript side cannot repeat them.
 */

const PROMPT_ID = '11111111-1111-4111-8111-111111111111';
const VERSION_ID = '22222222-2222-4222-8222-222222222222';
const LOOKUP_DEF = {
  type: 'function' as const,
  function: { name: 'lookup', parameters: { type: 'object', properties: {} } },
};

let servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); })));
  servers = [];
  vi.restoreAllMocks();
});

function completion(toolCall = false) {
  return {
    id: 'c1',
    model: 'stub-model',
    choices: [{
      index: 0,
      finish_reason: toolCall ? 'tool_calls' : 'stop',
      message: toolCall
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }
        : { role: 'assistant', content: 'pong' },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };
}

function sse(): string {
  const frames = [
    { id: 's1', model: 'stub-model', choices: [{ index: 0, delta: { content: 'pong' }, finish_reason: 'stop' }] },
    { id: 's1', model: 'stub-model', choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  ];
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw));
  });
}

/** What the fake platform and provider were sent. */
class Recorder {
  providerBodies: Record<string, unknown>[] = [];
  gatewayCalls: { body: Record<string, unknown>; headers: IncomingMessage['headers'] }[] = [];
  tracePosts: TraceInput[][] = [];
  rejected: string[] = [];
  getPaths: string[] = [];
  /** Provider replies handed out in order before falling back to a plain answer. */
  providerScript: unknown[] = [];
  /** When set, a streamed provider reply sends one frame and then holds the connection. */
  hangStream = false;
  streamClosed = false;
  /**
   * `true` makes this server answer `GET /prompt-versions?name=&alias=`, the one-request
   * lookup. Off, that path gets the 404 with no error code an older server sends.
   */
  aliasEndpoint = false;
  /** Span ids stored per trace, the way the ingest service's parent check sees them. */
  private stored = new Map<string, Set<string>>();
  private gatewaySpans = 0;
  base = '';

  get traces(): TraceInput[] {
    return this.tracePosts.flat();
  }

  get spans(): IngestSpan[] {
    return this.traces.flatMap((t) => t.spans);
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => void this.handle(req, res));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    this.base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }

  private json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }

  private storedFor(traceId: string): Set<string> {
    let ids = this.stored.get(traceId);
    if (!ids) this.stored.set(traceId, (ids = new Set()));
    return ids;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const path = (req.url ?? '').split('?')[0];

    if (path.startsWith('/provider/')) {
      this.providerBodies.push(body);
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (this.hangStream) {
          res.on('close', () => (this.streamClosed = true));
          res.write(`data: ${JSON.stringify({ id: 's1', model: 'stub-model', choices: [{ index: 0, delta: { content: 'po' }, finish_reason: null }] })}\n\n`);
          return;
        }
        res.end(sse());
        return;
      }
      this.json(res, 200, this.providerScript.length ? this.providerScript.shift() : completion());
      return;
    }

    if (path.endsWith('/traces') && req.method === 'POST') {
      const entries = body.traces as TraceInput[];
      for (const entry of entries) {
        const ids = entry.spans.map((s) => s.spanId);
        if (new Set(ids).size !== ids.length) {
          this.rejected.push('DUPLICATE_SPAN_ID');
          return this.json(res, 400, { error: { code: 'VALIDATION_ERROR' } });
        }
      }
      for (const entry of entries) {
        const known = new Set([...(entry.traceId ? this.storedFor(entry.traceId) : []), ...entries
          .filter((e) => e.traceId === entry.traceId).flatMap((e) => e.spans.map((s) => s.spanId))]);
        for (const span of entry.spans) {
          if (span.parentSpanId && !known.has(span.parentSpanId)) {
            this.rejected.push(`INVALID_SPAN_PARENT ${span.name}`);
            return this.json(res, 400, { error: { code: 'INVALID_SPAN_PARENT' } });
          }
        }
      }
      // Stored spans are unique per (traceId, spanId): a repeat is not stored a second time.
      const kept = entries.map((entry) => {
        if (!entry.traceId) return entry;
        const ids = this.storedFor(entry.traceId);
        const spans = entry.spans.filter((s) => {
          if (!ids.has(s.spanId)) return true;
          this.rejected.push(`DUPLICATE_STORED ${s.spanId}`);
          return false;
        });
        for (const s of spans) ids.add(s.spanId);
        return { ...entry, spans };
      });
      this.tracePosts.push(kept);
      return this.json(res, 200, { accepted: entries.length, traceIds: entries.map((e) => e.traceId ?? 't1') });
    }

    if (path.endsWith('/gateway/chat/completions')) {
      this.gatewayCalls.push({ body, headers: req.headers });
      const traceId = (req.headers['x-trace-id'] as string | undefined) ?? `gw-trace-${this.gatewayCalls.length}`;
      const spanId = `gw-span-${++this.gatewaySpans}`;
      this.storedFor(traceId).add(spanId);
      const headers = { 'x-gateway-trace-id': traceId, 'x-gateway-span-id': spanId };
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', ...headers });
        res.end(sse());
        return;
      }
      return this.json(res, 200, this.providerScript.length ? this.providerScript.shift() : completion(), headers);
    }

    if (req.method === 'GET') {
      this.getPaths.push(req.url ?? '');
      if (path.endsWith('/prompt-versions') && this.aliasEndpoint) {
        const q = new URL(req.url ?? '', 'http://x').searchParams;
        if (q.get('name') !== 'triage' || q.get('alias') !== 'production') {
          return this.json(res, 404, { error: { code: 'NOT_FOUND', message: 'Prompt or alias not found' } });
        }
        return this.json(res, 200, {
          id: VERSION_ID, promptId: PROMPT_ID, versionNumber: 3,
          messages: [{ role: 'system', content: 'Triage {{ ticket }}' }],
          variables: ['ticket'], model: null, createdBy: 'u', createdAt: '2026-10-01T00:00:00Z',
        });
      }
      if (path.endsWith('/prompts')) {
        return this.json(res, 200, {
          data: [
            { id: 'other', name: 'triage-v2', description: null, createdAt: '2026-10-01T00:00:00Z' },
            { id: PROMPT_ID, name: 'triage', description: null, createdAt: '2026-10-01T00:00:00Z' },
          ],
          total: 2, page: 1, limit: 100,
        });
      }
      if (path.endsWith(`/prompts/${PROMPT_ID}/aliases`)) {
        return this.json(res, 200, [
          { id: 'a1', alias: 'production', versionId: VERSION_ID, versionNumber: 3, updatedAt: '2026-10-01T00:00:00Z' },
          { id: 'a2', alias: 'staging', versionId: 'x', versionNumber: 4, updatedAt: '2026-10-01T00:00:00Z' },
        ]);
      }
      const version = path.match(new RegExp(`/prompts/${PROMPT_ID}/versions/(\\d+)$`));
      if (version) {
        const n = Number(version[1]);
        return this.json(res, 200, {
          id: n === 3 ? VERSION_ID : 'x', promptId: PROMPT_ID, versionNumber: n,
          messages: [{ role: 'system', content: n === 3 ? 'Triage {{ ticket }}' : 'Staging {{ ticket }}' }],
          variables: ['ticket'], model: null, createdBy: 'u', createdAt: '2026-10-01T00:00:00Z',
        });
      }
    }
    this.json(res, 404, { error: { message: `unexpected ${req.method} ${path}` } });
  }
}

async function setup(options: { byo?: boolean; cacheTtl?: number; maxCacheSize?: number } = {}) {
  const rec = new Recorder();
  await rec.start();
  const hub = new acruxcore({
    apiKey: 'acx_sk_test',
    baseUrl: `${rec.base}/api/v1`,
    maxRetries: 0,
    cacheTtl: options.cacheTtl,
    maxCacheSize: options.maxCacheSize,
    ...(options.byo ? { provider: { baseUrl: `${rec.base}/provider/v1`, apiKey: 'pk' } } : {}),
  });
  return { rec, hub };
}

function byName(spans: IngestSpan[], name: string): IngestSpan {
  const span = spans.find((s) => s.name === name);
  if (!span) throw new Error(`no span named ${name} in ${spans.map((s) => s.name).join(', ')}`);
  return span;
}

const hi = [{ role: 'user' as const, content: 'hi' }];

async function drain(it: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of it) { /* consume */ }
}

// ── 1. extraBody ──────────────────────────────────────────────────────────

describe('extraBody', () => {
  it('reaches the gateway and a BYO provider, streamed or not', async () => {
    const { rec, hub } = await setup();
    const provider = { baseUrl: `${rec.base}/provider/v1`, apiKey: 'pk' };
    await hub.gateway.chat({ model: 'm', messages: hi, extraBody: { top_p: 0.5, seed: 7 } });
    await hub.gateway.chat({ model: 'm', messages: hi, provider, extraBody: { seed: 7 } });
    await drain(await hub.gateway.stream({ model: 'm', messages: hi, provider, extraBody: { seed: 9 } }));
    await hub.gateway.close();

    expect(rec.gatewayCalls[0].body).toMatchObject({ top_p: 0.5, seed: 7 });
    expect(rec.providerBodies[0].seed).toBe(7);
    expect(rec.providerBodies[1].seed).toBe(9);
  });

  it('may not overwrite a field the SDK sets, and nothing is sent', async () => {
    const { rec, hub } = await setup();
    for (const extraBody of [{ messages: [] }, { temperature: 1 }, { stream: true }]) {
      const err = await hub.gateway
        .chat({ model: 'm', messages: hi, temperature: 0, extraBody })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(acruxcoreError);
      expect((err as acruxcoreError).code).toBe('VALIDATION_ERROR');
      expect((err as Error).message).toContain(Object.keys(extraBody)[0]);
    }
    // A BYO stream refuses at the call too, not on the first chunk.
    const provider = { baseUrl: `${rec.base}/provider/v1`, apiKey: 'pk' };
    await expect(hub.gateway.stream({ model: 'm', messages: hi, provider, extraBody: { model: 'x' } }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await hub.gateway.close();
    expect(rec.gatewayCalls).toHaveLength(0);
    expect(rec.providerBodies).toHaveLength(0);
  });
});

// ── 2. parent span and 3. BYO trace name ──────────────────────────────────

describe('trace.parentSpanId and the BYO trace name', () => {
  it('sends x-parent-span-id on the gateway path', async () => {
    const { rec, hub } = await setup();
    await hub.gateway.chat({ model: 'm', messages: hi, trace: { traceId: 't-1', parentSpanId: 'step-1' } });
    await hub.gateway.close();
    expect(rec.gatewayCalls[0].headers['x-parent-span-id']).toBe('step-1');
    expect(rec.gatewayCalls[0].headers['x-trace-id']).toBe('t-1');
  });

  it('sets parentSpanId on a BYO span from chat and stream', async () => {
    const { rec, hub } = await setup({ byo: true });
    // The parents exist on the trace already, as a span the caller reported would.
    await hub.traces.ingest({ traceId: 't-1', name: 'x', spans: [
      { spanId: 'step-1', name: 'a', startTime: '2026-10-17T00:00:00Z' },
      { spanId: 'step-2', name: 'b', startTime: '2026-10-17T00:00:00Z' },
    ] });
    await hub.gateway.chat({ model: 'm', messages: hi, trace: { traceId: 't-1', parentSpanId: 'step-1' } });
    await drain(await hub.gateway.stream({ model: 'm', messages: hi, trace: { traceId: 't-1', parentSpanId: 'step-2' } }));
    await hub.gateway.close();
    expect(rec.spans.filter((s) => s.kind === 'llm').map((s) => s.parentSpanId)).toEqual(['step-1', 'step-2']);
  });

  it('names a BYO trace from trace.name on chat and stream', async () => {
    const { rec, hub } = await setup({ byo: true });
    await hub.gateway.chat({ model: 'm', messages: hi, trace: { name: 'triage' } });
    await drain(await hub.gateway.stream({ model: 'm', messages: hi, trace: { name: 'reply' } }));
    await hub.gateway.chat({ model: 'm', messages: hi });
    await hub.gateway.close();
    expect(rec.traces.map((t) => t.name)).toEqual(['triage', 'reply', 'chat']);
  });
});

// ── 4. traces.step / traces.wrap ──────────────────────────────────────────

describe('traces.step and traces.wrap', () => {
  it('nests steps, and a gateway call lands under its step', async () => {
    const { rec, hub } = await setup();
    const classify = hub.traces.wrap('classify', { kind: 'chain' }, async (ticket: string) => {
      const result = await hub.gateway.chat({ model: 'm', messages: [{ role: 'user', content: ticket }] });
      return result.content ?? '';
    });
    const handle = hub.traces.wrap('handle-ticket', { kind: 'agent' }, (ticket: string) => classify(ticket));

    expect(await handle('printer on fire')).toBe('pong');
    await hub.gateway.close();

    expect(rec.tracePosts).toHaveLength(1);
    const trace = rec.traces[0];
    expect(trace.name).toBe('handle-ticket');
    const root = byName(trace.spans, 'handle-ticket');
    const child = byName(trace.spans, 'classify');
    expect(root.parentSpanId).toBeUndefined();
    expect(child.parentSpanId).toBe(root.spanId);
    expect([root.kind, child.kind]).toEqual(['agent', 'chain']);
    expect(root.input).toEqual(['printer on fire']);
    expect(root.output).toBe('pong');

    const headers = rec.gatewayCalls[0].headers;
    expect(headers['x-trace-id']).toBe(trace.traceId);
    expect(headers['x-parent-span-id']).toBe(child.spanId);
    expect(headers['x-trace-name-if-unset']).toBe('handle-ticket');
  });

  it('ships a BYO call inside a step with the step tree', async () => {
    const { rec, hub } = await setup({ byo: true });
    await hub.traces.step('answer', async () => {
      await hub.gateway.chat({ model: 'm', messages: hi });
      await drain(await hub.gateway.stream({ model: 'm', messages: hi }));
    });
    await hub.gateway.close();

    expect(rec.rejected).toEqual([]);
    expect(rec.traces).toHaveLength(1);
    const step = byName(rec.spans, 'answer');
    const llm = rec.spans.filter((s) => s.kind === 'llm');
    expect(llm).toHaveLength(2);
    expect(llm.every((s) => s.parentSpanId === step.spanId)).toBe(true);
  });

  it('records a failing step and rethrows, sync and async', async () => {
    const { rec, hub } = await setup();
    const lookup = hub.traces.wrap('lookup', { kind: 'retrieval' }, async () => {
      throw new Error('order-9 not found');
    });
    await expect(lookup()).rejects.toThrow('order-9');
    expect(() => hub.traces.step('parse', () => { throw new TypeError('bad line'); })).toThrow('bad line');
    await hub.gateway.close();

    expect(byName(rec.spans, 'lookup')).toMatchObject({ status: 'error' });
    expect(byName(rec.spans, 'lookup').error).toContain('order-9');
    expect(byName(rec.spans, 'parse').error).toContain('bad line');
  });

  it('gives the callback its step, and stores values JSON cannot hold', async () => {
    const { rec, hub } = await setup();
    const loop: Record<string, unknown> = { id: 42 };
    loop.self = loop;
    let outerIds: { traceId?: string; spanId?: string } = {};
    const out = await hub.traces.step('pipeline', { input: { big: 10n, loop } }, async (outer) => {
      outerIds = { traceId: outer.traceId, spanId: outer.spanId };
      hub.traces.step('parse', (inner) => { inner.output = { id: 42 }; });
      return 'done';
    });
    await hub.gateway.close();

    expect(out).toBe('done');
    const pipeline = byName(rec.spans, 'pipeline');
    const parse = byName(rec.spans, 'parse');
    expect(parse.parentSpanId).toBe(pipeline.spanId);
    expect(pipeline.spanId).toBe(outerIds.spanId);
    expect(rec.traces[0].traceId).toBe(outerIds.traceId);
    expect(pipeline.input).toEqual({ big: '10', loop: { id: 42, self: '[Circular]' } });
    expect(pipeline.output).toBe('done');
    expect(parse.output).toEqual({ id: 42 });
  });

  it('still opts out with trace: false inside a step', async () => {
    const { rec, hub } = await setup();
    await hub.traces.step('quiet', () => hub.gateway.chat({ model: 'm', messages: hi, trace: false }));
    await hub.gateway.close();
    expect(rec.gatewayCalls[0].headers['x-trace-id']).toBeUndefined();
  });

  it('keeps two concurrent root steps on their own traces', async () => {
    const { rec, hub } = await setup({ byo: true });
    const handle = hub.traces.wrap('handle', {}, async (n: number) => {
      await new Promise((r) => setTimeout(r, n));
      await hub.gateway.chat({ model: 'm', messages: hi });
    });
    await Promise.all([handle(20), handle(5)]);
    await hub.gateway.close();

    expect(rec.traces).toHaveLength(2);
    for (const t of rec.traces) {
      const step = byName(t.spans, 'handle');
      expect(t.spans.filter((s) => s.kind === 'llm').map((s) => s.parentSpanId)).toEqual([step.spanId]);
    }
  });
});

// ── 5. prompts.getByAlias ─────────────────────────────────────────────────

describe('prompts.getByAlias', () => {
  it('returns the template by exact name, unrendered, and caches it', async () => {
    const { rec, hub } = await setup();
    const first = await hub.prompts.getByAlias('triage', 'production');
    const second = await hub.prompts.getByAlias('triage', 'production');
    expect(first.id).toBe(VERSION_ID);
    expect(first.versionNumber).toBe(3);
    expect(first.messages).toEqual([{ role: 'system', content: 'Triage {{ ticket }}' }]);
    expect(second).toEqual(first);
    expect(rec.getPaths.filter((p) => p.includes('/versions/'))).toHaveLength(1);
  });

  it('names what is missing', async () => {
    const { hub } = await setup({ cacheTtl: 0 });
    await expect(hub.prompts.getByAlias('nope', 'production')).rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining('nope') });
    await expect(hub.prompts.getByAlias('triage', 'canary')).rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining('canary') });
  });

  it('hands out a copy and honours maxCacheSize (Python PR #613 finding)', async () => {
    const { rec, hub } = await setup({ maxCacheSize: 1 });
    const first = await hub.prompts.getByAlias('triage', 'production');
    first.messages[0].content = 'Triage printer on fire';
    const cached = await hub.prompts.getByAlias('triage', 'production');
    expect(cached.messages[0].content).toBe('Triage {{ ticket }}');
    // A cache hit must be a copy too, not only the first fetch.
    cached.messages[0].content = 'Triage a refund';
    const again = await hub.prompts.getByAlias('triage', 'production');
    expect(again.messages[0].content).toBe('Triage {{ ticket }}');

    await hub.prompts.getByAlias('triage', 'staging'); // evicts production
    await hub.prompts.getByAlias('triage', 'production');
    expect(rec.getPaths.filter((p) => p.endsWith('/versions/3'))).toHaveLength(2);
  });
});

// ── 6. bugs the Python SDK shipped with on PR #613, and one found after ───

describe('the Python step-tracing bugs do not repeat', () => {
  it('sends a step tree over the 200-span batch cap parent first', async () => {
    const { rec, hub } = await setup();
    hub.traces.step('agent', { kind: 'agent' }, () => {
      for (let n = 0; n < 250; n++) hub.traces.step(`tool-${n}`, { kind: 'tool' }, () => undefined);
    });
    await hub.gateway.close();
    expect(rec.rejected).toEqual([]);
    expect(rec.spans).toHaveLength(251);
  });

  it('keeps a routed report’s tags, metadata and capturePayloads opt-out', async () => {
    const { rec, hub } = await setup();
    await hub.traces.step('handle', async (step) => {
      await hub.traces.ingest({
        traceId: step.traceId, capturePayloads: false, tags: ['sensitive'], metadata: { tenant: 't-9' },
        spans: [{ spanId: 'secret-1', parentSpanId: step.spanId, name: 'pii-lookup', kind: 'tool',
          startTime: '2026-10-17T00:00:00Z', input: { ssn: '123' } }],
      }, { wait: false });
    });
    await hub.gateway.close();

    expect(rec.rejected).toEqual([]);
    const secret = rec.traces.filter((t) => t.spans.some((s) => s.spanId === 'secret-1'));
    expect(secret.length).toBeGreaterThan(0);
    expect(secret.every((t) => t.capturePayloads === false)).toBe(true);
    const stepEntry = rec.traces.find((t) => t.spans.some((s) => s.name === 'handle'))!;
    expect(stepEntry.capturePayloads).not.toBe(false);
    expect(stepEntry.tags).toContain('sensitive');
    expect(stepEntry.metadata).toMatchObject({ tenant: 't-9' });
  });

  it('sends a span reported after its root step ended, and keeps the queue count right', async () => {
    const { rec, hub } = await setup({ byo: true });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let late!: Promise<unknown>;
    await hub.traces.step('handle', async () => {
      late = gate.then(() => hub.gateway.chat({ model: 'm', messages: [{ role: 'user', content: 'late' }] }));
    });
    release(); // no flush first: the root report is still buffered
    await late;
    await hub.gateway.flush();
    expect(hub.spanQueue.pendingSpanCount).toBe(0);
    await hub.gateway.close();
    expect(rec.rejected).toEqual([]);
    expect(rec.spans.filter((s) => s.kind === 'llm')).toHaveLength(1);
  });

  it('sends nested steps that end after their root step, each with what it holds', async () => {
    const { rec, hub } = await setup({ byo: true });
    let releaseA!: () => void;
    let releaseB!: () => void;
    let chatted!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    const gateB = new Promise<void>((r) => (releaseB = r));
    const called = new Promise<void>((r) => (chatted = r));
    let background!: Promise<unknown>;
    await hub.traces.step('root', { kind: 'agent' }, async () => {
      background = Promise.all([
        hub.traces.step('late-a', async () => {
          await hub.gateway.chat({ model: 'm', messages: hi });
          chatted();
          await gateA;
        }),
        hub.traces.step('late-b', () => gateB),
      ]);
    });
    // late-a's llm span is buffered while late-a is open; late-b ending first must not
    // send it ahead of late-a.
    await called;
    releaseB();
    await new Promise((r) => setTimeout(r, 20));
    releaseA();
    await background;
    await hub.gateway.close();

    expect(rec.rejected).toEqual([]);
    const root = byName(rec.spans, 'root');
    const a = byName(rec.spans, 'late-a');
    expect(a.parentSpanId).toBe(root.spanId);
    expect(byName(rec.spans, 'late-b').parentSpanId).toBe(root.spanId);
    expect(rec.spans.find((s) => s.kind === 'llm')?.parentSpanId).toBe(a.spanId);
  });

  it('offers the step name to a runToolLoop given the step’s traceId', async () => {
    const { rec, hub } = await setup();
    await hub.traces.step('handle-ticket', { kind: 'agent' }, (step) =>
      hub.gateway.runToolLoop({ model: 'm', messages: hi, trace: { traceId: step.traceId } }));
    await hub.gateway.close();
    expect(rec.gatewayCalls[0].headers['x-trace-name-if-unset']).toBe('handle-ticket');
  });

  it('keeps every tool span of two BYO tool loops in one step', async () => {
    const { rec, hub } = await setup({ byo: true });
    rec.providerScript = [completion(true), completion(), completion(true), completion()];
    await hub.traces.step('handle', async (step) => {
      for (let i = 0; i < 2; i++) {
        await hub.gateway.runToolLoop({
          model: 'm', messages: hi, toolDefs: [LOOKUP_DEF], dispatch: () => 'ok', trace: { traceId: step.traceId },
        });
      }
    });
    await hub.gateway.close();
    expect(rec.rejected).toEqual([]);
    expect(rec.spans.filter((s) => s.kind === 'tool')).toHaveLength(2);
    expect(rec.spans.filter((s) => s.kind === 'llm')).toHaveLength(4);
  });

  it('keeps every tool span of two gateway tool loops on one trace (shipped bug, no step)', async () => {
    const { rec, hub } = await setup();
    rec.providerScript = [completion(true), completion(), completion(true), completion()];
    const first = await hub.gateway.runToolLoop({ model: 'm', messages: hi, toolDefs: [LOOKUP_DEF], dispatch: () => 'ok' });
    await hub.gateway.flush();
    await hub.gateway.runToolLoop({
      model: 'm', messages: hi, toolDefs: [LOOKUP_DEF], dispatch: () => 'ok', trace: { traceId: first.traceId },
    });
    await hub.gateway.close();
    expect(rec.rejected).toEqual([]);
    expect(rec.spans.filter((s) => s.kind === 'tool')).toHaveLength(2);
  });

  it('does not merge a queued capturePayloads opt-out away (shipped bug, no step)', async () => {
    const { rec, hub } = await setup();
    const span = (spanId: string, name: string, input: unknown): IngestSpan =>
      ({ spanId, name, kind: 'chain', startTime: '2026-10-17T00:00:00Z', input });
    const opened = await hub.traces.ingest({ name: 't', spans: [span('a', 'open', { x: 1 })] });
    // The first queued entry goes out at once; the two behind it wait for it and are
    // sent together, which is where the queue merges entries of one trace.
    await hub.traces.ingest({ traceId: opened.traceId, spans: [span('f', 'in-flight', { x: 0 })] }, { wait: false });
    await hub.traces.ingest({ traceId: opened.traceId, spans: [span('b', 'public', { x: 2 })] }, { wait: false });
    await hub.traces.ingest({ traceId: opened.traceId, capturePayloads: false, spans: [span('c', 'pii', { ssn: '1' })] }, { wait: false });
    await hub.gateway.close();
    const pii = rec.traces.find((t) => t.spans.some((s) => s.name === 'pii'))!;
    expect(pii.capturePayloads).toBe(false);
    expect(pii.spans.map((s) => s.name)).toEqual(['pii']);
  });

  it('wraps an async generator: open until it ends, current only while it runs', async () => {
    const { rec, hub } = await setup();
    let cleanedUp = false;
    const retrieve = hub.traces.wrap('retrieve', { kind: 'retrieval' }, async function* (q: string) {
      try {
        yield 'doc-1';
        await hub.gateway.chat({ model: 'm', messages: [{ role: 'user', content: q }] });
        yield 'doc-2';
        yield 'doc-3';
      } finally {
        cleanedUp = true;
      }
    });
    await hub.traces.step('handle', async () => {
      const docs: string[] = [];
      for await (const doc of retrieve('refund')) {
        docs.push(doc);
        // The consumer's own call between items belongs to `handle`, not to `retrieve`.
        if (doc === 'doc-1') await hub.gateway.chat({ model: 'm', messages: hi });
        if (doc === 'doc-2') break;
      }
      expect(docs).toEqual(['doc-1', 'doc-2']);
    });
    await hub.gateway.close();

    expect(cleanedUp).toBe(true);
    const retrieveSpan = byName(rec.spans, 'retrieve');
    const handleSpan = byName(rec.spans, 'handle');
    expect(retrieveSpan.status).toBe('ok');
    expect(retrieveSpan.output).toBeUndefined();
    expect(retrieveSpan.parentSpanId).toBe(handleSpan.spanId);
    expect(rec.gatewayCalls.map((c) => c.headers['x-parent-span-id'])).toEqual([handleSpan.spanId, retrieveSpan.spanId]);
  });

  it('wraps a sync generator, with steps opened inside it nested under it', async () => {
    const { rec, hub } = await setup();
    const parse = hub.traces.wrap('parse', {}, function* (lines: string[]) {
      for (const line of lines) yield hub.traces.step('line', () => line.toUpperCase());
    });
    expect([...parse(['a', 'b'])]).toEqual(['A', 'B']);
    await hub.gateway.close();
    const parseSpan = byName(rec.spans, 'parse');
    const lines = rec.spans.filter((s) => s.name === 'line');
    expect(lines).toHaveLength(2);
    expect(lines.every((s) => s.parentSpanId === parseSpan.spanId)).toBe(true);
    expect(parseSpan.output).toBeUndefined();
  });

  it('releases the connection when a consumer breaks out of a stream', async () => {
    const { rec, hub } = await setup({ byo: true });
    rec.hangStream = true;
    for await (const _ of await hub.gateway.stream({ model: 'm', messages: hi, trace: false })) break;
    const deadline = Date.now() + 2000;
    while (!rec.streamClosed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await hub.gateway.close();
    expect(rec.streamClosed).toBe(true);
  });

  it('warns once when a finished step cannot be queued, instead of staying silent', async () => {
    const { hub } = await setup();
    await hub.gateway.close(); // a closed queue discards with its own warning
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(hub.spanQueue, 'enqueue').mockImplementation(() => { throw new Error('queue is gone'); });
    hub.traces.step('one', () => undefined);
    hub.traces.step('two', () => undefined);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('queue is gone'))).toHaveLength(1);
  });
});

// ── 6. BYO trace gaps found during the #612 e2e run (issues #615, #616) ───

describe('BYO calls report what the gateway path reports', () => {
  const ctx = { tags: ['vip', 'refund'], metadata: { tenant: 'acme' } };

  it('keeps trace tags and metadata on every BYO report (#616)', async () => {
    const { rec, hub } = await setup({ byo: true });
    rec.providerScript = [completion(), completion(true), completion()];
    await hub.gateway.chat({ model: 'm', messages: hi, trace: { ...ctx } });
    await drain(await hub.gateway.stream({ model: 'm', messages: hi, trace: { ...ctx } }));
    await hub.gateway.runToolLoop({ model: 'm', messages: hi, toolDefs: [LOOKUP_DEF], dispatch: () => 'ok', trace: { ...ctx } });
    await drain(await hub.gateway.runToolLoop({ model: 'm', messages: hi, stream: true, trace: { ...ctx } }));
    await hub.gateway.close();
    // chat, stream, the blocking loop's two llm rounds and its tool span, the streamed loop's round.
    expect(rec.spans.map((s) => s.kind).sort()).toEqual(['llm', 'llm', 'llm', 'llm', 'llm', 'tool']);
    for (const entry of rec.traces) {
      expect(entry.tags).toEqual(ctx.tags);
      expect(entry.metadata).toEqual(ctx.metadata);
    }
  });

  it('reports a BYO stream the caller leaves early, marked clientClosed (#615)', async () => {
    const { rec, hub } = await setup({ byo: true });
    rec.hangStream = true;
    for await (const _ of await hub.gateway.stream({ model: 'm', messages: hi, trace: { name: 'preview' } })) break;
    await hub.gateway.close();
    expect(rec.spans).toHaveLength(1);
    const [span] = rec.spans;
    expect(span).toMatchObject({ kind: 'llm', status: 'ok', attributes: { clientClosed: true } });
    expect((span.output as { content: string }).content).toBe('po');
    expect(rec.traces[0].name).toBe('preview');
  });

  it('reports the round of a streamed BYO tool loop the caller leaves early (#615)', async () => {
    const { rec, hub } = await setup({ byo: true });
    rec.hangStream = true;
    for await (const _ of await hub.gateway.runToolLoop({ model: 'm', messages: hi, stream: true })) break;
    await hub.gateway.close();
    expect(rec.spans.filter((s) => s.kind === 'llm')).toHaveLength(1);
    expect(rec.spans[0].attributes).toMatchObject({ clientClosed: true });
  });

  it('writes no span for a BYO stream left early with trace: false', async () => {
    const { rec, hub } = await setup({ byo: true });
    rec.hangStream = true;
    for await (const _ of await hub.gateway.stream({ model: 'm', messages: hi, trace: false })) break;
    await hub.gateway.close();
    expect(rec.spans).toHaveLength(0);
  });
});

// ── 7. PR #613 review, second pass (2026-10-17) ──────────────────────────
//
// One test per finding that applies to this SDK. Each failed before its fix.

function spanPayload(name: string, parentSpanId?: string): IngestSpan {
  return {
    spanId: randomUUID(), name, kind: 'tool', status: 'ok',
    startTime: '2026-10-17T00:00:00Z', endTime: '2026-10-17T00:00:01Z',
    ...(parentSpanId ? { parentSpanId } : {}),
  };
}

describe('PR #613 review, second pass', () => {
  it('keeps a call on another client inside a step on its own client', async () => {
    const a = await setup();
    const b = await setup();
    let aTrace = '';
    await a.hub.traces.step('handle', async (step) => {
      aTrace = step.traceId;
      await b.hub.gateway.chat({ model: 'm', messages: hi, provider: { baseUrl: `${b.rec.base}/provider/v1`, apiKey: 'pk' } });
      await b.hub.gateway.chat({ model: 'm', messages: hi });
    });
    await a.hub.gateway.close();
    await b.hub.gateway.close();
    expect(a.rec.spans.map((s) => s.kind)).toEqual(['chain']);
    expect(b.rec.spans.map((s) => s.kind)).toEqual(['llm']);
    expect(b.rec.traces[0].traceId).not.toBe(aTrace);
    expect(b.rec.gatewayCalls[0].headers['x-trace-id']).not.toBe(aTrace);
    expect(b.rec.gatewayCalls[0].headers['x-parent-span-id']).toBeUndefined();
  });

  it('closes the step of a wrapped generator that is dropped part-way', async () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const { rec, hub } = await setup();
    const retrieve = hub.traces.wrap('retrieve', {}, function* () { yield 'doc-1'; yield 'doc-2'; });
    let traceId = '';
    await hub.traces.step('handle', async (step) => {
      traceId = step.traceId;
      (() => { retrieve().next(); })(); // read one item, then drop it without return()
    });
    for (let n = 0; n < 20 && stepTraceName(traceId) !== undefined; n++) {
      gc();
      await new Promise((r) => setTimeout(r, 10));
    }
    await hub.gateway.close();
    expect(stepTraceName(traceId)).toBeUndefined(); // the root left the map: no leak
    expect(byName(rec.spans, 'retrieve').parentSpanId).toBe(byName(rec.spans, 'handle').spanId);
    expect(rec.rejected).toEqual([]);
  });

  it('caps a huge root step, and the queue does not drop it', async () => {
    const { rec, hub } = await setup();
    await hub.traces.step('batch', async (step) => {
      for (let n = 0; n < 2500; n++) {
        await hub.traces.ingest({ traceId: step.traceId, spans: [spanPayload(`item-${n}`, step.spanId)] }, { wait: false });
      }
    });
    await hub.traces.ingest({ name: 'other', spans: [spanPayload('other')] }, { wait: false });
    await hub.gateway.close();
    expect(byName(rec.spans, 'batch').attributes).toMatchObject({ droppedSpans: 1500 });
    expect(rec.spans.filter((s) => s.name.startsWith('item-'))).toHaveLength(1000);
    expect(rec.rejected).toEqual([]);
  });

  it('flushes a large step tree in linear time', async () => {
    if (stepLimits) stepLimits.maxSpans = 100_000; // above the cap, so the flush is what is measured
    const { rec, hub } = await setup();
    (hub.spanQueue as unknown as { maxQueuedSpans: number }).maxQueuedSpans = 100_000;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let inner!: Promise<void>;
    let before = 0;
    try {
      await hub.traces.step('batch', async (step) => {
        for (let n = 0; n < 3000; n++) {
          await hub.traces.ingest({ traceId: step.traceId, spans: [spanPayload(`a-${n}`, step.spanId)] }, { wait: false });
        }
        // A nested step still open when the root ends keeps its subtree buffered, so the
        // root's flush checks every span against it.
        inner = hub.traces.step('inner', async (child) => {
          for (let n = 0; n < 3000; n++) {
            await hub.traces.ingest({ traceId: step.traceId, spans: [spanPayload(`b-${n}`, child.spanId)] }, { wait: false });
          }
          await held;
        });
        await new Promise((r) => setTimeout(r, 0));
        before = performance.now();
      });
      const rootFlush = performance.now() - before;
      before = performance.now();
      release();
      await inner;
      const lateFlush = performance.now() - before;
      await hub.gateway.close();
      expect(rec.spans).toHaveLength(6002);
      expect(rootFlush).toBeLessThan(250);
      expect(lateFlush).toBeLessThan(250);
    } finally {
      if (stepLimits) stepLimits.maxSpans = 1000;
    }
  }, 60_000);

  it('resolves getByAlias in one request on a server that supports it', async () => {
    const { rec, hub } = await setup({ cacheTtl: 0 });
    rec.aliasEndpoint = true;
    const version = await hub.prompts.getByAlias('triage', 'production');
    expect(version.id).toBe(VERSION_ID);
    expect(rec.getPaths).toEqual(['/api/v1/prompt-versions?name=triage&alias=production']);
    rec.getPaths = [];
    await expect(hub.prompts.getByAlias('triage', 'canary')).rejects.toMatchObject({ statusCode: 404 });
    expect(rec.getPaths).toHaveLength(1); // a real "not found" is final: no fallback scan
  });
});
