import request from 'supertest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../../app';
import { authedAgent, type AuthedAgent } from '../../test-utils/auth';

/**
 * A team-supplied `base_url` is checked where it is used, not only where it is saved.
 *
 * `isBlockedUrlLiteral` — the check the connection schema runs — deliberately passes
 * any hostname, because resolving one would need DNS and a Zod `.refine()` is
 * synchronous. Its docstring says so, and says the real boundary is the guard applied
 * at the moment of the request. Nothing proved that end to end: `safe-fetch.test.ts`
 * covers the guard as a unit, and `guarded-fetch.test.ts` covers deadlines, so between
 * them a base URL could have been accepted at save time and reached at call time
 * without a single test noticing.
 *
 * This drives the whole gateway — connection, model, virtual key, completion — with a
 * base URL that is a hostname at save time and a loopback address at call time. Which
 * is not a contrived case: it is what a hostname pointed at an internal service looks
 * like, and what DNS rebinding produces on purpose.
 */

const app = createApp();
jest.setTimeout(120_000);

describe('a base_url is guarded at request time, not only at save time', () => {
  let team: AuthedAgent;
  let virtualKey: string;
  /** Status of the save in beforeAll, asserted by the first test. */
  let saveStatus: number;
  /** A real local listener, so a call that got through would visibly succeed. */
  let internal: { url: string; close: () => Promise<void>; hits: number };

  beforeAll(async () => {
    const server = http.createServer((_req, res) => {
      internal.hits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'reached' } }] }));
    });
    // Bound on every interface, not just 127.0.0.1. `localhost` resolves to ::1
    // first on this platform, and the guard pins the first candidate — so a
    // listener on 127.0.0.1 alone would refuse the connection by itself, and
    // `hits === 0` below would hold whether the guard worked or not.
    const url = await new Promise<string>((resolve) => {
      server.listen(0, () => resolve(`http://localhost:${(server.address() as AddressInfo).port}/v1`));
    });
    internal = {
      url,
      hits: 0,
      close: () =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    };
    // Positive control: the address the gateway is about to be pointed at really
    // does answer, and the counter really does count. Without this, `hits === 0`
    // is a statement about a listener nobody could have reached.
    await fetch(internal.url);
    expect(internal.hits).toBe(1);
    internal.hits = 0;

    team = await authedAgent(app);

    // Arranged here rather than in the first test: the completion below needs a
    // virtual key, and a test that only works when the one above it ran first
    // sends a debugger somewhere the guard has nothing to do with.
    const connection = await team.agent.post('/api/v1/gateway/connections/').send({
      provider: 'openai_compatible',
      label: 'internal-service',
      apiKey: 'sk-not-a-real-key',
      config: { base_url: internal.url },
    });
    saveStatus = connection.status;
    if (saveStatus !== 201) return;

    await team.agent
      .post('/api/v1/gateway/models/')
      .send({ publicName: 'internal-model', upstreamModel: 'gpt-4o-mini', credentialId: connection.body.id })
      .expect(201);
    const key = await team.agent.post('/api/v1/gateway/keys').send({ name: 'ssrf-probe' }).expect(201);
    virtualKey = key.body.key;
  });

  afterAll(async () => {
    await internal.close();
  });

  it('saves a hostname base_url, because the schema check cannot resolve one', () => {
    // `localhost` is a hostname, so `net.isIP` says no and the literal check passes it
    // through. This assertion is the premise of the next one — if a future change made
    // the schema reject it, the request-time test below would pass for the wrong reason.
    expect(saveStatus).toBe(201);
    expect(internal.url).toMatch(/^http:\/\/localhost:/);
  });

  it('blocks the call once the hostname resolves to a loopback address', async () => {
    const res = await request(app)
      .post('/api/v1/gateway/chat/completions')
      .set('Authorization', `Bearer ${virtualKey}`)
      .send({ model: 'internal-model', messages: [{ role: 'user', content: 'hello' }] });

    expect(res.status).toBe(502);
    // A code of its own, not the catch-all `PROVIDER_ERROR`: this is a fault in the
    // team's own connection, which they can fix, and every other such case in
    // `mapProviderError` is already told apart from an upstream having a bad day.
    expect(res.body.error.code).toBe('PROVIDER_ADDRESS_BLOCKED');
    // The one assertion a status code cannot make: the internal service was never
    // spoken to. A guard that rejected the response rather than the connection would
    // still have delivered the request.
    expect(internal.hits).toBe(0);
    // And the message names no address, so a caller cannot use the gateway to map
    // which internal hosts answer.
    expect(res.body.error.message).not.toContain('127.0.0.1');
    expect(res.body.error.message).not.toContain('localhost');
  });
});
