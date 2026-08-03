import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';

const app = createApp();

/** Canned OpenAI-shaped provider response for the mocked gateway fetch. */
const OPENAI_RESPONSE = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 1751536800,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
};

/**
 * Signs up an owner, stores an OpenAI connection, and registers the `gpt-4o-mini`
 * model against it (post-#14 model registry — completions resolve via a registered
 * model, not a bare connection). Returns the agent.
 */
async function signupWithConnection(): Promise<ReturnType<typeof request.agent>> {
  const { agent } = await authedAgent(app);
  const conn = await agent
    .post('/api/v1/gateway/connections')
    .send({ provider: 'openai', label: 't', apiKey: 'sk-test-000000000000AB12', config: {} })
    .expect(201);
  await agent
    .post('/api/v1/gateway/models')
    .send({ publicName: 'gpt-4o-mini', upstreamModel: 'gpt-4o-mini', credentialId: conn.body.id })
    .expect(201);
  return agent;
}

/** Makes a prompt-reference gateway call (mocked provider) → stamps prompt_version_id → span. */
async function promptRefCall(agent: ReturnType<typeof request.agent>, name: string): Promise<void> {
  await agent
    .post('/api/v1/gateway/chat/completions')
    .send({ model: 'gpt-4o-mini', prompt: { name, alias: 'production', variables: { name: 'X' } } })
    .expect(200);
}

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE
    span_payloads, spans, traces, team_trace_settings,
    gateway_requests, gateway_cache, budgets, virtual_keys, provider_connections,
    audit_log, prompt_aliases, prompt_versions, prompts,
    api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`;
  // A fresh Response per call — a single shared instance would throw "Body is
  // unusable" on the second read when a test makes more than one gateway call
  // (e.g. the promote-to-v2 lineage test below).
  jest.spyOn(global, 'fetch').mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(OPENAI_RESPONSE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('prompt-version lineage', () => {
  it('GET /traces?prompt_version_id filters to traces whose spans used that version', async () => {
    const agent = await signupWithConnection();
    const p = await agent.post('/api/v1/prompts').send({ name: 'greeting' }).expect(201);
    const v1 = await agent.post(`/api/v1/prompts/${p.body.id}/versions`).send({ messages: [{ role: 'system', content: 'Hello {{ name }}' }] }).expect(201);
    await promptRefCall(agent, 'greeting');

    const res = await agent.get(`/api/v1/traces?prompt_version_id=${v1.body.id}`).expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].totalTokens).toBe(14);
  });

  it('GET /prompts/:id/versions/:n/traces lists traces that used that exact version', async () => {
    const agent = await signupWithConnection();
    const p = await agent.post('/api/v1/prompts').send({ name: 'greeting' }).expect(201);
    await agent.post(`/api/v1/prompts/${p.body.id}/versions`).send({ messages: [{ role: 'system', content: 'Hello {{ name }}' }] }).expect(201);
    await promptRefCall(agent, 'greeting');

    const res = await agent.get(`/api/v1/prompts/${p.body.id}/versions/1/traces`).expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data).toHaveLength(1);
  });

  it('after promoting production to v2, new lineage lists the new trace while v1 keeps the old', async () => {
    const agent = await signupWithConnection();
    const p = await agent.post('/api/v1/prompts').send({ name: 'greeting' }).expect(201);
    const promptId = p.body.id;

    // v1 + one call against it.
    await agent.post(`/api/v1/prompts/${promptId}/versions`).send({ messages: [{ role: 'system', content: 'Hello {{ name }}' }] }).expect(201);
    await promptRefCall(agent, 'greeting'); // trace on v1

    // v2 + promote production to it + one call against it.
    await agent.post(`/api/v1/prompts/${promptId}/versions`).send({ messages: [{ role: 'system', content: 'Hi {{ name }}!' }] }).expect(201);
    await agent.post(`/api/v1/prompts/${promptId}/aliases/production/promote`).send({ version_number: 2 }).expect(200);
    await promptRefCall(agent, 'greeting'); // trace on v2

    const v1Lineage = await agent.get(`/api/v1/prompts/${promptId}/versions/1/traces`).expect(200);
    const v2Lineage = await agent.get(`/api/v1/prompts/${promptId}/versions/2/traces`).expect(200);

    // Each version's lineage lists exactly its own trace.
    expect(v1Lineage.body.total).toBe(1);
    expect(v2Lineage.body.total).toBe(1);
    // And they are different traces.
    expect(v1Lineage.body.data[0].id).not.toBe(v2Lineage.body.data[0].id);
  });

  it('returns 404 for an unknown prompt or version, and for another team prompt', async () => {
    const agent = await signupWithConnection();
    const p = await agent.post('/api/v1/prompts').send({ name: 'greeting' }).expect(201);
    await agent.post(`/api/v1/prompts/${p.body.id}/versions`).send({ messages: [{ role: 'system', content: 'Hello {{ name }}' }] }).expect(201);

    await agent.get('/api/v1/prompts/00000000-0000-0000-0000-000000000000/versions/1/traces').expect(404);
    await agent.get(`/api/v1/prompts/${p.body.id}/versions/99/traces`).expect(404);

    // Another team cannot resolve this prompt → 404 (team-scoped getVersion).
    const other = await signupWithConnection();
    await other.get(`/api/v1/prompts/${p.body.id}/versions/1/traces`).expect(404);
  });
});
