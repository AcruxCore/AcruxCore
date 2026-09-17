import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../../app';
import { authedAgent, type AuthedAgent } from '../../test-utils/auth';
import prisma from '../../shared/db/client';
import { allowLoopbackForTests, resetSsrfAllowlist } from '../../tools/execute/safe-fetch';

/**
 * A stored credential goes out to the upstream it was stored for, and nowhere else.
 *
 * Three kinds of plaintext exist in this system: a provider connection's API key, a
 * team `Secret` injected into a tool's headers, and a virtual key shown once at
 * creation. Each is encrypted or hashed at rest, and each is decrypted at some point
 * in order to be used — so the question is not whether the column is safe but whether
 * the plaintext ever lands somewhere it is read back: an HTTP response, a span
 * payload, an audit row, an error message.
 *
 * Every one of those is a SILENT failure. An unredacted secret still returns 200, and
 * the suite's ordinary assertions check what a response contains, never what it must
 * not. So this plants one distinctive string as each kind of credential, drives every
 * path that handles it, and searches the result for that string.
 *
 * The upstream below deliberately does NOT echo the header it receives. A tool result
 * legitimately contains whatever the upstream chose to return, so an echoing upstream
 * would report its own reply as our leak — which it did, on the first pass of this
 * sweep, and is worth not re-learning.
 */

const app = createApp();
jest.setTimeout(180_000);

/** Distinctive enough that a match is never a coincidence. */
const CANARY = 'CANARY-PLAINTEXT-9f3a1b7c2d';

/**
 * Renders a value as text a plaintext search can actually match.
 *
 * `JSON.stringify` turns a Prisma `Bytes` column into a map of digits
 * (`{"0":67,"1":65,…}`), so searching the JSON of a row can never match a
 * credential stored in one — the assertion reads as a check on the ciphertext
 * while proving nothing. Every byte array is decoded to text first.
 */
function searchable(blob: unknown, depth = 0): string {
  if (depth > 8) return '';
  if (typeof blob === 'string') return blob;
  if (blob instanceof Uint8Array) return Buffer.from(blob).toString('latin1');
  if (Array.isArray(blob)) return blob.map((v) => searchable(v, depth + 1)).join(' ');
  if (blob && typeof blob === 'object') {
    return Object.entries(blob as Record<string, unknown>)
      .map(([k, v]) => `${k}=${searchable(v, depth + 1)}`)
      .join(' ');
  }
  return String(blob);
}

/** Asserts a value carries no plaintext credential, bytes included. */
function expectNoCanary(what: string, blob: unknown): void {
  const text = searchable(blob);
  if (text.includes(CANARY)) {
    throw new Error(`${what} carries a decrypted credential: ${text.slice(0, 400)}`);
  }
}

