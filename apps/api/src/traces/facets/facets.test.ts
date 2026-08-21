import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';

const app = createApp();

/** Posts a batch of traces via the real ingestion API; returns the created trace ids. */
async function ingest(agent: ReturnType<typeof request.agent>, traces: unknown[]): Promise<string[]> {
  const res = await agent.post('/api/v1/traces').send({ traces }).expect(200);
  return res.body.traceIds as string[];
}

const iso = (d: Date): string => d.toISOString();

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE span_payloads, spans, traces, team_trace_settings, gateway_requests, provider_connections, prompt_aliases, prompt_versions, audit_log, prompts, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /api/v1/traces/facets', () => {
  it('returns distinct tags, metadata keys, and resolved span models for the team, ordered, deduped', async () => {
    const { agent } = await authedAgent(app);
    const now = new Date();
    await ingest(agent, [
      {
        tags: ['prod', 'nl'],
        metadata: { env: 'prod' },
        spans: [{ spanId: 's1', name: 'step', kind: 'llm', startTime: iso(now), model: 'gpt-4o-mini-2024-07-18' }],
      },
    ]);
    await ingest(agent, [
      {
        tags: ['prod'],
        metadata: { env: 'prod', lang: 'nl' },
        spans: [{ spanId: 's2', name: 'step', kind: 'llm', startTime: iso(now), model: 'claude-3-5-sonnet' }],
      },
    ]);

    const res = await agent.get('/api/v1/traces/facets').expect(200);
    expect(res.body.tags.sort()).toEqual(['nl', 'prod']);
    expect(res.body.metadataKeys.sort()).toEqual(['env', 'lang']);
    expect(res.body.models.sort()).toEqual(['claude-3-5-sonnet', 'gpt-4o-mini-2024-07-18']);
  });

  it('is team-scoped', async () => {
    const { agent } = await authedAgent(app);
    const { agent: other } = await authedAgent(app);
    const now = new Date();
    await ingest(other, [
      {
        tags: ['other-team-tag'],
        spans: [{ spanId: 's1', name: 'step', kind: 'llm', startTime: iso(now), model: 'other-team-model' }],
      },
    ]);

    const res = await agent.get('/api/v1/traces/facets').expect(200);
    expect(res.body.tags).toEqual([]);
    expect(res.body.metadataKeys).toEqual([]);
    expect(res.body.models).toEqual([]);
  });

  it('returns empty arrays when the team has no traces', async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get('/api/v1/traces/facets').expect(200);
    expect(res.body).toEqual({ tags: [], metadataKeys: [], models: [] });
  });
});

describe('GET /api/v1/traces/facets/values', () => {
  it('returns distinct values for a given metadata key', async () => {
    const { agent } = await authedAgent(app);
    const now = new Date();
    await ingest(agent, [
      { metadata: { env: 'prod' }, spans: [{ spanId: 's1', name: 'step', kind: 'llm', startTime: iso(now) }] },
    ]);
    await ingest(agent, [
      { metadata: { env: 'staging' }, spans: [{ spanId: 's2', name: 'step', kind: 'llm', startTime: iso(now) }] },
    ]);
    await ingest(agent, [{ spans: [{ spanId: 's3', name: 'step', kind: 'llm', startTime: iso(now) }] }]);

    const res = await agent.get('/api/v1/traces/facets/values?key=env').expect(200);
    expect(res.body.values.sort()).toEqual(['prod', 'staging']);
  });

  it('400s when key is missing or blank', async () => {
    const { agent } = await authedAgent(app);
    await agent.get('/api/v1/traces/facets/values').expect(400);
    await agent.get('/api/v1/traces/facets/values?key=').expect(400);
  });

  it('is team-scoped', async () => {
    const { agent } = await authedAgent(app);
    const { agent: other } = await authedAgent(app);
    const now = new Date();
    await ingest(other, [
      { metadata: { env: 'prod' }, spans: [{ spanId: 's1', name: 'step', kind: 'llm', startTime: iso(now) }] },
    ]);

    const res = await agent.get('/api/v1/traces/facets/values?key=env').expect(200);
    expect(res.body.values).toEqual([]);
  });
});
