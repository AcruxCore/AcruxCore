import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';

const app = createApp();

// Helper: create a user, get an API key, create a prompt, commit N versions.
// Prompts are created via session; versions and alias ops use the API key.
async function setupPromptWithVersions(numVersions: number): Promise<{
  apiKey: string;
  promptId: string;
  promptName: string;
}> {
  const { agent } = await authedAgent(app);

  const keyRes = await agent.post('/api/v1/api-keys').send({ name: 'test' });
  const apiKey: string = keyRes.body.key;

  const promptName = `test-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const promptRes = await agent.post('/api/v1/prompts').send({ name: promptName });
  const promptId: string = promptRes.body.id;

  for (let i = 1; i <= numVersions; i++) {
    await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'system', content: `Version ${i} content for {{ name }}` }] });
  }

  return { apiKey, promptId, promptName };
}

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE prompt_version_tools, tool_aliases, tool_versions, tools, prompt_aliases, prompt_versions, audit_log, prompts, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /api/v1/prompts/:id/aliases', () => {
  it('returns production and staging both pointing to v1 after first commit', async () => {
    const { apiKey, promptId } = await setupPromptWithVersions(1);

    const res = await request(app)
      .get(`/api/v1/prompts/${promptId}/aliases`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);

    expect(res.body).toHaveLength(2);
    const production = res.body.find((a: { alias: string }) => a.alias === 'production');
    const staging = res.body.find((a: { alias: string }) => a.alias === 'staging');
    expect(production).toBeDefined();
    expect(staging).toBeDefined();
    expect(production.versionNumber).toBe(1);
    expect(staging.versionNumber).toBe(1);
  });

  it('returns 400 VALIDATION_ERROR (not a 500) when :id is not a UUID', async () => {
    const { agent } = await authedAgent(app);

    const res = await agent.get('/api/v1/prompts/not-a-uuid/aliases').expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/v1/prompts/:id/aliases/:alias/promote', () => {
  it('moves production to v2 and staging remains at v1', async () => {
    const { apiKey, promptId } = await setupPromptWithVersions(2);

    const res = await request(app)
      .post(`/api/v1/prompts/${promptId}/aliases/production/promote`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ version_number: 2 })
      .expect(200);

    expect(res.body.alias).toBe('production');
    expect(res.body.versionNumber).toBe(2);

    const aliasesRes = await request(app)
      .get(`/api/v1/prompts/${promptId}/aliases`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);

    const staging = aliasesRes.body.find((a: { alias: string }) => a.alias === 'staging');
    expect(staging.versionNumber).toBe(1);
  });

  it('rolls back production from v2 to v1 (promote to older version)', async () => {
    const { apiKey, promptId } = await setupPromptWithVersions(2);

    await request(app)
      .post(`/api/v1/prompts/${promptId}/aliases/production/promote`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ version_number: 2 })
      .expect(200);

    const res = await request(app)
      .post(`/api/v1/prompts/${promptId}/aliases/production/promote`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ version_number: 1 })
      .expect(200);

    expect(res.body.versionNumber).toBe(1);

    const dbAlias = await prisma.promptAlias.findFirst({
      where: { promptId, alias: 'production' },
      include: { version: { select: { versionNumber: true } } },
    });
    expect(dbAlias?.version.versionNumber).toBe(1);
  });

  it('creates a custom alias that did not previously exist', async () => {
    const { apiKey, promptId } = await setupPromptWithVersions(2);

    const res = await request(app)
      .post(`/api/v1/prompts/${promptId}/aliases/canary/promote`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ version_number: 2 })
      .expect(200);

    expect(res.body.alias).toBe('canary');
    expect(res.body.versionNumber).toBe(2);
  });

  it('returns 404 when version_number does not exist', async () => {
    const { apiKey, promptId } = await setupPromptWithVersions(1);

    const res = await request(app)
      .post(`/api/v1/prompts/${promptId}/aliases/production/promote`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ version_number: 99 })
      .expect(404);

    expect(res.body.error).toBeDefined();
  });

  it('returns 403 when a viewer attempts to promote', async () => {
    const { agent, teamId, userId } = await authedAgent(app);
    const keyRes = await agent.post('/api/v1/api-keys').send({ name: 'test' });
    const apiKey: string = keyRes.body.key;

    const prompt = await prisma.prompt.create({
      data: { name: 'test', teamId, createdBy: userId },
    });
    const version = await prisma.promptVersion.create({
      data: {
        promptId: prompt.id,
        versionNumber: 1,
        messages: [{ role: 'system', content: 'hi' }],
        variables: [],
        createdBy: userId,
      },
    });
    await prisma.promptAlias.createMany({
      data: [
        { promptId: prompt.id, alias: 'production', versionId: version.id },
        { promptId: prompt.id, alias: 'staging', versionId: version.id },
      ],
    });

    await prisma.teamMember.update({
      where: { userId_teamId: { userId, teamId } },
      data: { role: 'viewer' },
    });

    const res = await request(app)
      .post(`/api/v1/prompts/${prompt.id}/aliases/production/promote`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ version_number: 1 })
      .expect(403);

    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 400 VALIDATION_ERROR when version_number is missing', async () => {
    const { apiKey, promptId } = await setupPromptWithVersions(1);

    const res = await request(app)
      .post(`/api/v1/prompts/${promptId}/aliases/production/promote`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({})
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('DELETE /api/v1/prompts/:id/aliases/:alias', () => {
  it('deletes a custom alias and returns 204', async () => {
    const { apiKey, promptId } = await setupPromptWithVersions(2);

    // Create a custom alias
    await request(app)
      .post(`/api/v1/prompts/${promptId}/aliases/canary/promote`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ version_number: 2 })
      .expect(200);

    // Delete it
    await request(app)
      .delete(`/api/v1/prompts/${promptId}/aliases/canary`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(204);

    // Verify it's gone
    const res = await request(app)
      .get(`/api/v1/prompts/${promptId}/aliases`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);

    expect(res.body.find((a: { alias: string }) => a.alias === 'canary')).toBeUndefined();
    // production and staging still exist
    expect(res.body).toHaveLength(2);
  });

  it('returns 400 when trying to delete production', async () => {
    const { apiKey, promptId } = await setupPromptWithVersions(1);

    const res = await request(app)
      .delete(`/api/v1/prompts/${promptId}/aliases/production`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(400);

    expect(res.body.error.code).toBe('CANNOT_DELETE_DEFAULT_ALIAS');
  });

  it('returns 400 when trying to delete staging', async () => {
    const { apiKey, promptId } = await setupPromptWithVersions(1);

    const res = await request(app)
      .delete(`/api/v1/prompts/${promptId}/aliases/staging`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(400);

    expect(res.body.error.code).toBe('CANNOT_DELETE_DEFAULT_ALIAS');
  });

  it('returns 404 when alias does not exist', async () => {
    const { apiKey, promptId } = await setupPromptWithVersions(1);

    await request(app)
      .delete(`/api/v1/prompts/${promptId}/aliases/nonexistent`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(404);
  });

  it('returns 403 when a viewer attempts to delete', async () => {
    const { agent, teamId, userId } = await authedAgent(app);
    const keyRes = await agent.post('/api/v1/api-keys').send({ name: 'test' });
    const apiKey: string = keyRes.body.key;

    const prompt = await prisma.prompt.create({
      data: { name: 'test', teamId, createdBy: userId },
    });
    const version = await prisma.promptVersion.create({
      data: {
        promptId: prompt.id,
        versionNumber: 1,
        messages: [{ role: 'system', content: 'hi' }],
        variables: [],
        createdBy: userId,
      },
    });
    await prisma.promptAlias.createMany({
      data: [
        { promptId: prompt.id, alias: 'production', versionId: version.id },
        { promptId: prompt.id, alias: 'staging', versionId: version.id },
        { promptId: prompt.id, alias: 'canary', versionId: version.id },
      ],
    });

    await prisma.teamMember.update({
      where: { userId_teamId: { userId, teamId } },
      data: { role: 'viewer' },
    });

    const res = await request(app)
      .delete(`/api/v1/prompts/${prompt.id}/aliases/canary`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(403);

    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('emits an alias_deleted audit event', async () => {
    const { apiKey, promptId } = await setupPromptWithVersions(2);

    await request(app)
      .post(`/api/v1/prompts/${promptId}/aliases/canary/promote`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ version_number: 2 })
      .expect(200);

    await request(app)
      .delete(`/api/v1/prompts/${promptId}/aliases/canary`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(204);

    const auditRes = await request(app)
      .get(`/api/v1/prompts/${promptId}/audit`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);

    const deleteEvent = auditRes.body.data.find(
      (e: { event: string }) => e.event === 'alias_deleted',
    );
    expect(deleteEvent).toBeDefined();
    expect(deleteEvent.metadata.alias).toBe('canary');
  });
});

describe('POST /api/v1/prompts/:name/:alias/render', () => {
  it('renders the correct version after production is promoted to v2', async () => {
    const { apiKey, promptId, promptName } = await setupPromptWithVersions(2);

    await request(app)
      .post(`/api/v1/prompts/${promptId}/aliases/production/promote`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ version_number: 2 });

    const res = await request(app)
      .post(`/api/v1/prompts/${promptName}/production/render`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ variables: { name: 'Alice' } })
      .expect(200);

    expect(res.body.messages).toEqual([
      { role: 'system', content: 'Version 2 content for Alice' },
    ]);
  });

  it('full chain: v1 → promote to v2 → promote to v3 → render → rollback to v1 → render', async () => {
    const { apiKey, promptId, promptName } = await setupPromptWithVersions(3);

    await request(app)
      .post(`/api/v1/prompts/${promptId}/aliases/production/promote`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ version_number: 2 });

    let renderRes = await request(app)
      .post(`/api/v1/prompts/${promptName}/production/render`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ variables: { name: 'Bob' } })
      .expect(200);
    expect(renderRes.body.messages[0].content).toBe('Version 2 content for Bob');

    await request(app)
      .post(`/api/v1/prompts/${promptId}/aliases/production/promote`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ version_number: 3 });

    renderRes = await request(app)
      .post(`/api/v1/prompts/${promptName}/production/render`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ variables: { name: 'Carol' } })
      .expect(200);
    expect(renderRes.body.messages[0].content).toBe('Version 3 content for Carol');

    await request(app)
      .post(`/api/v1/prompts/${promptId}/aliases/production/promote`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ version_number: 1 });

    renderRes = await request(app)
      .post(`/api/v1/prompts/${promptName}/production/render`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ variables: { name: 'Dave' } })
      .expect(200);
    expect(renderRes.body.messages[0].content).toBe('Version 1 content for Dave');

    const aliasesRes = await request(app)
      .get(`/api/v1/prompts/${promptId}/aliases`)
      .set('Authorization', `Bearer ${apiKey}`);
    const production = aliasesRes.body.find((a: { alias: string }) => a.alias === 'production');
    expect(production.versionNumber).toBe(1);
  });

  it('renders with all required variables provided and extra variables ignored', async () => {
    const { agent } = await authedAgent(app);
    const keyRes = await agent.post('/api/v1/api-keys').send({ name: 'test' });
    const apiKey: string = keyRes.body.key;
    const promptName = `extra-vars-${Date.now()}`;

    const promptRes = await agent.post('/api/v1/prompts').send({ name: promptName });
    const promptId: string = promptRes.body.id;

    await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'system', content: 'Hi {{ name }}' }] });

    const res = await request(app)
      .post(`/api/v1/prompts/${promptName}/production/render`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ variables: { name: 'Eve', extraField: 'ignored' } })
      .expect(200);

    expect(res.body.messages[0].content).toBe('Hi Eve');
  });

  it('returns 400 MISSING_VARIABLES with missing array when required variables absent', async () => {
    const { agent } = await authedAgent(app);
    const keyRes = await agent.post('/api/v1/api-keys').send({ name: 'test' });
    const apiKey: string = keyRes.body.key;
    const promptName = `missing-vars-${Date.now()}`;

    const promptRes = await agent.post('/api/v1/prompts').send({ name: promptName });
    const promptId: string = promptRes.body.id;

    await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'system', content: 'Hello {{ name }} from {{ company }}' }] });

    const res = await request(app)
      .post(`/api/v1/prompts/${promptName}/production/render`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ variables: {} })
      .expect(400);

    expect(res.body.error.code).toBe('MISSING_VARIABLES');
    expect(res.body.error.missing).toEqual(expect.arrayContaining(['name', 'company']));
  });

  it('returns 404 for an unknown prompt name', async () => {
    const { agent } = await authedAgent(app);
    const keyRes = await agent.post('/api/v1/api-keys').send({ name: 'test' });
    const apiKey: string = keyRes.body.key;

    await request(app)
      .post('/api/v1/prompts/nonexistent-prompt/production/render')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ variables: {} })
      .expect(404);
  });

  it('returns 404 for an unknown alias', async () => {
    const { apiKey, promptName } = await setupPromptWithVersions(1);

    await request(app)
      .post(`/api/v1/prompts/${promptName}/no-such-alias/render`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ variables: { name: 'X' } })
      .expect(404);
  });

  it('works via API key auth (no session cookie)', async () => {
    const { apiKey, promptName } = await setupPromptWithVersions(1);

    const res = await request(app)
      .post(`/api/v1/prompts/${promptName}/production/render`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ variables: { name: 'Frank' } })
      .expect(200);

    expect(res.body.messages[0].content).toBe('Version 1 content for Frank');
  });

  it('render response includes the resolved versionId and versionNumber', async () => {
    const { apiKey, promptName } = await setupPromptWithVersions(2);

    const res = await request(app)
      .post(`/api/v1/prompts/${promptName}/production/render`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ variables: { name: 'Alice' } })
      .expect(200);

    expect(res.body.versionNumber).toBe(1);
    expect(typeof res.body.versionId).toBe('string');
    expect(res.body.versionId.length).toBeGreaterThan(0);
  });
});

describe('render returns attached tools', () => {
  it('includes an OpenAI-shaped tools array from the version attachment', async () => {
    const { apiKey, promptId, promptName } = await setupPromptWithVersions(0);

    // tool + version
    const t = await request(app)
      .post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'get_weather', description: 'w' })
      .expect(201);
    await request(app)
      .post(`/api/v1/tools/${t.body.id}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        description: 'w',
        parametersSchema: { type: 'object', properties: { city: { type: 'string' } } },
        executor: { type: 'client' },
      })
      .expect(201);

    // commit the first version WITH the tool attachment, then render via production alias
    await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        messages: [{ role: 'system', content: 'help {{ name }}' }],
        tools: [{ toolId: t.body.id }],
      })
      .expect(201);

    const res = await request(app)
      .post(`/api/v1/prompts/${promptName}/production/render`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ variables: { name: 'Al' } })
      .expect(200);

    expect(res.body.messages[0].content).toBe('help Al');
    expect(res.body.tools).toHaveLength(1);
    expect(res.body.tools[0]).toEqual({
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'w',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    });
  });

  it('falls back to the tool-level description when the attached version has none', async () => {
    const { apiKey, promptId, promptName } = await setupPromptWithVersions(0);

    // tool has a description; the tool VERSION deliberately omits one
    const t = await request(app)
      .post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'get_forecast', description: 'tool-level description' })
      .expect(201);
    await request(app)
      .post(`/api/v1/tools/${t.body.id}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        parametersSchema: { type: 'object', properties: { city: { type: 'string' } } },
        executor: { type: 'client' },
      })
      .expect(201);

    await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        messages: [{ role: 'system', content: 'help {{ name }}' }],
        tools: [{ toolId: t.body.id }],
      })
      .expect(201);

    const res = await request(app)
      .post(`/api/v1/prompts/${promptName}/production/render`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ variables: { name: 'Al' } })
      .expect(200);

    expect(res.body.tools).toHaveLength(1);
    expect(res.body.tools[0]).toEqual({
      type: 'function',
      function: {
        name: 'get_forecast',
        description: 'tool-level description',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    });
  });

  it('excludes an attached tool that has since been soft-deleted from the catalog', async () => {
    const { apiKey, promptId, promptName } = await setupPromptWithVersions(0);

    const t = await request(app)
      .post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'get_stock_price', description: 'will be deleted' })
      .expect(201);
    await request(app)
      .post(`/api/v1/tools/${t.body.id}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ parametersSchema: { type: 'object' }, executor: { type: 'client' } })
      .expect(201);
    await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'system', content: 'help {{ name }}' }], tools: [{ toolId: t.body.id }] })
      .expect(201);

    await request(app)
      .delete(`/api/v1/tools/${t.body.id}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(204);

    const res = await request(app)
      .post(`/api/v1/prompts/${promptName}/production/render`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ variables: { name: 'Al' } })
      .expect(200);

    expect(res.body.tools).toEqual([]);
  });
});
