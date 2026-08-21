import http from 'http';
import { acruxcore } from '../../src/client';
import prisma from '../../../../apps/api/src/shared/db/client';
import { signupTestUserWithApiKey } from '../../../../apps/api/src/test-utils/auth';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createApp } = require('../../../../apps/api/app');

const app = createApp();

/**
 * Signs up a real user and mints a personal API key. Delegates to apps/api's own
 * `signupTestUserWithApiKey` rather than posting to an auth endpoint directly —
 * see `tools.integration.test.ts` for why.
 */
async function setupUserAndKey(): Promise<{ apiKey: string }> {
  const ctx = await signupTestUserWithApiKey(app);
  return { apiKey: ctx.apiKey };
}

/**
 * Boots the real Express app on a real port and returns a live `acruxcore` client
 * pointed at it, plus a closer. `PromptsNamespace` methods call `this.client._request`
 * → real `fetch`, unlike supertest's `request(app)` wrapper, so the client needs an
 * actual listening socket rather than an in-memory supertest binding.
 */
async function startLiveClient(apiKey: string): Promise<{ hub: acruxcore; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const hub = new acruxcore({ apiKey, baseUrl: `http://localhost:${port}/api/v1`, maxRetries: 0 });
  return {
    hub,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE span_payloads, spans, traces, prompt_tool_bindings, tool_aliases, tool_versions, tools, prompt_aliases, prompt_versions, audit_log, prompts, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('acruxcore SDK prompts integration', () => {
  it('runs the full prompt-version lifecycle: create -> versions -> diff -> promote -> export/import -> traces -> delete', async () => {
    const { apiKey } = await setupUserAndKey();
    const { hub, close } = await startLiveClient(apiKey);

    try {
      // create -> get -> update
      const created = await hub.prompts.create({
        name: `lifecycle-prompt-${Date.now()}`,
        description: 'Initial description',
      });
      expect(created.id).toEqual(expect.any(String));
      expect(created.description).toBe('Initial description');

      const fetched = await hub.prompts.get(created.id);
      expect(fetched).toEqual(created);

      const updated = await hub.prompts.update(created.id, { description: 'Updated description' });
      expect(updated.description).toBe('Updated description');
      expect(updated.name).toBe(created.name);

      // commitVersion v1 — aliases present (first version mints both production + staging)
      const v1 = await hub.prompts.commitVersion(created.id, {
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Hello, {{ name }}!' },
        ],
      });
      expect(v1.versionNumber).toBe(1);
      expect(v1.promptId).toBe(created.id);
      expect(v1.variables).toEqual(['name']);
      expect(v1.aliases).toBeDefined();
      expect(v1.aliases?.map((a) => a.alias).sort()).toEqual(['production', 'staging']);
      expect(v1.aliases?.every((a) => a.versionNumber === 1)).toBe(true);

      // commitVersion v2 with a model — aliases absent (committing never moves an alias by itself)
      const v2 = await hub.prompts.commitVersion(created.id, {
        messages: [{ role: 'user', content: 'Hi there, {{ name }}!' }],
      });
      expect(v2.versionNumber).toBe(2);
      expect(v2.aliases).toBeUndefined();

      // listVersions — newest first, no `messages`/`promptId` on list items
      const versionsPage = await hub.prompts.listVersions(created.id);
      expect(versionsPage.total).toBe(2);
      expect(versionsPage.data.map((v) => v.versionNumber)).toEqual([2, 1]);
      expect(versionsPage.data[0]).not.toHaveProperty('messages');
      expect(versionsPage.data[0]).not.toHaveProperty('promptId');

      // getVersion — full content, never `aliases`
      const gotV1 = await hub.prompts.getVersion(created.id, 1);
      expect(gotV1.messages).toEqual(v1.messages);
      expect(gotV1).not.toHaveProperty('aliases');

      // diff(1, 2)
      const diffResult = await hub.prompts.diff(created.id, 1, 2);
      expect(diffResult.fromVersion).toBe(1);
      expect(diffResult.toVersion).toBe(2);
      expect(typeof diffResult.diff).toBe('string');
      expect(diffResult.diff.length).toBeGreaterThan(0);

      // promoteAlias — move `production` to v2
      const promoted = await hub.prompts.promoteAlias(created.id, 'production', 2);
      expect(promoted.alias).toBe('production');
      expect(promoted.versionNumber).toBe(2);

      // exportVersion
      const exported = await hub.prompts.exportVersion(created.id, 1);
      expect(exported.schemaVersion).toBe(1);
      expect(exported.prompt.name).toBe(created.name);
      expect(exported.version.versionNumber).toBe(1);
      expect(exported.version.messages).toEqual(v1.messages);

      // importPrompt — the just-exported file, as a brand new prompt
      const imported = await hub.prompts.importPrompt(exported);
      expect(imported.prompt.id).not.toBe(created.id);
      expect(imported.version.versionNumber).toBe(1);

      // tracesForVersion — no traces have been reported against this version yet
      const traces = await hub.prompts.tracesForVersion(created.id, 1);
      expect(traces).toEqual({ data: [], total: 0, page: 1, limit: 20 });

      // list — the created prompt appears
      const listPage = await hub.prompts.list();
      expect(listPage.data.map((p) => p.id)).toContain(created.id);
      expect(listPage.data.map((p) => p.id)).toContain(imported.prompt.id);

      // delete -> get on the deleted id throws API_ERROR / 404
      await hub.prompts.delete(created.id);
      await expect(hub.prompts.get(created.id)).rejects.toMatchObject({
        name: 'acruxcoreError',
        code: 'API_ERROR',
        statusCode: 404,
      });
    } finally {
      await close();
    }
  });

  it('surfaces VALIDATION_ERROR for an empty name and 404 for an unknown prompt', async () => {
    const { apiKey } = await setupUserAndKey();
    const { hub, close } = await startLiveClient(apiKey);

    try {
      await expect(hub.prompts.create({ name: '' })).rejects.toMatchObject({
        name: 'acruxcoreError',
        code: 'API_ERROR',
        statusCode: 400,
        body: { error: { code: 'VALIDATION_ERROR' } },
      });

      await expect(hub.prompts.get('00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({
        name: 'acruxcoreError',
        code: 'API_ERROR',
        statusCode: 404,
      });
    } finally {
      await close();
    }
  });

  describe('prompt tool bindings', () => {
    it('binds a tool by default, diverges one alias, and reports the source render() resolved through', async () => {
      const { apiKey } = await setupUserAndKey();
      const { hub, close } = await startLiveClient(apiKey);

      try {
        // A prompt with one committed version, so both aliases exist and can render.
        const prompt = await hub.prompts.create({ name: `binding-test-${Date.now()}` });
        await hub.prompts.commitVersion(prompt.id, {
          messages: [{ role: 'system', content: 'Answer with the weather.' }],
        });

        // A tool with two versions, so `staging` and `production` can point at
        // different builds — the whole point of binding by alias rather than by version.
        const tool = await hub.tools.create({ name: `binding_tool_${Date.now()}` });
        await hub.tools.commitVersion(tool.id, {
          parametersSchema: { type: 'object', properties: { city: { type: 'string' } } },
          executor: { type: 'client' },
        });
        await hub.tools.commitVersion(tool.id, {
          parametersSchema: { type: 'object', properties: { city: { type: 'string' } } },
          executor: { type: 'client' },
        });
        await hub.tools.promoteAlias(tool.id, 'staging', 2);

        // Default binding — inherited by every prompt alias with no row of its own.
        const bound = await hub.prompts.setToolBinding(prompt.id, tool.id, { toolAlias: 'production' });
        expect(bound).toMatchObject({ toolId: tool.id, toolAlias: 'production', off: false, resolvedVersionNumber: 1 });

        let bindings = await hub.prompts.listToolBindings(prompt.id);
        expect(bindings.default.map((b) => b.toolId)).toEqual([tool.id]);
        expect(bindings.aliases.map((a) => a.alias).sort()).toEqual(['production', 'staging']);
        expect(bindings.aliases.every((a) => a.customised === false)).toBe(true);

        // `production` inherits, so its resolution reports the default as the source.
        const inherited = await hub.prompts.render(prompt.name, 'production');
        expect(inherited.tools.map((t) => t.function.name)).toEqual([tool.name]);
        expect(inherited.toolResolutions).toEqual([
          { name: tool.name, alias: 'production', versionNumber: 1, source: 'default' },
        ]);

        // `staging` takes a binding of its own, onto the tool's own staging build.
        const own = await hub.prompts.setAliasToolBinding(prompt.id, 'staging', tool.id, { toolAlias: 'staging' });
        expect(own).toMatchObject({ toolAlias: 'staging', resolvedVersionNumber: 2 });

        bindings = await hub.prompts.listToolBindings(prompt.id);
        expect(bindings.aliases.find((a) => a.alias === 'staging')?.customised).toBe(true);
        expect(bindings.aliases.find((a) => a.alias === 'production')?.customised).toBe(false);

        const diverged = await hub.prompts.render(prompt.name, 'staging');
        expect(diverged.toolResolutions).toEqual([
          { name: tool.name, alias: 'staging', versionNumber: 2, source: 'alias' },
        ]);

        // `off` contradicts the default: staging must not call the tool at all.
        const off = await hub.prompts.setAliasToolBinding(prompt.id, 'staging', tool.id, { off: true });
        expect(off).toMatchObject({ off: true, toolAlias: null, resolvedVersionNumber: null });
        expect((await hub.prompts.render(prompt.name, 'staging', { _bust: 'off' })).tools).toEqual([]);
        // The default is untouched, so production still calls it.
        expect((await hub.prompts.render(prompt.name, 'production', { _bust: 'off' })).tools).toHaveLength(1);

        // Resetting the alias returns it to the default, tool and all.
        await hub.prompts.resetAliasToolBindings(prompt.id, 'staging');
        bindings = await hub.prompts.listToolBindings(prompt.id);
        expect(bindings.aliases.every((a) => a.customised === false)).toBe(true);
        expect((await hub.prompts.render(prompt.name, 'staging', { _bust: 'reset' })).toolResolutions).toEqual([
          { name: tool.name, alias: 'production', versionNumber: 1, source: 'default' },
        ]);

        // Removing the default unbinds the tool everywhere that inherited it.
        await hub.prompts.removeToolBinding(prompt.id, tool.id);
        bindings = await hub.prompts.listToolBindings(prompt.id);
        expect(bindings.default).toEqual([]);
        expect((await hub.prompts.render(prompt.name, 'production', { _bust: 'removed' })).tools).toEqual([]);
      } finally {
        await close();
      }
    });

    it('returns one alias to the default with removeAliasToolBinding, and 404s an unbound pair', async () => {
      const { apiKey } = await setupUserAndKey();
      const { hub, close } = await startLiveClient(apiKey);

      try {
        const prompt = await hub.prompts.create({ name: `binding-404-test-${Date.now()}` });
        await hub.prompts.commitVersion(prompt.id, { messages: [{ role: 'user', content: 'Hi' }] });
        const tool = await hub.tools.create({ name: `binding_404_tool_${Date.now()}` });
        await hub.tools.commitVersion(tool.id, {
          parametersSchema: { type: 'object', properties: {} },
          executor: { type: 'client' },
        });

        // Nothing is bound yet, so both deletes have no row to remove.
        await expect(hub.prompts.removeToolBinding(prompt.id, tool.id)).rejects.toMatchObject({ statusCode: 404 });
        await expect(
          hub.prompts.removeAliasToolBinding(prompt.id, 'staging', tool.id),
        ).rejects.toMatchObject({ statusCode: 404 });

        await hub.prompts.setToolBinding(prompt.id, tool.id, { toolAlias: 'production' });
        await hub.prompts.setAliasToolBinding(prompt.id, 'staging', tool.id, { pinnedVersionNumber: 1 });
        await hub.prompts.removeAliasToolBinding(prompt.id, 'staging', tool.id);

        const bindings = await hub.prompts.listToolBindings(prompt.id);
        expect(bindings.default).toHaveLength(1);
        expect(bindings.aliases.find((a) => a.alias === 'staging')?.customised).toBe(false);
      } finally {
        await close();
      }
    });
  });

  describe('prompts.tracesForVersion', () => {
    it('returns traces stamped with that prompt version', async () => {
      const { apiKey } = await setupUserAndKey();
      const { hub, close } = await startLiveClient(apiKey);

      try {
        // 1. Create prompt
        const created = await hub.prompts.create({
          name: `trace-link-test-${Date.now()}`,
        });

        // 2. Commit version 1
        const v1 = await hub.prompts.commitVersion(created.id, {
          messages: [{ role: 'system', content: 'Hello' }],
        });
        expect(v1.versionNumber).toBe(1);

        // 3. Ingest a trace with a span stamped with the prompt version
        const { traceId } = await hub.traces.ingest({
          name: 'test-trace',
          spans: [
            {
              spanId: 's1',
              name: 'llm',
              kind: 'llm',
              startTime: new Date().toISOString(),
              endTime: new Date().toISOString(),
              promptVersionId: v1.id,
            },
          ],
        });
        expect(traceId).toBeDefined();

        // 4. Flush gateway so the trace is persisted before we query
        await hub.gateway.flush();

        // 5. Query traces for that prompt version — should contain our trace
        const result = await hub.prompts.tracesForVersion(created.id, 1);
        expect(result.data.length).toBeGreaterThanOrEqual(1);
        expect(result.data.some((t) => t.id === traceId)).toBe(true);
      } finally {
        await close();
      }
    });
  });
});
