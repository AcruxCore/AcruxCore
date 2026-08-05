import request from 'supertest';
import { acruxcore } from '../../src/client';
import prisma from '../../../../apps/api/src/shared/db/client';
import { signupTestUserWithApiKey } from '../../../../apps/api/src/test-utils/auth';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createApp } = require('../../../../apps/api/app');

const app = createApp();

/**
 * `hub.traces` — analytics, facet discovery, settings, and feedback summary/list —
 * against the real API + real Postgres. Same real-flow-first harness as
 * `feedback-and-trace-read.integration.test.ts`: a real Express app in-process, a
 * real `fetch`-based `acruxcore` client on a real loopback port (these namespace
 * calls go through `_request` → `fetch`, not supertest's `request(app)` wrapper),
 * seeded via the SDK's own `trace()` (there is no namespace-level ingest wrapper
 * for arbitrary spans, and `trace()` posts to the same `/traces` endpoint a raw
 * `POST` would).
 */

async function setupUserAndKey(): Promise<{ apiKey: string; cookie: string; teamId: string }> {
  const ctx = await signupTestUserWithApiKey(app);
  return { apiKey: ctx.apiKey, cookie: ctx.cookie, teamId: ctx.teamId };
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

describe('acruxcore SDK — hub.traces', () => {
  it('analytics, facets, settings, and feedback summary/list all read back what was ingested', async () => {
    const { apiKey } = await setupUserAndKey();
    const { hub: makeHub, close } = await startServer();
    const hub = makeHub(apiKey);

    const now = new Date().toISOString();

    // Two traces, different sessions, different models, one erroring, distinct
    // tags, and a shared metadata key with distinct values.
    const { traceId: traceIdA } = await hub.traces.ingest({
      sessionId: `sess-alpha-${Date.now()}`,
      name: 'alpha-run',
      tags: ['support'],
      metadata: { region: 'us-east' },
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
        },
      ],
    });

    const { traceId: traceIdB } = await hub.traces.ingest({
      sessionId: `sess-beta-${Date.now()}`,
      name: 'beta-run',
      tags: ['escalation'],
      metadata: { region: 'eu-west' },
      spans: [
        {
          spanId: 'b1',
          name: 'claude-sonnet-5',
          kind: 'llm',
          status: 'error',
          startTime: now,
          endTime: now,
          model: 'claude-sonnet-5',
          usage: { promptTokens: 40, completionTokens: 5, totalTokens: 45 },
          error: 'upstream 500',
        },
      ],
    });

    // 2. Default analytics — one span each, so requests == 2 spans total.
    const totals = await hub.traces.analytics();
    expect(totals.totals.requests).toBe(2);

    // 3. Grouped by model — one bucket per model, with per-model metrics.
    const byModel = await hub.traces.analytics({ groupBy: 'model' });
    expect(byModel.groupBy).toBe('model');
    expect(byModel.buckets).toHaveLength(2);
    const alphaBucket = byModel.buckets.find((b) => b.key === 'gpt-4o-mini');
    const betaBucket = byModel.buckets.find((b) => b.key === 'claude-sonnet-5');
    expect(alphaBucket).toMatchObject({ requests: 1, errorRate: 0 });
    expect(betaBucket).toMatchObject({ requests: 1, errorRate: 1 });

    // 4. Facets — the seeded tags and metadata key appear.
    const facets = await hub.traces.listFacets();
    expect(facets.tags.sort()).toEqual(['escalation', 'support']);
    expect(facets.metadataKeys).toEqual(['region']);

    // 5. Facet values — the seeded values for that metadata key.
    const values = await hub.traces.getFacetValues('region');
    expect(values.values.sort()).toEqual(['eu-west', 'us-east']);

    // 6. Settings default — fresh test team, never written.
    const defaultSettings = await hub.traces.getSettings();
    expect(defaultSettings).toEqual({ capturePayloads: true, updatedAt: null });

    // 7. Update settings, then confirm it persisted on a second read.
    const updated = await hub.traces.updateSettings(false);
    expect(updated.capturePayloads).toBe(false);
    expect(updated.updatedAt).not.toBeNull();
    const reread = await hub.traces.getSettings();
    expect(reread).toEqual({ capturePayloads: false, updatedAt: updated.updatedAt });

    // 8. Attach feedback, then read it back three ways.
    const feedback = await hub.traces.submitFeedback({ traceId: traceIdA, rating: 5 });

    const summary = await hub.traces.getFeedbackSummary({ groupBy: 'model' });
    expect(summary.groupBy).toBe('model');
    expect(summary.buckets).toEqual([{ key: 'gpt-4o-mini', count: 1, avgRating: 5, downCount: 0 }]);

    const list = await hub.traces.listFeedback();
    expect(list.total).toBe(1);
    expect(list.data).toHaveLength(1);
    expect(list.data[0].id).toBe(feedback.id);

    const traceFeedback = await hub.traces.getTraceFeedback(traceIdA);
    expect(traceFeedback.data).toHaveLength(1);
    expect(traceFeedback.data[0].id).toBe(feedback.id);
    // Unpaginated envelope — no total/page/limit, unlike listFeedback's.
    expect(traceFeedback).not.toHaveProperty('total');

    expect(traceIdB).toBeTruthy(); // seeded but only used for the shared assertions above

    await close();
  });

  it('surfaces validation and role errors as API_ERROR', async () => {
    const { apiKey, cookie, teamId } = await setupUserAndKey();
    const { hub: makeHub, close } = await startServer();
    const hub = makeHub(apiKey);

    // Empty key -> 400 VALIDATION_ERROR from the facets/values endpoint.
    await expect(hub.traces.getFacetValues('')).rejects.toMatchObject({
      code: 'API_ERROR',
      statusCode: 400,
    });

    // A team-scoped API key (no user identity) cannot write settings — 403.
    const teamKeyRes = await request(app)
      .post(`/api/v1/teams/${teamId}/api-keys`)
      .set('Cookie', cookie)
      .send({ name: 'team key' })
      .expect(201);
    const teamHub = makeHub(teamKeyRes.body.key as string);

    await expect(teamHub.traces.updateSettings(true)).rejects.toMatchObject({
      code: 'API_ERROR',
      statusCode: 403,
    });

    await close();
  });
});
