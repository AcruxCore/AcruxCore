import request from 'supertest';
import { acruxcore } from '../../src/client';
import prisma from '../../../../apps/api/src/shared/db/client';
import { signupTestUserWithApiKey } from '../../../../apps/api/src/test-utils/auth';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createApp } = require('../../../../apps/api/app');

const app = createApp();

/**
 * Real-flow vs. fallback boundary (issue #88, same convention as
 * `tools.integration.test.ts`): `submitFeedback`, `updateFeedback`, `getTrace`,
 * and `listTraces` don't touch the gateway/provider adapter, so they get full
 * real-flow coverage here (real HTTP → real Postgres). `chat()`/`runToolLoop`'s
 * gateway round-trip and streaming parser are unit-covered with a mocked `fetch`
 * in `test/unit/client.test.ts` instead — a live test would need to mock
 * `global.fetch` for the provider adapter's outbound call, which collides with
 * the SDK's own `fetch` call to the local test server in the same process
 * (both share one global `fetch`), so it isn't a straightforward extension of
 * this file's real-HTTP-server pattern.
 */

/**
 * Signs up a real user and mints a personal API key.
 *
 * Delegates to apps/api's own `signupTestUserWithApiKey` rather than posting to an auth
 * endpoint directly. These suites used to hard-code `/api/v1/auth/signup`, which stopped
 * existing when auth moved to Better Auth — every test 404'd at setup. Sharing the
 * fixture means the next auth change fixes these suites for free.
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
    span_payloads, spans, traces, team_trace_settings,
    prompt_aliases, prompt_versions, audit_log, prompts,
    api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('acruxcore SDK — feedback + trace read-back', () => {
  it('submits feedback, edits it, reads it back via getTrace, and lists it via listTraces', async () => {
    const { apiKey } = await setupUserAndKey();
    const { hub: makeHub, close } = await startServer();
    const hub = makeHub(apiKey);

    const { traceId } = await hub.traces.ingest({
      name: 'feedback-target-run',
      spans: [
        {
          spanId: 's1', name: 'gpt-4o-mini', kind: 'llm',
          startTime: '2026-07-13T10:00:00.000Z', endTime: '2026-07-13T10:00:01.000Z',
          model: 'gpt-4o-mini', usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
        },
      ],
    });

    const feedback = await hub.traces.submitFeedback({ traceId, rating: -1, label: 'wrong_answer', comment: 'Missed the point.' });
    expect(feedback.traceId).toBe(traceId);
    expect(feedback.rating).toBe(-1);
    expect(feedback.spanId).toBeNull();

    const updated = await hub.traces.updateFeedback({ traceId, feedbackId: feedback.id, rating: 1 });
    expect(updated.rating).toBe(1);
    expect(updated.label).toBe('wrong_answer'); // omitted field keeps its value

    const detail = await hub.traces.get(traceId);
    expect(detail.trace.id).toBe(traceId);
    expect(detail.spans).toHaveLength(1);
    expect(detail.spans[0].spanId).toBe('s1');
    expect(detail.spans[0].model).toBe('gpt-4o-mini');

    const list = await hub.traces.list({ sessionId: undefined, limit: 10 });
    expect(list.data.some((t) => t.id === traceId)).toBe(true);

    await close();
  });

  it('span-level feedback carries the spanId through', async () => {
    const { apiKey } = await setupUserAndKey();
    const { hub: makeHub, close } = await startServer();
    const hub = makeHub(apiKey);

    const { traceId } = await hub.traces.ingest({
      name: 'span-feedback-run',
      spans: [{ spanId: 's1', name: 'gpt-4o-mini', kind: 'llm', startTime: '2026-07-13T10:00:00.000Z' }],
    });

    const feedback = await hub.traces.submitFeedback({ traceId, spanId: 's1', rating: 5 });
    expect(feedback.spanId).toBe('s1');

    await close();
  });
});
