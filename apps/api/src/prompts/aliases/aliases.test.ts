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
  await prisma.$executeRaw`TRUNCATE TABLE prompt_tool_bindings, tool_aliases, tool_versions, tools, prompt_aliases, prompt_versions, audit_log, prompts, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
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

  it('requires a variable a version was committed without, with no backfill (issue #503)', async () => {
    // Every version already stored carries the list the extractor produced when it was
    // committed. If render validated against that column, a correction to the extractor
    // would reach no existing prompt — and committing the NEXT version would become the
    // breaking step, because that is when the required list suddenly grows.
    const { agent } = await authedAgent(app);
    const keyRes = await agent.post('/api/v1/api-keys').send({ name: 'test' });
    const apiKey: string = keyRes.body.key;
    const promptName = `stale-vars-${Date.now()}`;

    const promptRes = await agent.post('/api/v1/prompts').send({ name: promptName });
    const promptId: string = promptRes.body.id;

    const content = 'Hello {{ item }}. {% for item in items %}{{ item }}{% endfor %}';
    const versionRes = await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'system', content }] })
      .expect(201);

    // Put the row back the way the old extractor would have written it: `item` missing.
    await prisma.promptVersion.update({
      where: { id: versionRes.body.id },
      data: { variables: ['items'] },
    });

    const res = await request(app)
      .post(`/api/v1/prompts/${promptName}/production/render`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ variables: { items: ['i1'] } })
      .expect(400);

    expect(res.body.error.code).toBe('MISSING_VARIABLES');
    expect(res.body.error.missing).toEqual(['item']);

    // And supplying it renders the greeting, instead of "Hello .".
    const ok = await request(app)
      .post(`/api/v1/prompts/${promptName}/production/render`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ variables: { item: 'Ada', items: ['i1'] } })
      .expect(200);
    expect(ok.body.messages[0].content).toBe('Hello Ada. i1');
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

    // commit the first version, bind the tool at the prompt's default level, then
    // render via production alias — which inherits the default binding.
    await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'system', content: 'help {{ name }}' }] })
      .expect(201);
    await request(app)
      .put(`/api/v1/prompts/${promptId}/tools/${t.body.id}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ tool_alias: 'production' })
      .expect(200);

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
      .send({ messages: [{ role: 'system', content: 'help {{ name }}' }] })
      .expect(201);
    await request(app)
      .put(`/api/v1/prompts/${promptId}/tools/${t.body.id}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ tool_alias: 'production' })
      .expect(200);

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
      .send({ messages: [{ role: 'system', content: 'help {{ name }}' }] })
      .expect(201);
    await request(app)
      .put(`/api/v1/prompts/${promptId}/tools/${t.body.id}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ tool_alias: 'production' })
      .expect(200);

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

