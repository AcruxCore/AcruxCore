import prisma from '../../../../apps/api/src/shared/db/client';
import { resetAuthTables } from '../../../../apps/api/src/test-utils/reset-db';
import { ALL_TOOLS } from '../../src/toolsets';
import { startHarness, type Harness } from './harness';

let harness: Harness;

beforeEach(async () => {
  await resetAuthTables();
});

afterEach(async () => {
  await harness?.close();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('AcruxCore MCP server — handshake and tool listing', () => {
  it('advertises tools, prompts and resources, and explains the registry model', async () => {
    harness = await startHarness();

    const capabilities = harness.client.getServerCapabilities();
    expect(capabilities?.tools).toBeDefined();
    expect(capabilities?.prompts).toBeDefined();
    expect(capabilities?.resources).toBeDefined();

    const version = harness.client.getServerVersion();
    expect(version?.name).toBe('acruxcore');

    // The instructions are the only place the prompt/version/alias distinction is
    // explained, and a client that misses it commits versions that never ship.
    const instructions = harness.client.getInstructions() ?? '';
    expect(instructions).toContain('alias');
    expect(instructions).toContain('promote_prompt_alias');
  });

  it('lists every tool with a schema and a read-only annotation', async () => {
    harness = await startHarness();

    const { tools } = await harness.client.listTools();
    expect(tools).toHaveLength(ALL_TOOLS.length);

    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(60);
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.annotations?.readOnlyHint).toBe('boolean');
    }

    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'list_prompts',
        'get_prompt',
        'render_prompt',
        'run_prompt',
        'search_traces',
        'sync_catalog_tool',
        'list_datasets',
      ]),
    );
  });

  it('narrows the surface to the selected toolsets', async () => {
    harness = await startHarness({ toolsets: ['prompts'] });

    const names = (await harness.client.listTools()).tools.map((tool) => tool.name);

    expect(names).toContain('list_prompts');
    expect(names).not.toContain('search_traces');
    expect(names).not.toContain('run_prompt');
  });

  it('removes every mutating tool in read-only mode, rather than refusing it at call time', async () => {
    harness = await startHarness({ readOnly: true });

    const { tools } = await harness.client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(names).toContain('list_prompts');
    expect(names).not.toContain('create_prompt');
    expect(names).not.toContain('promote_prompt_alias');

    // And the tool is genuinely gone, not merely hidden: calling it by name is an
    // unknown-tool error from the protocol layer, which no prompt injection can talk
    // its way past.
    const result = await harness.client.callTool({
      name: 'create_prompt',
      arguments: { name: 'nope' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('not found');
  });

  it('does not tell a read-only client to call tools it was never given', async () => {
    harness = await startHarness({ readOnly: true });

    // The model reads the instructions as a list of things it can do. Naming
    // promote_prompt_alias here, with the tool absent, sends it looking for a tool that
    // does not exist.
    const instructions = harness.client.getInstructions() ?? '';
    expect(instructions).toContain('alias');
    expect(instructions).not.toContain('promote_prompt_alias');
    expect(instructions).toContain('read-only');
  });
});
