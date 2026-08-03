import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent, signupTestUserWithApiKey } from '../../test-utils';

const app = createApp();

// Helper: sign up, get an API key, and create a prompt.
async function signupAndGetKey(
  promptName?: string,
): Promise<{
  apiKey: string;
  promptId: string;
  promptName: string;
  agent: ReturnType<typeof request.agent>;
}> {
  const { agent } = await authedAgent(app);

  const keyCreate = await agent.post('/api/v1/api-keys').send({ name: 'test key' });
  const apiKey: string = keyCreate.body.key;

  const name = promptName ?? `test-prompt-${Date.now()}`;
  const promptCreate = await agent.post('/api/v1/prompts').send({ name });

  return { apiKey, promptId: promptCreate.body.id, promptName: promptCreate.body.name, agent };
}

// Helper: registers a gateway model (public name = upstream name) for the agent's
// team via a real provider connection, returning its publicName. Used by #12
// default-model-binding tests; no provider call happens at version-commit time.
async function registerGatewayModel(
  agent: ReturnType<typeof request.agent>,
  publicName: string,
): Promise<string> {
  const conn = await agent
    .post('/api/v1/gateway/connections')
    .send({ provider: 'openai', label: 'openai test', apiKey: 'sk-test-abcdAB12', config: {} })
    .expect(201);
  await agent
    .post('/api/v1/gateway/models')
    .send({ publicName, upstreamModel: publicName, credentialId: conn.body.id })
    .expect(201);
  return publicName;
}

