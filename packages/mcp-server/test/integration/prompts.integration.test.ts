import prisma from '../../../../apps/api/src/shared/db/client';
import { resetAuthTables } from '../../../../apps/api/src/test-utils/reset-db';
import {
  callTool,
  callToolExpectingError,
  payloadOf,
  startHarness,
  type Harness,
} from './harness';

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

describe('prompt lifecycle over MCP', () => {
  it('runs create → commit → render → commit → promote → diff, and the database agrees', async () => {
    const client = harness.client;

    // ── create ────────────────────────────────────────────────────────────────
    const created = payloadOf<{ id: string; name: string }>(
      await callTool(client, 'create_prompt', {
        name: 'customer-support',
        description: 'Handles customer support queries',
      }),
    );
    expect(created.name).toBe('customer-support');

    const row = await prisma.prompt.findUnique({ where: { id: created.id } });
    expect(row?.teamId).toBe(harness.teamId);

    // ── commit v1: the first commit is what mints the two aliases ─────────────
    const v1Text = await callTool(client, 'commit_prompt_version', {
      prompt: 'customer-support',
      messages: [
        { role: 'system', content: 'You are a support agent for {{ company }}.' },
        { role: 'user', content: 'Customer asks: {{ question }}' },
      ],
    });
    expect(v1Text).toContain('Aliases production and staging were created');
    const v1 = payloadOf<{ versionNumber: number; variables: string[] }>(v1Text);
    expect(v1.versionNumber).toBe(1);
    expect(v1.variables.sort()).toEqual(['company', 'question']);

    // ── render at production ─────────────────────────────────────────────────
    const rendered = payloadOf<{
      messages: Array<{ role: string; content: string }>;
      versionNumber: number;
    }>(
      await callTool(client, 'render_prompt', {
        prompt: 'customer-support',
        variables: { company: 'Acme', question: 'Where is my order?' },
      }),
    );
    expect(rendered.versionNumber).toBe(1);
    expect(rendered.messages[0].content).toBe('You are a support agent for Acme.');
    expect(rendered.messages[1].content).toBe('Customer asks: Where is my order?');

    // ── commit v2: committing must NOT move an alias ──────────────────────────
    const v2Text = await callTool(client, 'commit_prompt_version', {
      prompt: created.id,
      messages: [
        { role: 'system', content: 'You are a concise support agent for {{ company }}.' },
        { role: 'user', content: 'Customer asks: {{ question }}' },
      ],
    });
    expect(v2Text).toContain('No alias moved');

    const stillV1 = payloadOf<{ versionNumber: number }>(
      await callTool(client, 'render_prompt', {
        prompt: 'customer-support',
        variables: { company: 'Acme', question: 'Where is my order?' },
      }),
    );
    expect(stillV1.versionNumber).toBe(1);

    // ── promote: this is what ships the change ────────────────────────────────
    await callTool(client, 'promote_prompt_alias', {
      prompt: 'customer-support',
      alias: 'production',
      version_number: 2,
    });

    const nowV2 = payloadOf<{ messages: Array<{ content: string }>; versionNumber: number }>(
      await callTool(client, 'render_prompt', {
        prompt: 'customer-support',
        variables: { company: 'Acme', question: 'Where is my order?' },
      }),
    );
    expect(nowV2.versionNumber).toBe(2);
    expect(nowV2.messages[0].content).toContain('concise');

    // staging was never promoted, so it still serves v1
    const staging = payloadOf<{ versionNumber: number }>(
      await callTool(client, 'render_prompt', {
        prompt: 'customer-support',
        alias: 'staging',
        variables: { company: 'Acme', question: 'Where is my order?' },
      }),
    );
    expect(staging.versionNumber).toBe(1);

    // ── diff ─────────────────────────────────────────────────────────────────
    const diff = payloadOf<{ diff: string }>(
      await callTool(client, 'diff_prompt_versions', {
        prompt: 'customer-support',
        from_version: 1,
        to_version: 2,
      }),
    );
    expect(diff.diff).toContain('+');
    expect(diff.diff).toContain('concise');

    // ── get_prompt sees the whole picture in one call ─────────────────────────
    const detail = payloadOf<{
      prompt: { name: string };
      versions: unknown[];
      aliases: Array<{ alias: string; versionNumber: number }>;
    }>(await callTool(client, 'get_prompt', { prompt: 'customer-support' }));

    expect(detail.prompt.name).toBe('customer-support');
    expect(detail.versions).toHaveLength(2);
    expect(detail.aliases.find((a) => a.alias === 'production')?.versionNumber).toBe(2);
    expect(detail.aliases.find((a) => a.alias === 'staging')?.versionNumber).toBe(1);

    // ── rollback is just a promote to an earlier number ──────────────────────
    await callTool(client, 'promote_prompt_alias', {
      prompt: 'customer-support',
      alias: 'production',
      version_number: 1,
    });
    const rolledBack = await prisma.promptAlias.findFirst({
      where: { promptId: created.id, alias: 'production' },
      include: { version: true },
    });
    expect(rolledBack?.version.versionNumber).toBe(1);
  });

  it('accepts a name anywhere an id is accepted, and says so when the name is unknown', async () => {
    const client = harness.client;

    const created = payloadOf<{ id: string }>(
      await callTool(client, 'create_prompt', { name: 'greeting' }),
    );
    await callTool(client, 'commit_prompt_version', {
      prompt: 'greeting',
      messages: [{ role: 'user', content: 'Hi {{ name }}' }],
    });

    const byName = payloadOf<{ prompt: { id: string } }>(
      await callTool(client, 'get_prompt', { prompt: 'greeting' }),
    );
    const byId = payloadOf<{ prompt: { id: string } }>(
      await callTool(client, 'get_prompt', { prompt: created.id }),
    );
    expect(byName.prompt.id).toBe(created.id);
    expect(byId.prompt.id).toBe(created.id);

    const error = await callToolExpectingError(client, 'get_prompt', { prompt: 'no-such-prompt' });
    expect(error).toContain('NOT_FOUND');
    expect(error).toContain('no-such-prompt');
  });

  it('does not pick a near-miss when a name only partially matches', async () => {
    const client = harness.client;

    await callTool(client, 'create_prompt', { name: 'weather-brief' });
    await callTool(client, 'create_prompt', { name: 'weather-brief-long' });

    // "weather" substring-matches both; resolution must refuse rather than guess.
    const error = await callToolExpectingError(client, 'get_prompt', { prompt: 'weather' });
    expect(error).toContain('NOT_FOUND');
    expect(error).toContain('weather-brief');
  });

  it('passes the API error code and the missing variable names straight through', async () => {
    const client = harness.client;

    await callTool(client, 'create_prompt', { name: 'greeting' });
    await callTool(client, 'commit_prompt_version', {
      prompt: 'greeting',
      messages: [{ role: 'system', content: 'Hello {{ name }} of {{ company }}.' }],
    });

    const error = await callToolExpectingError(client, 'render_prompt', {
      prompt: 'greeting',
      variables: {},
    });

    // A bare "request failed" would leave the model with nothing to retry differently.
    expect(error).toContain('MISSING_VARIABLES');
    expect(error).toContain('company');
    expect(error).toContain('name');
  });

  it('rejects arguments that do not match the tool schema before any request is made', async () => {
    const result = await harness.client.callTool({
      name: 'promote_prompt_alias',
      arguments: { prompt: 'greeting', alias: 'production', version_number: 'two' },
    });

    expect(result.isError).toBe(true);
  });

  it('lists and searches prompts', async () => {
    const client = harness.client;

    await callTool(client, 'create_prompt', { name: 'alpha-prompt' });
    await callTool(client, 'create_prompt', { name: 'beta-prompt' });

    const all = await callTool(client, 'list_prompts');
    expect(all).toContain('Showing 2 of 2 prompts');

    const filtered = payloadOf<{ data: Array<{ name: string }> }>(
      await callTool(client, 'list_prompts', { search: 'alpha' }),
    );
    expect(filtered.data.map((p) => p.name)).toEqual(['alpha-prompt']);

    const empty = await callTool(client, 'list_prompts', { search: 'nothing-matches-this' });
    expect(empty).toContain('No prompts found.');
  });

  it('says so when two versions have identical messages, instead of an empty diff', async () => {
    const client = harness.client;
    const messages = [{ role: 'user', content: 'Say hello to {{ name }}.' }];

    await callTool(client, 'create_prompt', { name: 'same-text' });
    await callTool(client, 'commit_prompt_version', { prompt: 'same-text', messages });
    await callTool(client, 'commit_prompt_version', { prompt: 'same-text', messages });

    // A model-only change commits a new version with the same text. A bare "Diff of
    // v1 → v2." over an empty body reads as a failed call.
    const text = await callTool(client, 'diff_prompt_versions', {
      prompt: 'same-text',
      from_version: 1,
      to_version: 2,
    });
    expect(text).toContain('identical');
    expect(text).toContain('get_prompt');
  });
});