describe('GET /api/v1/prompt-versions?name=&alias=', () => {
  it('returns the version an alias points at, by prompt name, and follows a promote', async () => {
    const { apiKey, promptId, promptName } = await setupPromptWithVersions(2);

    const first = await request(app)
      .get('/api/v1/prompt-versions')
      .query({ name: promptName, alias: 'production' })
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);
    // The same shape as GET /prompts/:id/versions/:n, so SDKs read it with one parser.
    const direct = await request(app)
      .get(`/api/v1/prompts/${promptId}/versions/1`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);
    expect(first.body).toEqual(direct.body);
    expect(first.body.messages[0].content).toBe('Version 1 content for {{ name }}');

    await request(app)
      .post(`/api/v1/prompts/${promptId}/aliases/production/promote`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ version_number: 2 })
      .expect(200);
    const moved = await request(app)
      .get('/api/v1/prompt-versions')
      .query({ name: promptName, alias: 'production' })
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);
    expect(moved.body.versionNumber).toBe(2);
  });

  it('answers 404 NOT_FOUND for an unknown name or alias, and 400 without both params', async () => {
    const { apiKey, promptName } = await setupPromptWithVersions(1);
    const get = (query: Record<string, string>) =>
      request(app).get('/api/v1/prompt-versions').query(query).set('Authorization', `Bearer ${apiKey}`);

    expect((await get({ name: 'no-such-prompt', alias: 'production' }).expect(404)).body.error.code).toBe('NOT_FOUND');
    expect((await get({ name: promptName, alias: 'canary' }).expect(404)).body.error.code).toBe('NOT_FOUND');
    expect((await get({ name: promptName }).expect(400)).body.error.code).toBe('VALIDATION_ERROR');
  });

  it('never resolves another team’s prompt', async () => {
    const { promptName } = await setupPromptWithVersions(1);
    const { agent } = await authedAgent(app);
    const res = await agent.get('/api/v1/prompt-versions').query({ name: promptName, alias: 'production' }).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

// Pinning a version (phase-5 FAQ Q58): an app tests a version no alias points at
// yet, without moving the alias. The alias keeps deciding the tools.
describe('pinning a version on render and on GET /prompt-versions', () => {
  it('renders the pinned version through the alias, keeps the alias tools, and leaves the alias where it was', async () => {
    const { apiKey, promptId, promptName } = await setupPromptWithVersions(2);
    const auth = { Authorization: `Bearer ${apiKey}` };

    const t = await request(app).post('/api/v1/tools').set(auth).send({ name: 'lookup', description: 'l' }).expect(201);
    await request(app)
      .post(`/api/v1/tools/${t.body.id}/versions`)
      .set(auth)
      .send({ description: 'l', parametersSchema: { type: 'object', properties: {} }, executor: { type: 'client' } })
      .expect(201);
    // Bound to production only, so a render through staging would carry no tools.
    await request(app)
      .put(`/api/v1/prompts/${promptId}/aliases/production/tools/${t.body.id}`)
      .set(auth)
      .send({ tool_alias: 'production' })
      .expect(200);

    const pinned = await request(app)
      .post(`/api/v1/prompts/${promptName}/production/render`)
      .set(auth)
      .send({ variables: { name: 'Al' }, version: 2 })
      .expect(200);
    expect(pinned.body.messages[0].content).toBe('Version 2 content for Al');
    expect(pinned.body.versionNumber).toBe(2);
    expect(pinned.body.tools.map((x: { function: { name: string } }) => x.function.name)).toEqual(['lookup']);

    // Without the pin, production still renders version 1: nothing moved.
    const unpinned = await request(app)
      .post(`/api/v1/prompts/${promptName}/production/render`)
      .set(auth)
      .send({ variables: { name: 'Al' } })
      .expect(200);
    expect(unpinned.body.messages[0].content).toBe('Version 1 content for Al');

    const byNumber = await request(app)
      .get('/api/v1/prompt-versions')
      .query({ name: promptName, version: 2 })
      .set(auth)
      .expect(200);
    expect(byNumber.body.versionNumber).toBe(2);
    expect(byNumber.body.messages[0].content).toBe('Version 2 content for {{ name }}');
  });

  it('checks a named alias on a pinned read the same way a pinned render does', async () => {
    const { apiKey, promptName } = await setupPromptWithVersions(2);
    const auth = { Authorization: `Bearer ${apiKey}` };

    // A misspelled alias: the render refuses it, so the read must too, or the
    // SDK's pinned get_by_alias and its pinned render disagree on one call.
    await request(app)
      .post(`/api/v1/prompts/${promptName}/prodution/render`)
      .set(auth)
      .send({ variables: { name: 'Al' }, version: 2 })
      .expect(404);
    const read = await request(app)
      .get('/api/v1/prompt-versions')
      .query({ name: promptName, alias: 'prodution', version: 2 })
      .set(auth)
      .expect(404);
    expect(read.body.error.code).toBe('NOT_FOUND');

    // A real alias with a pin still returns the pinned version, not the alias's.
    const pinned = await request(app)
      .get('/api/v1/prompt-versions')
      .query({ name: promptName, alias: 'production', version: 2 })
      .set(auth)
      .expect(200);
    expect(pinned.body.versionNumber).toBe(2);
  });

  it('answers 404 for a version the prompt does not have, and 400 for a version that is not a number', async () => {
    const { apiKey, promptName } = await setupPromptWithVersions(1);
    const auth = { Authorization: `Bearer ${apiKey}` };

    const render = await request(app)
      .post(`/api/v1/prompts/${promptName}/production/render`)
      .set(auth)
      .send({ variables: { name: 'Al' }, version: 9 })
      .expect(404);
    expect(render.body.error.code).toBe('NOT_FOUND');
    expect(render.body.error.message).toContain('Version 9');

    await request(app).get('/api/v1/prompt-versions').query({ name: promptName, version: 9 }).set(auth).expect(404);
    const bad = await request(app)
      .get('/api/v1/prompt-versions')
      .query({ name: promptName, version: 'two' })
      .set(auth)
      .expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// Teams created before names were unique can still hold two active prompts with one
// name. Every by-name lookup must then resolve to the same one — the oldest — rather
// than to whichever row Postgres happens to return first.
describe('by-name lookups with two active prompts sharing a name (pre-uniqueness data)', () => {
  async function setupLegacyDuplicate(): Promise<{ apiKey: string; olderId: string }> {
    const { apiKey, promptId: newerId, promptName } = await setupPromptWithVersions(1);
    const newer = await prisma.prompt.findUniqueOrThrow({ where: { id: newerId } });

    // Inserted second, so its alias rows sit after the first prompt's on disk, but
    // dated earlier: an unordered lookup finds `newer`, an oldest-first one `older`.
    const older = await prisma.prompt.create({
      data: {
        name: promptName,
        teamId: newer.teamId,
        createdBy: newer.createdBy,
        createdAt: new Date(newer.createdAt.getTime() - 60_000),
      },
    });
    await request(app)
      .post(`/api/v1/prompts/${older.id}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'system', content: 'Older prompt for {{ name }}' }] })
      .expect(201);

    return { apiKey, olderId: older.id };
  }

  it('render by name serves the oldest prompt', async () => {
    const { apiKey, olderId } = await setupLegacyDuplicate();
    const { name } = await prisma.prompt.findUniqueOrThrow({ where: { id: olderId } });

    const res = await request(app)
      .post(`/api/v1/prompts/${name}/production/render`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ variables: { name: 'Ada' } })
      .expect(200);

    expect(JSON.stringify(res.body.messages)).toContain('Older prompt for Ada');
  });

  // The oldest prompt is picked by name first and the alias second. Filtering on the
  // alias first would serve the newer prompt here, then switch to the older one the
  // moment it gained a production alias.
  it('render by name does not fall through to a newer prompt when the oldest lacks the alias', async () => {
    const { apiKey, olderId } = await setupLegacyDuplicate();
    const { name } = await prisma.prompt.findUniqueOrThrow({ where: { id: olderId } });
    await prisma.promptAlias.deleteMany({ where: { promptId: olderId, alias: 'production' } });

    await request(app)
      .post(`/api/v1/prompts/${name}/production/render`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ variables: { name: 'Ada' } })
      .expect(404);
    await request(app)
      .post(`/api/v1/prompts/${name}/production/render`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ variables: { name: 'Ada' }, version: 1 })
      .expect(404);

    const staging = await request(app)
      .post(`/api/v1/prompts/${name}/staging/render`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ variables: { name: 'Ada' } })
      .expect(200);
    expect(JSON.stringify(staging.body.messages)).toContain('Older prompt for Ada');
  });

  it('lets the newer prompt save its description without changing its name', async () => {
    const { apiKey, olderId } = await setupLegacyDuplicate();
    const { name, teamId } = await prisma.prompt.findUniqueOrThrow({ where: { id: olderId } });
    const newer = await prisma.prompt.findFirstOrThrow({ where: { teamId, name, id: { not: olderId } } });

    const res = await request(app)
      .patch(`/api/v1/prompts/${newer.id}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name, description: 'Edited from Settings' })
      .expect(200);

    expect(res.body.description).toBe('Edited from Settings');
  });
});
