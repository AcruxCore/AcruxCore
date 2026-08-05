/**
 * Manage a tool's shell and versions directly via the SDK -- Node.
 *
 * Walks the full tool-catalog lifecycle end to end:
 *
 *   1. Create a tool shell (no schema/executor yet).
 *   2. Commit v1 with a `client` executor -- the tool's first version, so both
 *      the `production` and `staging` aliases are minted automatically.
 *   3. Commit v2 with an `http` executor pointing at a public, no-auth endpoint
 *      -- later versions mint no new aliases.
 *   4. Commit v3 with only a `changelog` (no `description`) -- the API warns
 *      that the description was likely left out by mistake.
 *   5. List the tool's versions -- list items omit `parametersSchema`/`executor`.
 *   6. Fetch v2 directly to see its full `executor`.
 *   7. Promote `production` to v2.
 *   8. Read call analytics (likely empty -- nothing executed here).
 *   9. Delete the tool -- cleanup, no litter left in the catalog.
 *
 * Requires:
 *   npm install @acruxcoreai/sdk
 *
 * Env:
 *   ACRUXCORE_API_KEY   -- required
 *   ACRUXCORE_BASE_URL  -- required, no default (e.g. http://localhost:3001/api/v1)
 */
import AcruxCore from '@acruxcoreai/sdk';

function section(number, title) {
  console.log(`\n${'='.repeat(64)}\n${number}. ${title}\n${'='.repeat(64)}`);
}

async function main() {
  const hub = new AcruxCore();
  const toolName = `get_stock_price_${Date.now()}`;

  // 1. Create a tool shell ---------------------------------------------------
  section(1, 'Create a tool shell');
  const tool = await hub.tools.create({
    name: toolName,
    description: 'Looks up the latest quoted price for a stock ticker.',
  });
  console.log('tool id      :', tool.id);
  console.log('tool name    :', tool.name);

  // Steps 2-8 run inside a try/finally so a failure partway through (a
  // transient network blip, a bad executor shape, ...) still deletes the
  // shell created in step 1 -- no orphaned tool left behind either way.
  try {
    // 2. Commit v1 -- client executor -----------------------------------------
    section(2, 'Commit v1 (client executor)');
    const v1 = await hub.tools.commitVersion(tool.id, {
      description: 'v1: caller\'s own app resolves the price.',
      parametersSchema: {
        type: 'object',
        properties: { ticker: { type: 'string', description: 'Stock ticker, e.g. AAPL.' } },
        required: ['ticker'],
      },
      executor: { type: 'client' },
    });
    console.log('version      :', v1.versionNumber);
    console.log('has aliases? :', v1.aliases !== undefined);
    if (v1.aliases) {
      console.log('aliases      :', v1.aliases.map((a) => `${a.alias} -> v${a.versionNumber}`));
    }

    // 3. Commit v2 -- http executor -------------------------------------------
    section(3, 'Commit v2 (http executor)');
    const v2 = await hub.tools.commitVersion(tool.id, {
      description: 'v2: resolves the price via a public HTTP endpoint.',
      parametersSchema: {
        type: 'object',
        properties: { ticker: { type: 'string', description: 'Stock ticker, e.g. AAPL.' } },
        required: ['ticker'],
      },
      executor: {
        type: 'http',
        url: 'https://httpbin.org/get',
        method: 'GET',
        headers: [],
        query: [{ name: 'ticker', value: '{{ticker}}' }],
        argMapping: [{ arg: 'ticker', in: 'query' }],
      },
    });
    console.log('version      :', v2.versionNumber);
    console.log('has aliases? :', v2.aliases !== undefined);

    // 4. Commit v3 -- changelog only, no description --------------------------
    section(4, 'Commit v3 (changelog only, no description)');
    const v3 = await hub.tools.commitVersion(tool.id, {
      changelog: 'Swapped the price feed to a different upstream (no schema change).',
      parametersSchema: {
        type: 'object',
        properties: { ticker: { type: 'string', description: 'Stock ticker, e.g. AAPL.' } },
        required: ['ticker'],
      },
      executor: {
        type: 'http',
        url: 'https://httpbin.org/get',
        method: 'GET',
        headers: [],
        query: [{ name: 'ticker', value: '{{ticker}}' }],
        argMapping: [{ arg: 'ticker', in: 'query' }],
      },
    });
    console.log('version      :', v3.versionNumber);
    console.log('warnings     :', v3.warnings);

    // 5. List versions ----------------------------------------------------------
    section(5, 'List versions');
    const versions = await hub.tools.listVersions(tool.id);
    console.log('total        :', versions.total);
    console.log(
      'items have no parametersSchema/executor?',
      versions.data.every((v) => !('parametersSchema' in v) && !('executor' in v)),
    );

    // 6. Get version 2 specifically ----------------------------------------------
    section(6, 'Get version 2');
    const fetchedV2 = await hub.tools.getVersion(tool.id, 2);
    console.log('v2 executor  :', JSON.stringify(fetchedV2.executor, null, 2));

    // 7. Promote production to v2 -------------------------------------------------
    section(7, 'Promote production to v2');
    const promoted = await hub.tools.promoteAlias(tool.id, 'production', 2);
    console.log('alias        :', promoted.alias);
    console.log('now points at:', `v${promoted.versionNumber}`);

    // 8. Read analytics ------------------------------------------------------------
    section(8, 'Read analytics');
    const analytics = await hub.tools.analytics();
    console.log('analytics    :', JSON.stringify(analytics));
  } finally {
    // 9. Delete the tool -- cleanup, runs even if a step above threw -----------
    section(9, 'Delete the tool (cleanup)');
    await hub.tools.delete(tool.id);
    console.log('deleted tool :', tool.id);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
