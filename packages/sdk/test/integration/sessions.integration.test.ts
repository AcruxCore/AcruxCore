import { acruxcore } from '../../src/client';
import prisma from '../../../../apps/api/src/shared/db/client';
import { signupTestUserWithApiKey } from '../../../../apps/api/src/test-utils/auth';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createApp } = require('../../../../apps/api/app');

const app = createApp();

/**
 * `hub.sessions` against the real API + real Postgres. Same real-flow-first
 * harness as `traces-analytics.integration.test.ts` — a real Express app
 * in-process, a real `fetch`-based `acruxcore` client on a real loopback port,
 * seeded via the SDK's own `trace()`.
 */

async function setupUserAndKey(): Promise<{ apiKey: string }> {
  const ctx = await signupTestUserWithApiKey(app);
  return { apiKey: ctx.apiKey };
}

async function startServer(): Promise<{ hub: (apiKey: string) => acruxcore; close: () => Promise<void> }> {
  const http = await import('http');
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  return {
    hub: (apiKey: string) => new acruxcore({ apiKey, baseUrl: `http://localhost:${port}/api/v1`, maxRetries: 0 }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE
    trace_feedback, span_payloads, spans, traces, team_trace_settings,
    prompt_aliases, prompt_versions, audit_log, prompts,
    api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('acruxcore SDK — hub.sessions', () => {
  it('lists sessions and reads one back with its traces; an unknown session 404s', async () => {
    const { apiKey } = await setupUserAndKey();
    const { hub: makeHub, close } = await startServer();
    const hub = makeHub(apiKey);

    const now = new Date().toISOString();
    const sessionIdA = `sess-alpha-${Date.now()}`;
    const sessionIdB = `sess-beta-${Date.now()}`;

    const { traceId: traceIdA } = await hub.traces.ingest({
      sessionId: sessionIdA,
      name: 'alpha-run',
      tags: ['support'],
      spans: [
        {
          spanId: 'a1',
          name: 'gpt-4o-mini',
          kind: 'llm',
          status: 'ok',
          startTime: now,
          endTime: now,
          model: 'gpt-4o-mini',
          usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
          costUsd: 0.001,
        },
      ],
    });

    await hub.traces.ingest({
      sessionId: sessionIdB,
      name: 'beta-run',
      spans: [
        {
          spanId: 'b1',
          name: 'claude-sonnet-5',
          kind: 'llm',
          status: 'error',
          startTime: now,
          endTime: now,
          model: 'claude-sonnet-5',
        },
      ],
    });

    // Both sessions appear in the list.
    const list = await hub.sessions.list();
    expect(list.total).toBe(2);
    expect(list.data.map((s) => s.sessionId).sort()).toEqual([sessionIdA, sessionIdB].sort());

    // One session's detail — summary plus its traces.
    const detail = await hub.sessions.get(sessionIdA);
    expect(detail.session.sessionId).toBe(sessionIdA);
    expect(detail.session.traceCount).toBe(1);
    expect(detail.traces).toHaveLength(1);
    expect(detail.traces[0]).toMatchObject({
      id: traceIdA,
      sessionId: sessionIdA,
      tags: ['support'],
    });

    // An unknown session id 404s.
    await expect(hub.sessions.get('does-not-exist')).rejects.toMatchObject({
      code: 'API_ERROR',
      statusCode: 404,
    });

    await close();
  });
});