// Helper: creates a tool and commits a single version on it, returning the tool id.
async function createToolWithVersion(apiKey: string, name = `tool_${Date.now()}_${Math.random().toString(36).slice(2)}`): Promise<string> {
  const t = await request(app).post('/api/v1/tools').set('Authorization', `Bearer ${apiKey}`).send({ name }).expect(201);
  await request(app)
    .post(`/api/v1/tools/${t.body.id}/versions`)
    .set('Authorization', `Bearer ${apiKey}`)
    .send({ parametersSchema: { type: 'object', properties: { city: { type: 'string' } } }, executor: { type: 'client' } })
    .expect(201);
  return t.body.id;
}

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE prompt_version_tools, tool_aliases, tool_versions, tools, prompt_aliases, prompt_versions, audit_log, prompts, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /api/v1/prompts/:id/versions', () => {
  it('creates the first version, returns version_number=1, and auto-creates production+staging aliases', async () => {
    const { apiKey, promptId } = await signupAndGetKey();

    const res = await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'system', content: 'Hello {{ name }}' }] })
      .expect(201);

    expect(res.body.versionNumber).toBe(1);
    expect(res.body.variables).toEqual(['name']);
    expect(res.body.aliases).toHaveLength(2);
    const aliasNames = res.body.aliases.map((a: { alias: string }) => a.alias).sort();
    expect(aliasNames).toEqual(['production', 'staging']);
    res.body.aliases.forEach((a: { versionId: string }) => {
      expect(a.versionId).toBe(res.body.id);
    });

    const dbVersions = await prisma.promptVersion.findMany({ where: { promptId } });
    expect(dbVersions).toHaveLength(1);
    expect(dbVersions[0]?.versionNumber).toBe(1);

    const dbAliases = await prisma.promptAlias.findMany({ where: { promptId } });
    expect(dbAliases).toHaveLength(2);
  });

  it('creates a second version with version_number=2 and does NOT include aliases in response', async () => {
    const { apiKey, promptId } = await signupAndGetKey();

    await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'system', content: 'Version 1' }] })
      .expect(201);

    const res = await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'user', content: 'Version 2 {{ topic }}' }] })
      .expect(201);

    expect(res.body.versionNumber).toBe(2);
    expect(res.body.aliases).toBeUndefined();
    expect(res.body.variables).toEqual(['topic']);
  });

  it('returns 400 TEMPLATE_PARSE_ERROR for invalid nunjucks syntax', async () => {
    const { apiKey, promptId } = await signupAndGetKey();

    const res = await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'system', content: '{{ unclosed' }] })
      .expect(400);

    expect(res.body.error.code).toBe('TEMPLATE_PARSE_ERROR');
  });

  it('returns 400 VALIDATION_ERROR for missing messages field', async () => {
    const { apiKey, promptId } = await signupAndGetKey();

    const res = await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({})
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 VALIDATION_ERROR for invalid role in message', async () => {
    const { apiKey, promptId } = await signupAndGetKey();

    const res = await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'tool', content: 'hi' }] })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 403 when a viewer attempts to commit a version', async () => {
    // Create the user with an API key while still owner (so the key exists),
    // then downgrade them to viewer below.
    const {
      teamId: freshTeamId,
      userId: freshUserId,
      apiKey: viewerKey,
    } = await signupTestUserWithApiKey(app);

    // Downgrade fresh user from owner to viewer in their own team via DB
    await prisma.teamMember.update({
      where: { userId_teamId: { userId: freshUserId, teamId: freshTeamId } },
      data: { role: 'viewer' },
    });

    // Create prompt directly via DB since viewer can't do it via API
    const freshPrompt = await prisma.prompt.create({
      data: { name: 'viewer-test-prompt', teamId: freshTeamId, createdBy: freshUserId },
    });

    const commitRes = await request(app)
      .post(`/api/v1/prompts/${freshPrompt.id}/versions`)
      .set('Authorization', `Bearer ${viewerKey}`)
      .send({ messages: [{ role: 'system', content: 'Hello' }] })
      .expect(403);

    expect(commitRes.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 404 for a prompt that does not exist', async () => {
    const { apiKey } = await signupAndGetKey();
    const fakeId = '00000000-0000-0000-0000-000000000000';

    await request(app)
      .post(`/api/v1/prompts/${fakeId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'system', content: 'hi' }] })
      .expect(404);
  });
});

describe('GET /api/v1/prompts/:id/versions', () => {
  it('returns versions newest-first with messages field absent', async () => {
    const { apiKey, promptId } = await signupAndGetKey();

    await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'system', content: 'v1' }] });

    await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'system', content: 'v2' }] });

    const res = await request(app)
      .get(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);

    expect(res.body.total).toBe(2);
    expect(res.body.data[0].versionNumber).toBe(2); // newest first
    expect(res.body.data[1].versionNumber).toBe(1);
    expect(res.body.data[0].messages).toBeUndefined();
  });

  it('paginates correctly', async () => {
    const { apiKey, promptId } = await signupAndGetKey();

    for (let i = 0; i < 3; i++) {
      await request(app)
        .post(`/api/v1/prompts/${promptId}/versions`)
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ messages: [{ role: 'system', content: `v${i + 1}` }] });
    }

    const res = await request(app)
      .get(`/api/v1/prompts/${promptId}/versions?page=2&limit=2`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);

    expect(res.body.total).toBe(3);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.page).toBe(2);
    expect(res.body.limit).toBe(2);
  });

  it('returns 400 VALIDATION_ERROR (not a 500) when :id is not a UUID', async () => {
    const { agent } = await authedAgent(app);

    const res = await agent.get('/api/v1/prompts/not-a-uuid/versions').expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/v1/prompts/:id/versions/:version_number', () => {
  it('returns the full version including messages', async () => {
    const { apiKey, promptId } = await signupAndGetKey();

    await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'system', content: 'Hello {{ name }}' }] });

    const res = await request(app)
      .get(`/api/v1/prompts/${promptId}/versions/1`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);

    expect(res.body.versionNumber).toBe(1);
    expect(res.body.messages).toEqual([{ role: 'system', content: 'Hello {{ name }}' }]);
    expect(res.body.variables).toEqual(['name']);
  });

  it('returns 404 for a version number that does not exist', async () => {
    const { apiKey, promptId } = await signupAndGetKey();

    await request(app)
      .get(`/api/v1/prompts/${promptId}/versions/99`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(404);
  });
});

describe('GET /api/v1/prompt-versions/:versionId', () => {
  it('resolves a version UUID to its prompt name, number, and raw messages', async () => {
    const { apiKey, promptId, promptName } = await signupAndGetKey('greeting');
    const { body: v1 } = await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'system', content: 'You are {{ persona }}' }] })
      .expect(201);

    const res = await request(app)
      .get(`/api/v1/prompt-versions/${v1.id}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);

    expect(res.body).toMatchObject({
      promptId,
      promptName,
      versionNumber: 1,
      messages: [{ role: 'system', content: 'You are {{ persona }}' }],
      variables: ['persona'],
    });
  });

  it('404s for a version belonging to another team', async () => {
    const { apiKey: keyA, promptId } = await signupAndGetKey('secret');
    const { body: v1 } = await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${keyA}`)
      .send({ messages: [{ role: 'system', content: 'hi' }] })
      .expect(201);

    const { apiKey: keyB } = await signupAndGetKey(); // different team

    await request(app)
      .get(`/api/v1/prompt-versions/${v1.id}`)
      .set('Authorization', `Bearer ${keyB}`)
      .expect(404);
  });

  it('includes the resolved OpenAI tools array for a version with an attachment', async () => {
    const { apiKey, promptId } = await signupAndGetKey('with-tools');
    const toolId = await createToolWithVersion(apiKey);

    const { body: v1 } = await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'system', content: 'hi {{ name }}' }], tools: [{ toolId }] })
      .expect(201);

    const res = await request(app)
      .get(`/api/v1/prompt-versions/${v1.id}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);

    expect(res.body.tools).toHaveLength(1);
    expect(res.body.tools[0].type).toBe('function');
    expect(res.body.tools[0].function.parameters).toEqual({
      type: 'object',
      properties: { city: { type: 'string' } },
    });
  });
});

