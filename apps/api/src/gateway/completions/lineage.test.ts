import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';

const app = createApp();

/** A canned OpenAI chat.completions response body used by the mocked provider fetch. */
const OPENAI_RESPONSE = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 1751536800,
  model: 'gpt-4o-mini',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'Hi Alice' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
};

/** Captures the JSON body the adapter posted to the provider, for assertions. */
let capturedProviderBody: { model: string; messages: Array<{ role: string; content: string }> } | null;

/**
 * Signs up an owner, stores an OpenAI connection, creates a prompt and commits
 * version 1 whose system message uses `{{ name }}` (auto-creates the production alias).
 */
async function arrangeOwnerWithPrompt(): Promise<{
  agent: ReturnType<typeof request.agent>;
  apiKey: string;
  teamId: string;
  promptId: string;
  v1Id: string;
}> {
  const { agent, teamId } = await authedAgent(app);
  const keyRes = await agent.post('/api/v1/api-keys').send({ name: 'g8' }).expect(201);
  const apiKey: string = keyRes.body.key;

  const conn = await agent
    .post('/api/v1/gateway/connections')
    .send({ provider: 'openai', label: 'test', apiKey: 'sk-test-000000000000AB12', config: {} })
    .expect(201);
  await agent
    .post('/api/v1/gateway/models')
    .send({ publicName: 'gpt-4o-mini', upstreamModel: 'gpt-4o-mini', credentialId: conn.body.id })
    .expect(201);

  const promptRes = await agent.post('/api/v1/prompts').send({ name: 'greeting' }).expect(201);
  const promptId: string = promptRes.body.id;

  const v1 = await agent
    .post(`/api/v1/prompts/${promptId}/versions`)
    .send({ messages: [{ role: 'system', content: 'Hello {{ name }}' }] })
    .expect(201);

  return { agent, apiKey, teamId, promptId, v1Id: v1.body.id };
}

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE
    span_payloads, spans, traces,
    gateway_requests, gateway_cache, budgets, virtual_keys, provider_connections,
    audit_log, prompt_aliases, prompt_versions, prompts,
    api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`;

  capturedProviderBody = null;
  // Mock the provider HTTP call (the one allowed mock — external paid API).
  jest.spyOn(global, 'fetch').mockImplementation((_url, init) => {
    const body = init && typeof init.body === 'string' ? init.body : '{}';
    capturedProviderBody = JSON.parse(body);
    return Promise.resolve(
      new Response(JSON.stringify(OPENAI_RESPONSE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /api/v1/gateway/chat/completions — prompt reference lineage', () => {
  it('renders the production version and stamps prompt_version_id on the request row', async () => {
    const { agent, promptId, v1Id } = await arrangeOwnerWithPrompt();

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'gpt-4o-mini', prompt: { name: 'greeting', alias: 'production', variables: { name: 'Alice' } } })
      .expect(200);

    // Response is a normal OpenAI-shaped body.
    expect(res.body.choices[0].message.content).toBe('Hi Alice');

    // The provider received the RENDERED messages, not the template.
    expect(capturedProviderBody?.messages[0].content).toBe('Hello Alice');

    // The gateway_requests row is stamped with version 1's id.
    const rows = await prisma.gatewayRequest.findMany({ where: { promptVersionId: { not: null } } });
    expect(rows).toHaveLength(1);
    expect(rows[0].promptVersionId).toBe(v1Id);
    void promptId;
  });

  it('stamps the NEW version id after production is promoted to a later version', async () => {
    const { agent, promptId, v1Id } = await arrangeOwnerWithPrompt();

    // Commit v2 and promote production to it.
    const v2 = await agent
      .post(`/api/v1/prompts/${promptId}/versions`)
      .send({ messages: [{ role: 'system', content: 'Hi there, {{ name }}!' }] })
      .expect(201);
    await agent
      .post(`/api/v1/prompts/${promptId}/aliases/production/promote`)
      .send({ version_number: 2 })
      .expect(200);

    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'gpt-4o-mini', prompt: { name: 'greeting', alias: 'production', variables: { name: 'Bob' } } })
      .expect(200);

    expect(capturedProviderBody?.messages[0].content).toBe('Hi there, Bob!');

    const rows = await prisma.gatewayRequest.findMany({ orderBy: { createdAt: 'desc' } });
    expect(rows[0].promptVersionId).toBe(v2.body.id);
    expect(rows[0].promptVersionId).not.toBe(v1Id);
  });

  it('stamps a client-supplied prompt_version_id when the caller rendered the prompt itself', async () => {
    const { agent, v1Id } = await arrangeOwnerWithPrompt();

    // The shape every SDK tool loop uses: the client rendered separately, so it sends
    // messages plus the version those messages came from.
    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hello Alice' }],
        prompt_version_id: v1Id,
      })
      .expect(200);

    const rows = await prisma.gatewayRequest.findMany({ where: { promptVersionId: { not: null } } });
    expect(rows).toHaveLength(1);
    expect(rows[0].promptVersionId).toBe(v1Id);
  });

  it('stamps a client-supplied prompt_version_id on the span, not only the request row', async () => {
    const { agent, teamId, v1Id } = await arrangeOwnerWithPrompt();

    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hello Alice' }],
        prompt_version_id: v1Id,
      })
      .expect(200);

    // The span is the half that actually regressed for a whole phase: the parameter was
    // accepted, the call returned 200, and the span carried no version — silent lineage
    // loss with nothing in the response to notice. Assert the span, not just the row.
    const span = await prisma.span.findFirst({ where: { teamId } });
    expect(span).not.toBeNull();
    expect(span!.promptVersionId).toBe(v1Id);
  });

  it('never lets a prompt_version_id reach the provider', async () => {
    const { agent, v1Id } = await arrangeOwnerWithPrompt();

    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hello Alice' }],
        prompt_version_id: v1Id,
      })
      .expect(200);

    expect(capturedProviderBody).not.toHaveProperty('prompt_version_id');
  });

  it("400s on another team's prompt_version_id rather than stamping it", async () => {
    const mine = await arrangeOwnerWithPrompt();
    const theirs = await arrangeOwnerWithPrompt();

    const res = await mine.agent
      .post('/api/v1/gateway/chat/completions')
      .send({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
        prompt_version_id: theirs.v1Id,
      })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const rows = await prisma.gatewayRequest.findMany({ where: { promptVersionId: { not: null } } });
    expect(rows).toHaveLength(0);
  });

  it('lets the prompt reference win over a client-supplied prompt_version_id', async () => {
    const { agent, promptId, v1Id } = await arrangeOwnerWithPrompt();
    const v2 = await agent
      .post(`/api/v1/prompts/${promptId}/versions`)
      .send({ messages: [{ role: 'system', content: 'Hi there, {{ name }}!' }] })
      .expect(201);

    // A `prompt` ref renders server-side and knows exactly which version it used, so a
    // client-supplied id cannot contradict it.
    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({
        model: 'gpt-4o-mini',
        prompt: { name: 'greeting', alias: 'production', variables: { name: 'Alice' } },
        prompt_version_id: v2.body.id,
      })
      .expect(200);

    const rows = await prisma.gatewayRequest.findMany({ orderBy: { createdAt: 'desc' } });
    expect(rows[0].promptVersionId).toBe(v1Id);
  });

  it('returns 400 VALIDATION_ERROR when both messages and prompt are supplied', async () => {
    const { agent } = await arrangeOwnerWithPrompt();

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
        prompt: { name: 'greeting', alias: 'production', variables: { name: 'Alice' } },
      })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 VALIDATION_ERROR when neither messages nor prompt is supplied', async () => {
    const { agent } = await arrangeOwnerWithPrompt();

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'gpt-4o-mini' })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 MISSING_VARIABLES when a required template variable is absent', async () => {
    const { agent } = await arrangeOwnerWithPrompt();

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'gpt-4o-mini', prompt: { name: 'greeting', alias: 'production', variables: {} } })
      .expect(400);

    expect(res.body.error.code).toBe('MISSING_VARIABLES');
    expect(res.body.error.message).toContain('name'); // missing var named in the message
  });

  it('returns 404 when the prompt name or alias is unknown for the team', async () => {
    const { agent } = await arrangeOwnerWithPrompt();

    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'gpt-4o-mini', prompt: { name: 'nope', alias: 'production', variables: {} } })
      .expect(404);
  });
});

describe('#12 — gateway default model from the version binding', () => {
  it('uses the version-bound model when a stored-prompt call omits model', async () => {
    const { agent } = await arrangeOwnerWithPrompt();
    // Bind v1 of a NEW prompt to the registered model, then call without a model.
    const p = await agent.post('/api/v1/prompts').send({ name: 'bound' }).expect(201);
    await agent
      .post(`/api/v1/prompts/${p.body.id}/versions`)
      .send({ messages: [{ role: 'user', content: 'hi {{ name }}' }], model: 'gpt-4o-mini' })
      .expect(201);

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ prompt: { name: 'bound', alias: 'production', variables: { name: 'Al' } } }) // no model
      .expect(200);

    expect(res.body.choices[0].message.content).toBe('Hi Alice');
    // The provider received the bound deployment's upstream model.
    expect(capturedProviderBody?.model).toBe('gpt-4o-mini');
    // The request row records the resolved model.
    const rows = await prisma.gatewayRequest.findMany({ where: { promptVersionId: { not: null } } });
    expect(rows[0]?.requestedModel).toBe('gpt-4o-mini');
  });

  it('lets an explicit request model override the version binding', async () => {
    const { agent } = await arrangeOwnerWithPrompt();
    // Register a second deployment and bind the prompt to the FIRST one.
    const conn = await agent
      .post('/api/v1/gateway/connections')
      .send({ provider: 'openai', label: 'test2', apiKey: 'sk-test-000000000000CD34', config: {} })
      .expect(201);
    await agent
      .post('/api/v1/gateway/models')
      .send({ publicName: 'other-model', upstreamModel: 'other-model', credentialId: conn.body.id })
      .expect(201);
    const p = await agent.post('/api/v1/prompts').send({ name: 'ovr' }).expect(201);
    await agent
      .post(`/api/v1/prompts/${p.body.id}/versions`)
      .send({ messages: [{ role: 'user', content: 'hi' }], model: 'gpt-4o-mini' })
      .expect(201);

    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'other-model', prompt: { name: 'ovr', alias: 'production' } })
      .expect(200);

    // Explicit model wins — the provider saw 'other-model', not the bound one.
    expect(capturedProviderBody?.model).toBe('other-model');
  });

  it('400s when neither an explicit model nor a bound model is present', async () => {
    const { agent } = await arrangeOwnerWithPrompt();
    const p = await agent.post('/api/v1/prompts').send({ name: 'unbound' }).expect(201);
    await agent
      .post(`/api/v1/prompts/${p.body.id}/versions`)
      .send({ messages: [{ role: 'user', content: 'hi' }] }) // no model bound
      .expect(201);

    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ prompt: { name: 'unbound', alias: 'production' } }) // no model
      .expect(400);
  });

  it('un-binds versions when their bound model is deleted, then 400s a no-model call', async () => {
    const { agent } = await arrangeOwnerWithPrompt();
    // Register a dedicated model, bind a new prompt's v1 to it.
    const conn = await agent
      .post('/api/v1/gateway/connections')
      .send({ provider: 'openai', label: 'temp', apiKey: 'sk-test-000000000000EF56', config: {} })
      .expect(201);
    const model = await agent
      .post('/api/v1/gateway/models')
      .send({ publicName: 'temp-model', upstreamModel: 'temp-model', credentialId: conn.body.id })
      .expect(201);
    const p = await agent.post('/api/v1/prompts').send({ name: 'gdel' }).expect(201);
    const v1 = await agent
      .post(`/api/v1/prompts/${p.body.id}/versions`)
      .send({ messages: [{ role: 'user', content: 'hi' }], model: 'temp-model' })
      .expect(201);

    // Delete the model — SET NULL means this succeeds, un-binding the version.
    await agent.delete(`/api/v1/gateway/models/${model.body.id}`).expect(204);

    // The version's binding is now null.
    const byId = await agent.get(`/api/v1/prompt-versions/${v1.body.id}`).expect(200);
    expect(byId.body.model).toBeNull();

    // A no-model call now 400s (no default left).
    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ prompt: { name: 'gdel', alias: 'production' } })
      .expect(400);
  });
});
