import request from 'supertest';
import { z } from 'zod/v4';
import { acruxcore } from '../../src/client';
import { acrux } from '../../src/tools';
import { _resetSyncCacheForTesting } from '../../src/tools-api';
import { _resetCacheForTesting } from '../../src/cache';
import prisma from '../../../../apps/api/src/shared/db/client';
import { signupTestUserWithApiKey } from '../../../../apps/api/src/test-utils/auth';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createApp } = require('../../../../apps/api/app');

const app = createApp();

/**
 * Real-flow vs. fallback boundary (TC6 Task 4, plan-authorized):
 *
 * `renderPrompt`'s `{ messages, tools }` shape is covered here end-to-end against
 * the real API + real Postgres: a real tool is created via the Tools Catalog API,
 * committed to a version, attached to a prompt version, and `renderPrompt` is
 * asserted to return it in `tools`. This is the part TC6 actually changed
 * (Task 2), so it gets full real-flow coverage per this repo's testing philosophy.
 *
 * `runToolLoop`'s dispatch loop is intentionally NOT re-covered here against a real
 * gateway model. Reasons:
 *   1. No live test in `apps/api/src/gateway/completions/completions.test.ts`
 *      exercises tool-calling end-to-end (its `describe('... (live)')` block only
 *      sends plain messages) — standing one up would be new harness work, not a
 *      straightforward extension of an existing pattern.
 *   2. `RunToolLoopOptions` has no `tool_choice` knob, so a live test cannot force
 *      the model to call a tool on a given turn — whether/when the model decides to
 *      call the tool is nondeterministic, which would make the test flaky in CI.
 *   3. `runToolLoop`'s actual logic (dispatch, transcript building, iteration
 *      counting, maxIterations cap) is already fully covered with a mocked
 *      `fetch` in `packages/sdk/test/unit/client.test.ts` ("runToolLoop" describe
 *      block, added in Task 3) — real HTTP plumbing there is irrelevant to what
 *      that logic needs to prove.
 * This mirrors the plan's own pre-authorized fallback: real-flow-cover the render
 * shape, unit-cover the loop.
 */

/**
 * Signs up a real user and mints a personal API key.
 *
 * Delegates to apps/api's own `signupTestUserWithApiKey` rather than posting to an auth
 * endpoint directly. These suites used to hard-code `/api/v1/auth/signup`, which stopped
 * existing when auth moved to Better Auth — every test 404'd at setup. Sharing the
 * fixture means the next auth change fixes these suites for free.
 */
async function setupUserAndKey(): Promise<{ apiKey: string; cookie: string }> {
  const ctx = await signupTestUserWithApiKey(app);
  return { apiKey: ctx.apiKey, cookie: ctx.cookie };
}

/**
 * Boots the real Express app on a real port and returns a live `acruxcore` client
 * pointed at it, plus a closer. `ToolsNamespace`'s new lifecycle methods call
 * `this.client._request` → real `fetch`, unlike supertest's `request(app)` wrapper, so
 * the client needs an actual listening socket rather than an in-memory supertest binding.
 */
