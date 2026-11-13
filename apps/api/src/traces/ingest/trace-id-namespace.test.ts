import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';
import { allowLoopbackForTests, resetSsrfAllowlist } from '../../tools/execute/safe-fetch';

/**
 * A trace id is chosen by the caller, so it names a trace only within the caller's team.
 * These tests claim an id in team A first and then report the same id from team B on every
 * path a client can use: B must get its own trace, readable by the id it sent, and A's
 * trace must stay A's.
 */

const app = createApp();

let server: http.Server;
let origin: string;

beforeAll(async () => {
  allowLoopbackForTests();
  // A fake OpenAI-compatible upstream, so the gateway path runs without a paid provider.
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as { model: string };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'gen-1',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
      );
    });
  });
  // `localhost`, not 127.0.0.1: the connection schema refuses a literal loopback IP.
  await new Promise<void>((resolve) => server.listen(0, resolve));
  origin = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  resetSsrfAllowlist();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

/** One native-ingest trace with a single span named `spanName`. */
function nativeTrace(traceId: string, name: string, spanName: string) {
  return {
    traceId,
    name,
    spans: [{ spanId: `${spanName}-1`, name: spanName, startTime: new Date().toISOString() }],
  };
}

/** One OTLP/JSON trace (one span) for `traceIdHex`. */
function otlpSpan(traceIdHex: string, name: string) {
  return {
    traceId: traceIdHex,
    spanId: randomBytes(8).toString('hex'),
    name,
    startTimeUnixNano: `${Date.now()}000000`,
    attributes: [{ key: 'openinference.span.kind', value: { stringValue: 'AGENT' } }],
  };
}

/** The UUID form AcruxCore stores an OTel 32-hex trace id under. */
function hexToUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Team A claims `traceId` first with one span named `a-secret-step`. */
async function claimInTeamA(traceId: string) {
  const a = await authedAgent(app);
  await a.agent
    .post('/api/v1/traces')
    .send({ traces: [nativeTrace(traceId, 'team-a-run', 'a-secret-step')] })
    .expect(200);
  return a;
}

/** Asserts team A's trace `traceId` is exactly as A left it: its own name and one span. */
async function expectTeamATraceUnchanged(a: Awaited<ReturnType<typeof claimInTeamA>>, traceId: string) {
  const row = await prisma.trace.findUniqueOrThrow({ where: { id: traceId } });
  expect(row.teamId).toBe(a.teamId);
  expect(row.name).toBe('team-a-run');
  expect(row.spanCount).toBe(1);
  const read = await a.agent.get(`/api/v1/traces/${traceId}`).expect(200);
  expect(read.body.spans.map((s: { name: string }) => s.name)).toEqual(['a-secret-step']);
}

