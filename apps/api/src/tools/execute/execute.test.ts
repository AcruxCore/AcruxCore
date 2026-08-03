import request from 'supertest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { allowLoopbackForTests, resetSsrfAllowlist } from './safe-fetch';
import { signupTestUserWithApiKey } from '../../test-utils';

const app = createApp();
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let bodyRaw = '';
    req.on('data', (c) => (bodyRaw += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          ok: true,
          received: bodyRaw ? JSON.parse(bodyRaw) : null,
          header: req.headers['x-api-key'] ?? null,
          // Reflect the parsed query string back so tests can assert what actually
          // reached the wire (used by the {{arg.NAME}} templating tests).
          query: Object.fromEntries(new URL(req.url ?? '/', 'http://localhost').searchParams),
          data: { tempC: 18 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
  allowLoopbackForTests(); // in-process test-only seam; production never opens it
});
afterAll(async () => {
  resetSsrfAllowlist();
  await new Promise<void>((r) => server.close(() => r()));
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE secrets, span_payloads, spans, traces, tool_aliases, tool_versions, tools, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
});

// NOTE on transform strings below: `compileTransform`/`evaluateTransform` (Task 3,
// apps/api/src/tools/execute/js-transform.ts) require a full `function transform(input) { ... }`
// declaration — the wrapper appends a bare `transform(input);` call after the supplied source, it
// does not treat the source as an expression body. requestTransform receives the raw tool
// `arguments` object as `input`; responseTransform receives `{ status, headers, body }` as `input`.

describe('POST /tools/:id/execute', () => {
  it('applies request+response transforms and returns the transformed result', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const t = await request(app)
      .post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'get_weather' })
      .expect(201);
    await request(app)
      .post(`/api/v1/tools/${t.body.id}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        parametersSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        executor: {
          type: 'http',
          url: `${baseUrl}/weather`,
          method: 'POST',
          requestTransform: 'function transform(input) { return { q: input.city }; }', // body = { q: <city> }
          responseTransform: 'function transform(input) { return input.body.received; }',
        },
      })
      .expect(201);
    const res = await request(app)
      .post(`/api/v1/tools/${t.body.id}/execute`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ arguments: { city: 'Paris' } })
      .expect(200);
    expect(res.body.result).toEqual({ q: 'Paris' }); // server echoed the transformed body back under received
    expect(res.body.toolVersionId).toBeDefined();

    // Assert the `tool` span was actually recorded (attributes.transformApplied = true,
    // since both requestTransform and responseTransform ran on this call).
    const span = await prisma.span.findFirst({ where: { kind: 'tool', name: 'get_weather' } });
    expect(span).not.toBeNull();
    expect(span?.status).toBe('ok');
    expect(span?.attributes).toMatchObject({
      toolVersionId: res.body.toolVersionId,
      executorType: 'http',
      transformApplied: true,
    });
    const payload = await prisma.spanPayload.findFirst({ where: { spanId: span!.id } });
    expect(payload?.output).toEqual({ q: 'Paris' });
  });

  it('injects a named secret into a header after the request transform', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    await request(app)
      .post('/api/v1/secrets')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'WKEY', value: 'super-secret-9999' })
      .expect(201);
    const t = await request(app)
      .post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'wx' })
      .expect(201);
    await request(app)
      .post(`/api/v1/tools/${t.body.id}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        parametersSchema: { type: 'object' },
        executor: {
          type: 'http',
          url: `${baseUrl}/w`,
          method: 'GET',
          headers: [{ name: 'X-Api-Key', value: '{{secret.WKEY}}' }],
          responseTransform: 'function transform(input) { return input.body.header; }',
        },
      })
      .expect(201);
    const res = await request(app)
      .post(`/api/v1/tools/${t.body.id}/execute`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ arguments: {} })
      .expect(200);
    expect(res.body.result).toBe('super-secret-9999'); // server saw the decrypted header
  });

  // ── {{arg.NAME}} templating: a model-supplied argument flows into a GET query param ──
  // This is the common case a plain HTTP GET tool needs (e.g. a weather API's ?q=<city>).
  // Without arg templating the query value is a fixed string; here `{{arg.q}}` must be
  // replaced by the caller's argument so the same tool version serves any city.
  it('substitutes a {{arg.NAME}} reference in a query param with the caller argument', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const t = await request(app)
      .post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'weather_q' })
      .expect(201);
    await request(app)
      .post(`/api/v1/tools/${t.body.id}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        parametersSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
        executor: {
          type: 'http',
          url: `${baseUrl}/current`,
          method: 'GET',
          query: [{ name: 'q', value: '{{arg.q}}' }],
          responseTransform: 'function transform(input) { return input.body.query; }',
        },
      })
      .expect(201);

    const paris = await request(app)
      .post(`/api/v1/tools/${t.body.id}/execute`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ arguments: { q: 'Paris' } })
      .expect(200);
    expect(paris.body.result).toEqual({ q: 'Paris' }); // dynamic: the arg reached the wire

    // Same immutable version, different argument → different request.
    const tokyo = await request(app)
      .post(`/api/v1/tools/${t.body.id}/execute`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ arguments: { q: 'Tokyo' } })
      .expect(200);
    expect(tokyo.body.result).toEqual({ q: 'Tokyo' });
  });

  // ── Security: secrets resolve BEFORE args, so a model-controlled argument value can
  // never be re-interpreted as a {{secret.NAME}} reference and exfiltrate a team secret. ──
  it('does not resolve a {{secret.NAME}} reference that arrives via a caller argument', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    await request(app)
      .post('/api/v1/secrets')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'WKEY', value: 'super-secret-9999' })
      .expect(201);
    const t = await request(app)
      .post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'inject_guard' })
      .expect(201);
    await request(app)
      .post(`/api/v1/tools/${t.body.id}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        parametersSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
        executor: {
          type: 'http',
          url: `${baseUrl}/current`,
          method: 'GET',
          query: [{ name: 'q', value: '{{arg.q}}' }],
          responseTransform: 'function transform(input) { return input.body.query; }',
        },
      })
      .expect(201);
    const res = await request(app)
      .post(`/api/v1/tools/${t.body.id}/execute`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ arguments: { q: '{{secret.WKEY}}' } })
      .expect(200);
    // The literal placeholder text is sent — the secret is NOT interpolated.
    expect(res.body.result).toEqual({ q: '{{secret.WKEY}}' });
  });

  it('422s a client-type tool (nothing to execute)', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const t = await request(app)
      .post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'c' })
      .expect(201);
    await request(app)
      .post(`/api/v1/tools/${t.body.id}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ parametersSchema: { type: 'object' }, executor: { type: 'client' } })
      .expect(201);
    const res = await request(app)
      .post(`/api/v1/tools/${t.body.id}/execute`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ arguments: {} })
      .expect(422);
    expect(res.body.error?.code).toBe('NOT_EXECUTABLE');
  });

  it('400s when arguments fail the parametersSchema', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const t = await request(app)
      .post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'req' })
      .expect(201);
    await request(app)
      .post(`/api/v1/tools/${t.body.id}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        parametersSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        executor: { type: 'http', url: `${baseUrl}/w`, method: 'GET' },
      })
      .expect(201);
    await request(app)
      .post(`/api/v1/tools/${t.body.id}/execute`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ arguments: {} })
      .expect(400);
  });

  // ── Required correction 1: String.replace footgun with `$` in a secret value ──
  it('injects a secret value containing "$" literally, not as a replace() pattern', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    // `$&` inside a replacement STRING means "the whole match" to String.replace — if the
    // secret's plaintext were (incorrectly) passed as replace()'s 2nd arg directly, the
    // upstream server would see the placeholder text back (or a mangled value), not the
    // literal secret. A correct implementation uses a replacer FUNCTION, whose return value
    // is always inserted literally.
    const secretValue = 'sk-abc$def$&ghi$$jkl';
    await request(app)
      .post('/api/v1/secrets')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'DOLLARKEY', value: secretValue })
      .expect(201);
    const t = await request(app)
      .post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'dollar_tool' })
      .expect(201);
    await request(app)
      .post(`/api/v1/tools/${t.body.id}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        parametersSchema: { type: 'object' },
        executor: {
          type: 'http',
          url: `${baseUrl}/w`,
          method: 'GET',
          headers: [{ name: 'X-Api-Key', value: '{{secret.DOLLARKEY}}' }],
          responseTransform: 'function transform(input) { return input.body.header; }',
        },
      })
      .expect(201);
    const res = await request(app)
      .post(`/api/v1/tools/${t.body.id}/execute`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ arguments: {} })
      .expect(200);
    expect(res.body.result).toBe(secretValue); // the exact literal value, `$` sequences untouched
  });

  // ── Required correction 2: async-timeout-evasion regression for the JS sandbox ──
  it(
    'fails cleanly and quickly when a transform returns a never-settling Promise (does not hang the request)',
    async () => {
      const { apiKey } = await signupTestUserWithApiKey(app);
      const t = await request(app)
        .post('/api/v1/tools')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ name: 'hangs' })
        .expect(201);
      await request(app)
        .post(`/api/v1/tools/${t.body.id}/versions`)
        .set('Authorization', `Bearer ${apiKey}`)
        .send({
          parametersSchema: { type: 'object' },
          executor: {
            type: 'http',
            url: `${baseUrl}/w`,
            method: 'GET',
            // A requestTransform whose transform() returns a Promise that never settles.
            // If evaluateTransform's timeout only bounds synchronous loops (Task 3's
            // known-untested gap), this call could hang indefinitely instead of failing.
            requestTransform: 'function transform(input) { return new Promise(() => {}); }',
          },
        })
        .expect(201);

      const start = Date.now();
      const res = await request(app)
        .post(`/api/v1/tools/${t.body.id}/execute`)
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ arguments: {} });
      const elapsedMs = Date.now() - start;

      // Must fail (not 2xx) and must return well within the Jest test timeout budget below.
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(elapsedMs).toBeLessThan(8000);
    },
    10000,
  );

  // ── Task 5 gap 1: SSRF guard must actually reject execution end-to-end, not just in
  // safe-fetch's own unit tests. 169.254.169.254 (cloud metadata) is never in the
  // loopback allowlist, so no test seam is involved — this is the real `isBlockedIp` path.
  //
  // TC4 final review Finding 2 added a commit-time SSRF pre-check (versions.test.ts),
  // so `POST /tools/:id/versions` now rejects this URL outright and this test can no
  // longer reach execute-time by going through the commit endpoint. The row is seeded
  // directly via prisma instead, bypassing ToolVersionsService — this faithfully models
  // the scenario the commit-time check is defense-in-depth *for*: a version that was
  // fine when committed but whose target became unsafe by execute time (e.g. a DNS
  // rebind), which the execute-time guard must still catch on its own.
  it('rejects execution against a private/metadata URL (SSRF) even for a version that bypassed the commit-time pre-check', async () => {
    const { apiKey, userId } = await signupTestUserWithApiKey(app);
    const t = await request(app)
      .post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'ssrf' })
      .expect(201);
    // Seeded with the same defaults Zod's HttpExecutorSchema would apply via the commit
    // endpoint (headers/query/argMapping: []) — bypassing the endpoint skips that parsing.
    await prisma.toolVersion.create({
      data: {
        toolId: t.body.id,
        versionNumber: 1,
        parametersSchema: { type: 'object' },
        executor: {
          type: 'http',
          url: 'http://169.254.169.254/latest/meta-data/',
          method: 'GET',
          headers: [],
          query: [],
          argMapping: [],
        },
        createdBy: userId,
      },
    });
    await request(app)
      .post(`/api/v1/tools/${t.body.id}/execute`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ arguments: {}, versionNumber: 1 })
      .expect(400);
  });

  // ── Task 5 gap 2: secret delete-block must be proven with a genuine committed tool
  // version referencing the secret (isReferenced hit), not just Task 1's unit coverage.
  it('blocks deleting a secret referenced by a committed tool version (409)', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const { body: secret } = await request(app)
      .post('/api/v1/secrets')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'REFD', value: 'aaaa0000' })
      .expect(201);
    const t = await request(app)
      .post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'usesecret' })
      .expect(201);
    await request(app)
      .post(`/api/v1/tools/${t.body.id}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        parametersSchema: { type: 'object' },
        executor: {
          type: 'http',
          url: `${baseUrl}/w`,
          method: 'GET',
          headers: [{ name: 'X-K', value: '{{secret.REFD}}' }],
        },
      })
      .expect(201);
    await request(app)
      .delete(`/api/v1/secrets/${secret.id}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(409);
  });
});

describe('POST /tools/:id/execute — traceContext', () => {
  /** Create a tool whose v1 http executor GETs the local test server. */
  async function createHttpTool(apiKey: string, name = 'get_weather'): Promise<string> {
    const t = await request(app)
      .post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name })
      .expect(201);
    await request(app)
      .post(`/api/v1/tools/${t.body.id}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        parametersSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        executor: { type: 'http', url: `${baseUrl}/weather`, method: 'GET' },
      })
      .expect(201);
    return t.body.id;
  }

  it('creates the caller-supplied trace id when no such trace exists yet', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await createHttpTool(apiKey);

    // An agent loop mints one trace id up front. Before this fix the id was
    // dropped and the span was filed under a fresh `tool:get_weather` trace,
    // orphaning it from the run it belonged to.
    const traceId = '7c2f1b90-5d43-4c1e-9a77-1b0e3d5f6a21';
    await request(app)
      .post(`/api/v1/tools/${toolId}/execute`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ arguments: { city: 'Paris' }, traceContext: { traceId } })
      .expect(200);

    const traces = await prisma.trace.findMany();
    expect(traces).toHaveLength(1);
    expect(traces[0].id).toBe(traceId);

    const span = await prisma.span.findFirst({ where: { kind: 'tool' } });
    expect(span?.traceId).toBe(traceId);
  });

  it('appends to an existing trace of the same team, keeping the supplied parent span', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await createHttpTool(apiKey);

    // Seed a trace with one span, the way a gateway completion would.
    const seeded = await request(app)
      .post('/api/v1/traces')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        traces: [
          {
            name: 'weather-tool-agent',
            spans: [
              {
                spanId: 'llm-1',
                name: 'gpt-4o-mini',
                kind: 'llm',
                startTime: '2026-07-27T10:00:00Z',
                endTime: '2026-07-27T10:00:01Z',
              },
            ],
          },
        ],
      })
      .expect(200);
    const traceId = seeded.body.traceIds[0];

    await request(app)
      .post(`/api/v1/tools/${toolId}/execute`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ arguments: { city: 'Paris' }, traceContext: { traceId, parentSpanId: 'llm-1' } })
      .expect(200);

    expect(await prisma.trace.count()).toBe(1);
    const span = await prisma.span.findFirst({ where: { kind: 'tool' } });
    expect(span?.traceId).toBe(traceId);
    expect(span?.parentSpanRef).toBe('llm-1');
  });

  it("never appends to another team's trace — falls back to a fresh one", async () => {
    const teamA = await signupTestUserWithApiKey(app);
    const teamB = await signupTestUserWithApiKey(app);
    const toolId = await createHttpTool(teamB.apiKey, 'get_weather_b');

    const seeded = await request(app)
      .post('/api/v1/traces')
      .set('Authorization', `Bearer ${teamA.apiKey}`)
      .send({
        traces: [
          {
            name: 'team-a-run',
            spans: [
              {
                spanId: 's1',
                name: 'x',
                kind: 'llm',
                startTime: '2026-07-27T10:00:00Z',
                endTime: '2026-07-27T10:00:01Z',
              },
            ],
          },
        ],
      })
      .expect(200);
    const teamATraceId = seeded.body.traceIds[0];

    await request(app)
      .post(`/api/v1/tools/${toolId}/execute`)
      .set('Authorization', `Bearer ${teamB.apiKey}`)
      .send({ arguments: { city: 'Paris' }, traceContext: { traceId: teamATraceId, parentSpanId: 's1' } })
      .expect(200);

    const span = await prisma.span.findFirst({ where: { kind: 'tool' } });
    expect(span).not.toBeNull();
    expect(span?.traceId).not.toBe(teamATraceId); // never crosses the tenant boundary
    expect(span?.parentSpanRef).toBeNull(); // the parent belonged to the refused trace
    // Team A's trace is untouched: still exactly its one seeded span.
    const teamATrace = await prisma.trace.findUnique({ where: { id: teamATraceId } });
    expect(teamATrace?.spanCount).toBe(1);
  });
});