async function startLiveClient(apiKey: string): Promise<{ hub: acruxcore; close: () => Promise<void> }> {
  const http = await import('http');
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const hub = new acruxcore({ apiKey, baseUrl: `http://localhost:${port}/api/v1`, maxRetries: 0 });
  return {
    hub,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Creates a tool + a committed version (client-executed, per TC1) and returns its id. */
async function createToolWithVersion(
  cookie: string,
  name: string,
  description: string,
): Promise<string> {
  const toolRes = await request(app)
    .post('/api/v1/tools')
    .set('Cookie', cookie)
    .send({ name, description })
    .expect(201);
  const toolId: string = toolRes.body.id as string;

  await request(app)
    .post(`/api/v1/tools/${toolId}/versions`)
    .set('Cookie', cookie)
    .send({
      parametersSchema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
      executor: { type: 'client' },
    })
    .expect(201);

  return toolId;
}

beforeEach(async () => {
  _resetCacheForTesting();
  _resetSyncCacheForTesting();
  await prisma.$executeRaw`TRUNCATE TABLE prompt_version_tools, tool_aliases, tool_versions, tools, prompt_aliases, prompt_versions, audit_log, prompts, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('acruxcore SDK tools integration', () => {
  it('renderPrompt returns the attached tool in `tools`, alongside the rendered messages', async () => {
    const { apiKey, cookie } = await setupUserAndKey();

    const toolId = await createToolWithVersion(cookie, `get_weather_${Date.now()}`, 'Looks up current weather for a city');

    const promptRes = await request(app)
      .post('/api/v1/prompts')
      .set('Cookie', cookie)
      .send({ name: `weather-prompt-${Date.now()}` })
      .expect(201);
    const promptName: string = promptRes.body.name as string;
    const promptId: string = promptRes.body.id as string;

    await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Cookie', cookie)
      .send({
        messages: [
          { role: 'system', content: 'You are a helpful weather assistant.' },
          { role: 'user', content: "What's the weather in {{ city }}?" },
        ],
        tools: [{ toolId }],
      })
      .expect(201);

    const http = await import('http');
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    const hub = new acruxcore({ apiKey, baseUrl: `http://localhost:${port}/api/v1`, maxRetries: 0 });

    const { messages, tools } = await hub.prompts.render(promptName, 'production', { city: 'Paris' });

    // Real templated messages, exactly like the non-tools render path
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'system', content: 'You are a helpful weather assistant.' });
    expect(messages[1]).toEqual({ role: 'user', content: "What's the weather in Paris?" });

    // Real attached tool, resolved through the Tools Catalog + PromptToolResolver
    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual({
      type: 'function',
      function: {
        name: expect.stringContaining('get_weather_'),
        description: 'Looks up current weather for a city',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    });

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('renderPrompt returns an empty `tools` array when no tools are attached', async () => {
    const { apiKey, cookie } = await setupUserAndKey();

    const promptRes = await request(app)
      .post('/api/v1/prompts')
      .set('Cookie', cookie)
      .send({ name: `no-tools-prompt-${Date.now()}` })
      .expect(201);
    const promptId: string = promptRes.body.id as string;
    const promptName: string = promptRes.body.name as string;

    await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Cookie', cookie)
      .send({ messages: [{ role: 'user', content: 'Hello!' }] })
      .expect(201);

    const http = await import('http');
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    const hub = new acruxcore({ apiKey, baseUrl: `http://localhost:${port}/api/v1`, maxRetries: 0 });

    const result = await hub.prompts.render(promptName, 'production');

    expect(result.tools).toEqual([]);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('acrux.tool -> tools.sync creates the catalog rows, and is idempotent', async () => {
    const { apiKey } = await setupUserAndKey();

    const http = await import('http');
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const hub = new acruxcore({ apiKey, baseUrl: `http://localhost:${port}/api/v1`, maxRetries: 0 });

    const lookupOrder = acrux.tool(
      {
        name: 'lookup_order',
        description: 'Look up an order by id.',
        parameters: z.object({ order_id: z.string().describe('The order id.') }),
        changelog: 'derived from lookupOrder()',
      },
      async ({ order_id }) => ({ order_id, status: 'shipped' }),
    );

    // First sync creates the tool, v1, and both aliases.
    const [first] = await hub.tools.sync([lookupOrder]);
    expect(first?.committed).toBe(true);
    expect(first?.versionNumber).toBe(1);
    expect(first?.alias).toBe('production');

    // Real rows, read straight from Postgres — the derived zod schema landed verbatim.
    const version = await prisma.toolVersion.findFirst({
      where: { toolId: first?.toolId },
      orderBy: { versionNumber: 'desc' },
    });
    expect(version?.description).toBe('Look up an order by id.');
    expect(version?.changelog).toBe('derived from lookupOrder()');
    expect(version?.source).toBe('code');
    expect(version?.parametersSchema).toMatchObject({
      type: 'object',
      properties: { order_id: { type: 'string', description: 'The order id.' } },
      required: ['order_id'],
    });

    const aliases = await prisma.toolAlias.findMany({ where: { toolId: first?.toolId } });
    expect(aliases.map((a) => a.alias).sort()).toEqual(['production', 'staging']);

    // A fresh client bypasses the process-wide sync cache, so this exercises the
    // SERVER's idempotency rather than the client's memoisation.
    _resetSyncCacheForTesting();
    const [second] = await hub.tools.sync([lookupOrder]);
    expect(second?.committed).toBe(false);
    expect(second?.versionNumber).toBe(1);
    expect(await prisma.toolVersion.count({ where: { toolId: first?.toolId } })).toBe(1);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('tools.resolve returns the schema and executorType, never the executor', async () => {
    const { apiKey, cookie } = await setupUserAndKey();
    const toolName = `get_weather_${Date.now()}`;
    await createToolWithVersion(cookie, toolName, 'Looks up current weather for a city');

    const http = await import('http');
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const hub = new acruxcore({ apiKey, baseUrl: `http://localhost:${port}/api/v1`, maxRetries: 0 });

    const resolved = await hub.tools.resolve([{ name: toolName }]);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.executorType).toBe('client');
    expect(resolved[0]?.versionNumber).toBe(1);
    expect(resolved[0]?.function).toEqual({
      name: toolName,
      description: 'Looks up current weather for a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    });
    // The executor definition stays server-side: it can hold urls, headers and
    // {{secret.NAME}} references that must not reach a client.
    expect(resolved[0]).not.toHaveProperty('executor');

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('tools.resolve reports every unresolvable ref in one 404', async () => {
    const { apiKey, cookie } = await setupUserAndKey();
    const toolName = `get_weather_${Date.now()}`;
    await createToolWithVersion(cookie, toolName, 'Looks up current weather for a city');

    const http = await import('http');
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const hub = new acruxcore({ apiKey, baseUrl: `http://localhost:${port}/api/v1`, maxRetries: 0 });

    // A partial success would let a loop start without one of its tools and give no
    // reason why, so resolve is all-or-nothing and names every failure at once.
    await expect(
      hub.tools.resolve([{ name: 'ghost_one' }, { name: toolName }, { name: 'ghost_two' }]),
    ).rejects.toMatchObject({ statusCode: 404 });

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('runs the full tool lifecycle: create -> versions -> alias promote -> analytics -> delete', async () => {
    const { apiKey } = await setupUserAndKey();
    const { hub, close } = await startLiveClient(apiKey);

    try {
      // create -> get -> update
      const created = await hub.tools.create({
        name: `lifecycle_tool_${Date.now()}`,
        description: 'Initial description',
      });
      expect(created.id).toEqual(expect.any(String));
      expect(created.description).toBe('Initial description');

      const fetched = await hub.tools.get(created.id);
      expect(fetched).toEqual(created);

      const updated = await hub.tools.update(created.id, { description: 'Updated description' });
      expect(updated.description).toBe('Updated description');
      expect(updated.name).toBe(created.name);

      // list — the created tool appears
      const listPage = await hub.tools.list();
      expect(listPage.data.map((t) => t.id)).toContain(created.id);

      // commitVersion v1 (client executor) — aliases present (first version mints both)
      const v1 = await hub.tools.commitVersion(created.id, {
        parametersSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        executor: { type: 'client' },
      });
      expect(v1.versionNumber).toBe(1);
      expect(v1.toolId).toBe(created.id);
      expect(v1.aliases).toBeDefined();
      expect(v1.aliases?.map((a) => a.alias).sort()).toEqual(['production', 'staging']);
      expect(v1.aliases?.every((a) => a.versionNumber === 1)).toBe(true);
      expect(v1.warnings).toBeUndefined();

      // commitVersion v2 (http executor) — aliases absent (committing never moves an alias by itself)
      const v2 = await hub.tools.commitVersion(created.id, {
        description: 'Looks up the weather via a public API',
        parametersSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        executor: {
          type: 'http',
          url: 'https://httpbin.org/get',
          method: 'GET',
          headers: [],
          query: [{ name: 'city', value: '{{city}}' }],
          argMapping: [{ arg: 'city', in: 'query' }],
        },
      });
      expect(v2.versionNumber).toBe(2);
      expect(v2.aliases).toBeUndefined();
      expect(v2.warnings).toBeUndefined();
      expect(v2.executor).toEqual({
        type: 'http',
        url: 'https://httpbin.org/get',
        method: 'GET',
        headers: [],
        query: [{ name: 'city', value: '{{city}}' }],
        argMapping: [{ arg: 'city', in: 'query' }],
      });

      // commitVersion v3 (changelog only, no description) — warnings present
      const v3 = await hub.tools.commitVersion(created.id, {
        changelog: 'Tweaked argument mapping',
        parametersSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        executor: { type: 'client' },
      });
      expect(v3.versionNumber).toBe(3);
      expect(v3.aliases).toBeUndefined();
      expect(v3.warnings).toBeDefined();
      expect(v3.warnings?.length).toBeGreaterThan(0);

      // listVersions — newest first, no parametersSchema/executor on list items
      const versionsPage = await hub.tools.listVersions(created.id);
      expect(versionsPage.total).toBe(3);
      expect(versionsPage.data.map((v) => v.versionNumber)).toEqual([3, 2, 1]);
      expect(versionsPage.data[0]).not.toHaveProperty('parametersSchema');
      expect(versionsPage.data[0]).not.toHaveProperty('executor');
      expect(versionsPage.data[0]?.toolId).toBe(created.id);

      // getVersion — full parametersSchema/executor present, never aliases/warnings
      const gotV2 = await hub.tools.getVersion(created.id, 2);
      expect(gotV2.parametersSchema).toEqual(v2.parametersSchema);
      expect(gotV2.executor).toEqual(v2.executor);
      expect(gotV2).not.toHaveProperty('aliases');
      expect(gotV2).not.toHaveProperty('warnings');

      // promoteAlias — move `production` to v2
      const promoted = await hub.tools.promoteAlias(created.id, 'production', 2);
      expect(promoted.alias).toBe('production');
      expect(promoted.versionNumber).toBe(2);

      // analytics — no executions happened in this test
      const analytics = await hub.tools.analytics();
      expect(analytics).toEqual({ data: [] });

      // delete -> get on the deleted id throws API_ERROR / 404
      await hub.tools.delete(created.id);
      await expect(hub.tools.get(created.id)).rejects.toMatchObject({
        name: 'acruxcoreError',
        code: 'API_ERROR',
        statusCode: 404,
      });
    } finally {
      await close();
    }
  });

  it('surfaces VALIDATION_ERROR/TOOL_NAME_TAKEN/404 for the tool + version + analytics error paths', async () => {
    const { apiKey } = await setupUserAndKey();
    const { hub, close } = await startLiveClient(apiKey);

    try {
      await expect(hub.tools.create({ name: 'bad name!' })).rejects.toMatchObject({
        name: 'acruxcoreError',
        code: 'API_ERROR',
        statusCode: 400,
        body: { error: { code: 'VALIDATION_ERROR' } },
      });

      const toolName = `taken_name_${Date.now()}`;
      const first = await hub.tools.create({ name: toolName });
      expect(first.id).toEqual(expect.any(String));

      await expect(hub.tools.create({ name: toolName })).rejects.toMatchObject({
        name: 'acruxcoreError',
        code: 'API_ERROR',
        statusCode: 409,
        body: { error: { code: 'TOOL_NAME_TAKEN' } },
      });

      await hub.tools.commitVersion(first.id, {
        parametersSchema: { type: 'object', properties: {} },
        executor: { type: 'client' },
      });
      await expect(hub.tools.getVersion(first.id, 99)).rejects.toMatchObject({
        name: 'acruxcoreError',
        code: 'API_ERROR',
        statusCode: 404,
      });

      await expect(hub.tools.analytics({ since: 'not-a-date' })).rejects.toMatchObject({
        name: 'acruxcoreError',
        code: 'API_ERROR',
        statusCode: 400,
        body: { error: { code: 'VALIDATION_ERROR' } },
      });
    } finally {
      await close();
    }
  });
});
