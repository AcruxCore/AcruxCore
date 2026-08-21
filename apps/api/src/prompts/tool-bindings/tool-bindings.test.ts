import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { signupTestUserWithApiKey } from '../../test-utils';

const app = createApp();

const paramsSchema = { type: 'object', properties: {} };
const clientExecutor = { type: 'client' as const };

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE prompt_tool_bindings, tool_aliases, tool_versions, tools, prompt_aliases, prompt_versions, prompts, audit_log, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
});
afterAll(async () => {
  await prisma.$disconnect();
});

/** Creates `get_weather` with two versions, then production→v2 while staging stays v1. */
async function toolWithDivergedAliases(apiKey: string, name = 'get_weather'): Promise<string> {
  const t = await request(app)
    .post('/api/v1/tools')
    .set('Authorization', `Bearer ${apiKey}`)
    .send({ name })
    .expect(201);
  const toolId: string = t.body.id;

  for (let i = 0; i < 2; i++) {
    await request(app)
      .post(`/api/v1/tools/${toolId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ parametersSchema: paramsSchema, executor: clientExecutor })
      .expect(201);
  }

  // production + staging are auto-created at v1 by the first commit; move production to v2.
  await request(app)
    .post(`/api/v1/tools/${toolId}/aliases/production/promote`)
    .set('Authorization', `Bearer ${apiKey}`)
    .send({ version_number: 2 })
    .expect(200);

  return toolId;
}

/** Creates a prompt with one committed version; production and staging both serve v1. */
async function promptWithVersion(apiKey: string, name = 'weather-brief'): Promise<string> {
  const p = await request(app)
    .post('/api/v1/prompts')
    .set('Authorization', `Bearer ${apiKey}`)
    .send({ name })
    .expect(201);
  const promptId: string = p.body.id;

  await request(app)
    .post(`/api/v1/prompts/${promptId}/versions`)
    .set('Authorization', `Bearer ${apiKey}`)
    .send({ messages: [{ role: 'user', content: 'Weather in {{ city }}?' }] })
    .expect(201);

  return promptId;
}

/**
 * Waits for `count` binding audit rows to land.
 *
 * `audit()` is deliberately fire-and-forget (`void audit(...)`) everywhere in the
 * codebase, so a row is not guaranteed written by the time the HTTP response
 * returns. Most suites get away with a bare query because a later request buys
 * the write time; a test whose last action is the audited one does not. Polling
 * keeps the assertion exact instead of trading it for a fixed sleep.
 */
async function waitForBindingAudit(count: number, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await prisma.auditLog.findMany({
      where: { event: { in: ['prompt_tool_route_set', 'prompt_tool_route_removed'] } },
      orderBy: { createdAt: 'asc' },
    });
    if (rows.length >= count || Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Renders through a prompt alias and returns the response body. */
async function render(apiKey: string, promptName: string, alias: string) {
  const res = await request(app)
    .post(`/api/v1/prompts/${promptName}/${alias}/render`)
    .set('Authorization', `Bearer ${apiKey}`)
    .send({ variables: { city: 'Lahore' } })
    .expect(200);
  return res.body;
}

describe('default bindings', () => {
  it('binds once and every alias inherits, resolving through the tool alias', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await toolWithDivergedAliases(apiKey);
    const promptId = await promptWithVersion(apiKey);

    await request(app)
      .put(`/api/v1/prompts/${promptId}/tools/${toolId}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ tool_alias: 'production' })
      .expect(200);

    // Both aliases inherit, and both resolve to whatever production points at (v2).
    for (const alias of ['production', 'staging']) {
      const body = await render(apiKey, 'weather-brief', alias);
      expect(body.tools).toHaveLength(1);
      expect(body.toolResolutions).toEqual([
        { name: 'get_weather', alias: 'production', versionNumber: 2, source: 'default' },
      ]);
    }
  });

  it('follows the tool alias when it moves, with no prompt change', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await toolWithDivergedAliases(apiKey);
    const promptId = await promptWithVersion(apiKey);

    await request(app)
      .put(`/api/v1/prompts/${promptId}/tools/${toolId}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ tool_alias: 'production' })
      .expect(200);

    expect((await render(apiKey, 'weather-brief', 'production')).toolResolutions[0].versionNumber).toBe(2);

    // Roll the tool's production alias back to v1 — the prompt must follow.
    await request(app)
      .post(`/api/v1/tools/${toolId}/aliases/production/promote`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ version_number: 1 })
      .expect(200);

    expect((await render(apiKey, 'weather-brief', 'production')).toolResolutions[0].versionNumber).toBe(1);
  });

  it('unbinds for every inheriting alias on DELETE', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await toolWithDivergedAliases(apiKey);
    const promptId = await promptWithVersion(apiKey);

    await request(app)
      .put(`/api/v1/prompts/${promptId}/tools/${toolId}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ tool_alias: 'production' })
      .expect(200);
    await request(app)
      .delete(`/api/v1/prompts/${promptId}/tools/${toolId}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(204);

    expect((await render(apiKey, 'weather-brief', 'production')).tools).toHaveLength(0);
    expect(await prisma.promptToolBinding.count({ where: { promptId } })).toBe(0);
  });

  it('rejects off on the default, where there is nothing to contradict', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await toolWithDivergedAliases(apiKey);
    const promptId = await promptWithVersion(apiKey);

    const res = await request(app)
      .put(`/api/v1/prompts/${promptId}/tools/${toolId}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ off: true })
      .expect(400);
    expect(res.body.error.message).toMatch(/off applies to a prompt alias/i);
  });

  it('400s a tool alias that does not exist, rather than going dormant', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await toolWithDivergedAliases(apiKey);
    const promptId = await promptWithVersion(apiKey);

    const res = await request(app)
      .put(`/api/v1/prompts/${promptId}/tools/${toolId}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ tool_alias: 'nope' })
      .expect(400);
    expect(res.body.error.message).toMatch(/has no alias 'nope'/);
    // The aliases it does have are named, so a typo is fixable from the message.
    expect(res.body.error.message).toMatch(/'production'/);
    expect(res.body.error.message).toMatch(/'staging'/);
    expect(await prisma.promptToolBinding.count({ where: { promptId } })).toBe(0);
  });

  it('explains that a name-only tool has no aliases because it has no versions', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const promptId = await promptWithVersion(apiKey);

    // A tool created as a name only: no version committed, so no aliases exist.
    const t = await request(app)
      .post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'get_weather' })
      .expect(201);

    const res = await request(app)
      .put(`/api/v1/prompts/${promptId}/tools/${t.body.id}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ tool_alias: 'production' })
      .expect(400);
    expect(res.body.error.message).toMatch(/no versions yet/);
    expect(res.body.error.message).toMatch(/Commit a first version/);
    expect(await prisma.promptToolBinding.count({ where: { promptId } })).toBe(0);
  });

  it('400s when the body names more than one of the three states', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await toolWithDivergedAliases(apiKey);
    const promptId = await promptWithVersion(apiKey);

    await request(app)
      .put(`/api/v1/prompts/${promptId}/tools/${toolId}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ tool_alias: 'production', pinned_version_number: 1 })
      .expect(400);
  });
});

describe('per-alias bindings', () => {
  it('overrides one alias and leaves the others on the default', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await toolWithDivergedAliases(apiKey);
    const promptId = await promptWithVersion(apiKey);

    await request(app)
      .put(`/api/v1/prompts/${promptId}/tools/${toolId}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ tool_alias: 'production' })
      .expect(200);

    // staging should call the tool's staging build (v1) instead.
    await request(app)
      .put(`/api/v1/prompts/${promptId}/aliases/staging/tools/${toolId}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ tool_alias: 'staging' })
      .expect(200);

    const prod = await render(apiKey, 'weather-brief', 'production');
    const stag = await render(apiKey, 'weather-brief', 'staging');

    expect(prod.toolResolutions).toEqual([
      { name: 'get_weather', alias: 'production', versionNumber: 2, source: 'default' },
    ]);
    expect(stag.toolResolutions).toEqual([
      { name: 'get_weather', alias: 'staging', versionNumber: 1, source: 'alias' },
    ]);
  });

  it('off removes the tool for that alias only', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await toolWithDivergedAliases(apiKey);
    const promptId = await promptWithVersion(apiKey);

    await request(app)
      .put(`/api/v1/prompts/${promptId}/tools/${toolId}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ tool_alias: 'production' })
      .expect(200);
    await request(app)
      .put(`/api/v1/prompts/${promptId}/aliases/staging/tools/${toolId}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ off: true })
      .expect(200);

    expect((await render(apiKey, 'weather-brief', 'production')).tools).toHaveLength(1);
    expect((await render(apiKey, 'weather-brief', 'staging')).tools).toHaveLength(0);
  });

  it('a pin ignores the tool alias moving', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await toolWithDivergedAliases(apiKey);
    const promptId = await promptWithVersion(apiKey);

    await request(app)
      .put(`/api/v1/prompts/${promptId}/aliases/production/tools/${toolId}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ pinned_version_number: 1 })
      .expect(200);

    // Move every tool alias to v2; the pin must still resolve to v1.
    await request(app)
      .post(`/api/v1/tools/${toolId}/aliases/staging/promote`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ version_number: 2 })
      .expect(200);

    const body = await render(apiKey, 'weather-brief', 'production');
    expect(body.toolResolutions).toEqual([
      { name: 'get_weather', pinnedVersionNumber: 1, versionNumber: 1, source: 'alias' },
    ]);
  });

  it('DELETE on one pair returns it to the default', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await toolWithDivergedAliases(apiKey);
    const promptId = await promptWithVersion(apiKey);

    await request(app)
      .put(`/api/v1/prompts/${promptId}/tools/${toolId}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ tool_alias: 'production' })
      .expect(200);
    await request(app)
      .put(`/api/v1/prompts/${promptId}/aliases/staging/tools/${toolId}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ tool_alias: 'staging' })
      .expect(200);
    await request(app)
      .delete(`/api/v1/prompts/${promptId}/aliases/staging/tools/${toolId}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(204);

    const stag = await render(apiKey, 'weather-brief', 'staging');
    expect(stag.toolResolutions[0]).toMatchObject({ alias: 'production', source: 'default' });
  });

  it('resets a whole alias back to the default', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const a = await toolWithDivergedAliases(apiKey, 'tool_a');
    const b = await toolWithDivergedAliases(apiKey, 'tool_b');
    const promptId = await promptWithVersion(apiKey);

    for (const toolId of [a, b]) {
      await request(app)
        .put(`/api/v1/prompts/${promptId}/tools/${toolId}`)
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ tool_alias: 'production' })
        .expect(200);
      await request(app)
        .put(`/api/v1/prompts/${promptId}/aliases/staging/tools/${toolId}`)
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ tool_alias: 'staging' })
        .expect(200);
    }

    await request(app)
      .delete(`/api/v1/prompts/${promptId}/aliases/staging/tools`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(204);

    expect(await prisma.promptToolBinding.count({ where: { promptId, promptAlias: 'staging' } })).toBe(0);
    const stag = await render(apiKey, 'weather-brief', 'staging');
    expect(stag.toolResolutions.every((r: { source: string }) => r.source === 'default')).toBe(true);
    expect(stag.tools).toHaveLength(2);
  });

  it('404s resetting an alias that has no rows of its own', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const promptId = await promptWithVersion(apiKey);

    await request(app)
      .delete(`/api/v1/prompts/${promptId}/aliases/staging/tools`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(404);
  });
});

describe('a newly promoted alias', () => {
  // This is the regression the whole default-row design exists to prevent: an
  // alias created after the tools were bound must not render with zero tools.
  it('inherits the default immediately, with no configuration', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await toolWithDivergedAliases(apiKey);
    const promptId = await promptWithVersion(apiKey);

    await request(app)
      .put(`/api/v1/prompts/${promptId}/tools/${toolId}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ tool_alias: 'production' })
      .expect(200);

    // 'dev' does not exist yet at bind time.
    await request(app)
      .post(`/api/v1/prompts/${promptId}/aliases/dev/promote`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ version_number: 1 })
      .expect(200);

    const body = await render(apiKey, 'weather-brief', 'dev');
    expect(body.tools).toHaveLength(1);
    expect(body.toolResolutions[0]).toMatchObject({ source: 'default' });
  });

  it('accepts a binding set before the alias exists', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await toolWithDivergedAliases(apiKey);
    const promptId = await promptWithVersion(apiKey);

    // Keyed by name, not by the alias row, so this is allowed and waits.
    await request(app)
      .put(`/api/v1/prompts/${promptId}/aliases/canary/tools/${toolId}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ tool_alias: 'staging' })
      .expect(200);

    await request(app)
      .post(`/api/v1/prompts/${promptId}/aliases/canary/promote`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ version_number: 1 })
      .expect(200);

    const body = await render(apiKey, 'weather-brief', 'canary');
    expect(body.toolResolutions[0]).toMatchObject({ alias: 'staging', source: 'alias' });
  });
});

describe('GET /prompts/:id/tools', () => {
  it('reports the default, every alias, and which aliases are customised', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await toolWithDivergedAliases(apiKey);
    const promptId = await promptWithVersion(apiKey);

    await request(app)
      .put(`/api/v1/prompts/${promptId}/tools/${toolId}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ tool_alias: 'production' })
      .expect(200);
    await request(app)
      .put(`/api/v1/prompts/${promptId}/aliases/staging/tools/${toolId}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ pinned_version_number: 1 })
      .expect(200);

    const res = await request(app)
      .get(`/api/v1/prompts/${promptId}/tools`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);

    expect(res.body.data.default).toEqual([
      {
        toolId,
        toolName: 'get_weather',
        toolAlias: 'production',
        pinnedVersionNumber: null,
        off: false,
        resolvedVersionNumber: 2,
        position: 0,
      },
    ]);

    const byName = Object.fromEntries(
      res.body.data.aliases.map((a: { alias: string }) => [a.alias, a]),
    );
    expect(byName['production'].customised).toBe(false);
    expect(byName['production'].bindings).toEqual([]);
    expect(byName['staging'].customised).toBe(true);
    expect(byName['staging'].bindings[0]).toMatchObject({
      pinnedVersionNumber: 1,
      resolvedVersionNumber: 1,
      off: false,
    });
  });

  it('excludes a soft-deleted tool without anyone unbinding it', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await toolWithDivergedAliases(apiKey);
    const promptId = await promptWithVersion(apiKey);

    await request(app)
      .put(`/api/v1/prompts/${promptId}/tools/${toolId}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ tool_alias: 'production' })
      .expect(200);
    await request(app).delete(`/api/v1/tools/${toolId}`).set('Authorization', `Bearer ${apiKey}`).expect(204);

    const res = await request(app)
      .get(`/api/v1/prompts/${promptId}/tools`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);
    expect(res.body.data.default).toEqual([]);
    expect((await render(apiKey, 'weather-brief', 'production')).tools).toHaveLength(0);
  });

  it("404s another team's prompt", async () => {
    const a = await signupTestUserWithApiKey(app);
    const b = await signupTestUserWithApiKey(app);
    const promptId = await promptWithVersion(a.apiKey);

    await request(app)
      .get(`/api/v1/prompts/${promptId}/tools`)
      .set('Authorization', `Bearer ${b.apiKey}`)
      .expect(404);
  });
});

describe('audit trail', () => {
  it('records a set and a removal, so history survives without a snapshot table', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const toolId = await toolWithDivergedAliases(apiKey);
    const promptId = await promptWithVersion(apiKey);

    await request(app)
      .put(`/api/v1/prompts/${promptId}/aliases/production/tools/${toolId}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ tool_alias: 'staging' })
      .expect(200);
    await request(app)
      .delete(`/api/v1/prompts/${promptId}/aliases/production/tools/${toolId}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(204);

    const events = await waitForBindingAudit(2);
    expect(events.map((e) => e.event)).toEqual(['prompt_tool_route_set', 'prompt_tool_route_removed']);
    expect(events[0]?.metadata).toMatchObject({ promptAlias: 'production', toToolAlias: 'staging' });
  });
});