describe('commit with tools', () => {
  it('attaches a tool to the committed version and persists join rows', async () => {
    const { apiKey, promptId } = await signupAndGetKey();
    const toolId = await createToolWithVersion(apiKey);

    const res = await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'system', content: 'hi {{ name }}' }], tools: [{ toolId }] })
      .expect(201);

    const rows = await prisma.promptVersionTool.findMany({ where: { promptVersionId: res.body.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.toolId).toBe(toolId);
    expect(rows[0]?.aliasName).toBe('production');
    expect(rows[0]?.pinnedVersionId).toBeNull();
  });

  it('400s attaching a tool from another team, and leaves no phantom version behind', async () => {
    const a = await signupAndGetKey();
    const b = await signupAndGetKey();
    const toolId = await createToolWithVersion(b.apiKey);

    const countBefore = await prisma.promptVersion.count({ where: { promptId: a.promptId } });

    await request(app)
      .post(`/api/v1/prompts/${a.promptId}/versions`)
      .set('Authorization', `Bearer ${a.apiKey}`)
      .send({ messages: [{ role: 'system', content: 'x' }], tools: [{ toolId }] })
      .expect(400);

    const countAfter = await prisma.promptVersion.count({ where: { promptId: a.promptId } });
    expect(countAfter).toBe(countBefore);
  });

  it('400s pinning a non-existent tool version, and leaves no phantom version behind', async () => {
    const { apiKey, promptId } = await signupAndGetKey();
    const toolId = await createToolWithVersion(apiKey);

    const countBefore = await prisma.promptVersion.count({ where: { promptId } });

    await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'system', content: 'x' }], tools: [{ toolId, pinnedVersionNumber: 99 }] })
      .expect(400);

    const countAfter = await prisma.promptVersion.count({ where: { promptId } });
    expect(countAfter).toBe(countBefore);
  });
});

describe('#12 — default model binding on a version', () => {
  it('commits a version with a bound default model and returns its publicName', async () => {
    const { apiKey, promptId, agent } = await signupAndGetKey();
    const modelPublicName = await registerGatewayModel(agent, 'gpt-mini');

    const res = await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'system', content: 'Hi {{ name }}' }], model: modelPublicName })
      .expect(201);

    expect(res.body.model).toBe('gpt-mini');

    // Verify persisted state via the version-by-number endpoint and the DB.
    const fetched = await request(app)
      .get(`/api/v1/prompts/${promptId}/versions/${res.body.versionNumber}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);
    expect(fetched.body.model).toBe('gpt-mini');

    const dbRow = await prisma.promptVersion.findFirst({ where: { promptId } });
    expect(dbRow?.modelId).not.toBeNull();
  });

  it('commits an unbound version (no model) and returns model: null', async () => {
    const { apiKey, promptId } = await signupAndGetKey();

    const res = await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'system', content: 'x' }] })
      .expect(201);

    expect(res.body.model).toBeNull();
  });

  it('rejects a version whose model is not registered for the team (400)', async () => {
    const { apiKey, promptId } = await signupAndGetKey();

    await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'system', content: 'x' }], model: 'not-registered' })
      .expect(400);
  });

  it('resolves a version UUID to its bound model publicName (GET /prompt-versions/:id)', async () => {
    const { apiKey, promptId, agent } = await signupAndGetKey();
    const modelPublicName = await registerGatewayModel(agent, 'claude-x');

    const created = await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'system', content: 'yo' }], model: modelPublicName })
      .expect(201);

    const byId = await request(app)
      .get(`/api/v1/prompt-versions/${created.body.id}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);
    expect(byId.body.model).toBe('claude-x');
  });
});
