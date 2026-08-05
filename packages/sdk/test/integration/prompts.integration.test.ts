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
  await prisma.$executeRaw`TRUNCATE TABLE prompt_version_tools, tool_aliases, tool_versions, tools, prompt_aliases, prompt_versions, audit_log, prompts, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
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
});
