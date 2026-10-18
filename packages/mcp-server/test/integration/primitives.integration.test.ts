import prisma from '../../../../apps/api/src/shared/db/client';
import { resetAuthTables } from '../../../../apps/api/src/test-utils/reset-db';
import { callTool, startHarness, type Harness } from './harness';

let harness: Harness;

beforeEach(async () => {
  await resetAuthTables();
  harness = await startHarness();
});

afterEach(async () => {
  await harness?.close();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Creates a prompt with one committed version, which mints both aliases at v1. */
async function seedPrompt(name: string, content: string): Promise<void> {
  await callTool(harness.client, 'create_prompt', { name, description: `The ${name} prompt` });
  await callTool(harness.client, 'commit_prompt_version', {
    prompt: name,
    messages: [{ role: 'system', content }],
  });
}

describe('registry prompts exposed through the MCP prompts primitive', () => {
  it('lists each prompt at the configured alias with its template variables as arguments', async () => {
    await seedPrompt('greeting', 'Hello {{ name }}, welcome to {{ company }}.');

    const { prompts } = await harness.client.listPrompts();
    const greeting = prompts.find((p) => p.name === 'greeting');

    expect(greeting).toBeDefined();
    expect(greeting?.description).toContain('alias "production"');
    expect(greeting?.description).toContain('version 1');
    expect(greeting?.arguments?.map((a) => a.name).sort()).toEqual(['company', 'name']);
    expect(greeting?.arguments?.every((a) => a.required)).toBe(true);
  });

  it('renders a prompt through the alias when the client fetches it', async () => {
    await seedPrompt('greeting', 'Hello {{ name }}, welcome to {{ company }}.');

    const result = await harness.client.getPrompt({
      name: 'greeting',
      arguments: { name: 'Alice', company: 'Acme Corp' },
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toEqual({
      type: 'text',
      text: 'Hello Alice, welcome to Acme Corp.',
    });
    expect(result.description).toContain('version 1');
  });

  it('follows the alias, so promoting changes what the prompt returns', async () => {
    await seedPrompt('greeting', 'Version one for {{ name }}.');
    await callTool(harness.client, 'commit_prompt_version', {
      prompt: 'greeting',
      messages: [{ role: 'system', content: 'Version two for {{ name }}.' }],
    });

    const before = await harness.client.getPrompt({ name: 'greeting', arguments: { name: 'Bo' } });
    expect((before.messages[0].content as { text: string }).text).toContain('Version one');

    await callTool(harness.client, 'promote_prompt_alias', {
      prompt: 'greeting',
      alias: 'production',
      version_number: 2,
    });

    const after = await harness.client.getPrompt({ name: 'greeting', arguments: { name: 'Bo' } });
    expect((after.messages[0].content as { text: string }).text).toContain('Version two');
  });

  it('carries a system message through as the leading user message', async () => {
    // MCP's PromptMessage role is user|assistant — there is no system role in the
    // protocol, so the instruction has to survive as a user turn or be lost.
    await seedPrompt('terse', 'You are terse. Answer {{ question }} in one line.');

    const result = await harness.client.getPrompt({
      name: 'terse',
      arguments: { question: 'why' },
    });

    expect(result.messages[0].role).toBe('user');
    expect((result.messages[0].content as { text: string }).text).toBe(
      'You are terse. Answer why in one line.',
    );
  });

  it('skips a prompt that has no version at the configured alias instead of failing the listing', async () => {
    await seedPrompt('complete', 'Ready {{ x }}.');
    // A prompt with no committed version has no aliases at all — a normal state in a
    // registry, and one bad row must not empty the whole list.
    await callTool(harness.client, 'create_prompt', { name: 'half-built' });

    const { prompts } = await harness.client.listPrompts();
    const names = prompts.map((p) => p.name);

    expect(names).toContain('complete');
    expect(names).not.toContain('half-built');
  });

  it('exposes a different alias when configured to', async () => {
    await harness.close();
    harness = await startHarness({ promptAlias: 'staging' });

    await seedPrompt('greeting', 'v1 for {{ name }}.');
    await callTool(harness.client, 'commit_prompt_version', {
      prompt: 'greeting',
      messages: [{ role: 'system', content: 'v2 for {{ name }}.' }],
    });
    await callTool(harness.client, 'promote_prompt_alias', {
      prompt: 'greeting',
      alias: 'production',
      version_number: 2,
    });

    const result = await harness.client.getPrompt({ name: 'greeting', arguments: { name: 'Bo' } });
    // staging was never promoted, so it still serves v1 while production is on v2.
    expect((result.messages[0].content as { text: string }).text).toContain('v1');
  });
});

describe('acruxcore:// resources', () => {
  it('lists one resource per prompt and reads back the raw, unrendered template', async () => {
    await seedPrompt('greeting', 'Hello {{ name }}.');

    const { resources } = await harness.client.listResources();
    const entry = resources.find((r) => r.name === 'greeting');
    expect(entry?.uri).toBe('acruxcore://prompts/greeting/production');

    const read = await harness.client.readResource({
      uri: 'acruxcore://prompts/greeting/production',
    });
    const version = JSON.parse(read.contents[0].text as string) as {
      versionNumber: number;
      messages: Array<{ content: string }>;
      variables: string[];
    };

    expect(version.versionNumber).toBe(1);
    // Raw, not rendered: the placeholder is still there.
    expect(version.messages[0].content).toBe('Hello {{ name }}.');
    expect(version.variables).toEqual(['name']);
  });

  it('offers a trace resource template but does not enumerate traces', async () => {
    const { resourceTemplates } = await harness.client.listResourceTemplates();
    const uris = resourceTemplates.map((t) => t.uriTemplate);

    expect(uris).toContain('acruxcore://traces/{traceId}');
    expect(uris).toContain('acruxcore://prompts/{name}/{alias}');
  });

  it('says which alias is missing rather than returning empty content', async () => {
    await seedPrompt('greeting', 'Hello {{ name }}.');

    await expect(
      harness.client.readResource({ uri: 'acruxcore://prompts/greeting/canary' }),
    ).rejects.toThrow(/canary/);
  });
});