describe('a caller-chosen trace id is scoped to the caller’s team', () => {
  it('native ingest: team B gets its own trace for an id team A already holds', async () => {
    const traceId = randomUUID();
    const a = await claimInTeamA(traceId);
    const b = await authedAgent(app);

    const res = await b.agent
      .post('/api/v1/traces')
      .send({ traces: [nativeTrace(traceId, 'team-b-run', 'b-step')] })
      .expect(200);
    expect(res.body.accepted).toBe(1);

    // A second batch for the same id joins B's trace rather than opening another one.
    await b.agent
      .post('/api/v1/traces')
      .send({ traces: [nativeTrace(traceId, 'team-b-run', 'b-step-2')] })
      .expect(200);

    const read = await b.agent.get(`/api/v1/traces/${traceId}`).expect(200);
    expect(read.body.trace.name).toBe('team-b-run');
    expect(read.body.spans.map((s: { name: string }) => s.name).sort()).toEqual(['b-step', 'b-step-2']);
    expect(JSON.stringify(read.body)).not.toContain('a-secret-step');

    // Feedback by the id B sent lands on B's trace.
    await b.agent.post(`/api/v1/traces/${traceId}/feedback`).send({ rating: 1 }).expect(201);
    const feedback = await b.agent.get(`/api/v1/traces/${traceId}/feedback`).expect(200);
    expect(feedback.body.data).toHaveLength(1);
    const aFeedback = await a.agent.get(`/api/v1/traces/${traceId}/feedback`).expect(200);
    expect(aFeedback.body.data).toEqual([]);

    expect(await prisma.trace.count({ where: { teamId: b.teamId } })).toBe(1);
    await expectTeamATraceUnchanged(a, traceId);
  });

  it('OTLP: an export [X, Y] stores both traces for team B even though team A holds X', async () => {
    const xHex = randomBytes(16).toString('hex');
    const yHex = randomBytes(16).toString('hex');
    const a = await claimInTeamA(hexToUuid(xHex));
    const b = await authedAgent(app);

    await b.agent
      .post('/api/v1/traces/otlp')
      .set('Content-Type', 'application/json')
      .send({
        resourceSpans: [
          {
            resource: { attributes: [] },
            scopeSpans: [{ spans: [otlpSpan(xHex, 'b-otel-x'), otlpSpan(yHex, 'b-otel-y')] }],
          },
        ],
      })
      .expect(200);

    const x = await b.agent.get(`/api/v1/traces/${hexToUuid(xHex)}`).expect(200);
    expect(x.body.spans.map((s: { name: string }) => s.name)).toEqual(['b-otel-x']);
    const y = await b.agent.get(`/api/v1/traces/${hexToUuid(yHex)}`).expect(200);
    expect(y.body.spans.map((s: { name: string }) => s.name)).toEqual(['b-otel-y']);
    expect(await prisma.trace.count({ where: { teamId: b.teamId } })).toBe(2);

    await expectTeamATraceUnchanged(a, hexToUuid(xHex));
  });

  it('gateway x-trace-id: team B’s gateway call and its own report share one trace', async () => {
    const traceId = randomUUID();
    const a = await claimInTeamA(traceId);
    const b = await authedAgent(app);
    const conn = await b.agent
      .post('/api/v1/gateway/connections')
      .send({
        provider: 'openai_compatible',
        label: 'fake',
        apiKey: 'sk-fake-00000000000AB12',
        config: { base_url: `${origin}/v1` },
      })
      .expect(201);
    await b.agent
      .post('/api/v1/gateway/models')
      .send({ publicName: 'pong', upstreamModel: 'pong-1', credentialId: conn.body.id, inputPricePerM: 1, outputPricePerM: 1 })
      .expect(201);

    await b.agent
      .post('/api/v1/gateway/chat/completions')
      .set('x-trace-id', traceId)
      .send({ model: 'pong', messages: [{ role: 'user', content: 'ping' }] })
      .expect(200);
    await b.agent
      .post('/api/v1/traces')
      .send({ traces: [nativeTrace(traceId, 'team-b-run', 'b-step')] })
      .expect(200);

    const read = await b.agent.get(`/api/v1/traces/${traceId}`).expect(200);
    const kinds = read.body.spans.map((s: { kind: string }) => s.kind).sort();
    expect(kinds).toEqual(['llm', 'other']);
    expect(await prisma.trace.count({ where: { teamId: b.teamId } })).toBe(1);

    await expectTeamATraceUnchanged(a, traceId);
  });

  it('team B cannot read team A’s trace by its id, and A cannot read B’s', async () => {
    const traceId = randomUUID();
    const a = await claimInTeamA(traceId);
    const b = await authedAgent(app);

    // Before B reports anything under the id, it is simply not found for B.
    await b.agent.get(`/api/v1/traces/${traceId}`).expect(404);

    await b.agent
      .post('/api/v1/traces')
      .send({ traces: [nativeTrace(traceId, 'team-b-run', 'b-step')] })
      .expect(200);
    const bRow = await prisma.trace.findFirstOrThrow({ where: { teamId: b.teamId } });
    // B's trace has its own key, so A reading B's key finds nothing.
    await a.agent.get(`/api/v1/traces/${bRow.id}`).expect(404);
    await expectTeamATraceUnchanged(a, traceId);
  });
});