describe('a decrypted credential never comes back out', () => {
  let team: AuthedAgent;
  let toolId: string;
  let upstream: { port: number; close: () => Promise<void>; sawHeader: string | undefined };

  beforeAll(async () => {
    // Declared before `listen`, so the handler never reads a `upstream` that
    // `beforeAll` has not assigned yet.
    upstream = { port: 0, sawHeader: undefined, close: async () => {} };
    const server = http.createServer((req, res) => {
      // Recorded, never echoed — the request header is the one place the secret is
      // MEANT to be, and asserting it arrived is how we know the test proved anything.
      upstream.sawHeader = req.headers['x-api-key'] as string | undefined;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
    upstream = {
      port,
      sawHeader: upstream.sawHeader,
      close: () =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    };

    team = await authedAgent(app);
    allowLoopbackForTests();

    await team.agent
      .post('/api/v1/secrets/')
      .send({ name: 'CANARY_SECRET', value: CANARY })
      .expect(201);
    const tool = await team.agent.post('/api/v1/tools').send({ name: 'canary_tool' }).expect(201);
    toolId = tool.body.id;
    await team.agent
      .post(`/api/v1/tools/${toolId}/versions`)
      .send({
        parametersSchema: { type: 'object', properties: { q: { type: 'string' } } },
        executor: {
          type: 'http',
          method: 'POST',
          url: `http://127.0.0.1:${port}/call`,
          headers: [{ name: 'X-Api-Key', value: '{{secret.CANARY_SECRET}}' }],
        },
      })
      .expect(201);
    await team.agent
      .post(`/api/v1/tools/${toolId}/aliases/production/promote`)
      .send({ version_number: 1 })
      .expect(200);
  });

  afterAll(async () => {
    resetSsrfAllowlist();
    await upstream.close();
  });

  it('never returns a provider connection’s API key, however it is asked for', async () => {
    const created = await team.agent
      .post('/api/v1/gateway/connections/')
      .send({ provider: 'openai', label: 'canary-connection', apiKey: `sk-${CANARY}` })
      .expect(201);

    expectNoCanary('POST /gateway/connections', created.body);
    expectNoCanary(
      'GET /gateway/connections/:id',
      (await team.agent.get(`/api/v1/gateway/connections/${created.body.id}`).expect(200)).body,
    );
    expectNoCanary(
      'GET /gateway/connections',
      (await team.agent.get('/api/v1/gateway/connections/').expect(200)).body,
    );
    // The stored column is ciphertext, so a plaintext match here would mean the
    // encryption itself had been skipped rather than the response leaking.
    expectNoCanary(
      'the provider_connections row',
      await prisma.providerConnection.findMany({ where: { teamId: team.teamId } }),
    );
  });

  it('never returns a team secret’s value', async () => {
    expectNoCanary('GET /secrets', (await team.agent.get('/api/v1/secrets/').expect(200)).body);
    expectNoCanary(
      'the secrets row',
      await prisma.secret.findMany({ where: { teamId: team.teamId } }),
    );
  });

  it('sends an injected secret upstream and records it in no span, result or audit row', async () => {
    const exec = await team.agent
      .post(`/api/v1/tools/${toolId}/execute`)
      .send({ arguments: { q: 'hello' } })
      .expect(200);

    // The secret must actually have been resolved and sent, or everything below is
    // green because nothing happened.
    expect(upstream.sawHeader).toBe(CANARY);

    expectNoCanary('POST /tools/:id/execute', exec.body);

    const spans = await prisma.span.findMany({
      // Team-scoped: without it the positive control below is satisfied by a row
      // this same suite left behind on an earlier run, so a regression in span
      // writing would still read as green on a database that is not empty.
      where: { teamId: team.teamId, name: { contains: 'canary_tool' } },
      select: {
        name: true,
        attributes: true,
        errorMessage: true,
        payload: { select: { input: true, output: true } },
      },
    });
    // The execution is what this test drives, so its span must exist — otherwise
    // "no secret in the spans" is a statement about an empty list.
    expect(spans.length).toBeGreaterThan(0);
    expectNoCanary('the tool-execute span and its payload', spans);

    const audit = await prisma.auditLog.findMany({
      where: { teamId: team.teamId },
      select: { event: true, metadata: true },
    });
    expect(audit.length).toBeGreaterThan(0);
    expectNoCanary('the audit trail', audit);
  });

  it('does not put a secret into the error a failing upstream produces', async () => {
    // An error path is where a URL or a header bag most often gets stringified
    // wholesale, and this tool's secret rides in a header.
    const failing = await team.agent.post('/api/v1/tools').send({ name: 'canary_fail' }).expect(201);
    await team.agent
      .post(`/api/v1/tools/${failing.body.id}/versions`)
      .send({
        parametersSchema: { type: 'object', properties: {} },
        executor: {
          type: 'http',
          method: 'GET',
          // A port nothing is listening on: the connection is refused, so the failure
          // is produced by our own code rather than by an upstream's response body.
          url: `http://127.0.0.1:${upstream.port + 1}/nope`,
          query: [{ name: 'apikey', value: '{{secret.CANARY_SECRET}}' }],
        },
      })
      .expect(201);
    await team.agent
      .post(`/api/v1/tools/${failing.body.id}/aliases/production/promote`)
      .send({ version_number: 1 })
      .expect(200);

    const res = await team.agent.post(`/api/v1/tools/${failing.body.id}/execute`).send({ arguments: {} });
    // The port is one the kernel has not handed out, but "probably free" is not a
    // guarantee — and if something were listening, this test would report "no
    // secret in an upstream failure" having produced no failure at all.
    expect(`${res.status} ${JSON.stringify(res.body)}`).toContain('request failed');
    expectNoCanary(`the failure response (status ${res.status})`, res.body);

    const spans = await prisma.span.findMany({
      where: { teamId: team.teamId, name: { contains: 'canary_fail' } },
      select: { attributes: true, errorMessage: true, payload: { select: { input: true, output: true } } },
    });
    expect(spans.length).toBeGreaterThan(0);
    expectNoCanary('the failed execution’s span', spans);
  });
});
