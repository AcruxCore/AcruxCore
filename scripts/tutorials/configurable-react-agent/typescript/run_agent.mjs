/**
 * Configurable web-research agent — Node, the SDK's runToolLoop(), over the
 * gateway. Same shape as run_agent.py: the whole configuration swap is
 * which alias you render. "quick" binds a cheap, fast model and a shallow Tavily
 * search; "deep" binds a bigger model and an advanced, wider search. No code below
 * changes between the two runs — only the alias string passed on the command line.
 *
 * Flow:
 *   1. renderPrompt   — hub.renderPrompt('web-research-agent', alias, {...}) ->
 *                       messages, tools, model, versionId, all four bound to
 *                       whichever alias you pass.
 *   2. runToolLoop    — drives the gateway completion loop, threading one trace.
 *                       web_research is a CLIENT tool (the catalog stores only its
 *                       schema), so it's passed as toolDefs + dispatch.
 *   3. dispatch       — calls @langchain/tavily's TavilySearch class directly —
 *                       the Node/TS successor to the same langchain-tavily wrapper
 *                       family the Python tab's TavilySearchResults belongs to —
 *                       with maxResults/searchDepth/includeImages chosen by alias.
 *
 * Run:
 *   export ACRUXCORE_API_KEY=<your personal api key>
 *   export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
 *   export TAVILY_API_KEY=tvly-...
 *   node run_agent.mjs quick "What are people saying about the new Anthropic Claude models?"
 *   node run_agent.mjs deep  "What are people saying about the new Anthropic Claude models?"
 */

import AcruxCore from '@acruxcoreai/sdk';
import { TavilySearch } from '@langchain/tavily';

const PROMPT = 'web-research-agent';

/**
 * Real call to @langchain/tavily's TavilySearch — not a hand-rolled REST
 * substitute. Depth is picked by `alias`, not by the model: the model only ever
 * supplies `query`.
 */
async function webResearch(query, alias) {
  const wrapped =
    alias === 'quick'
      ? // basic_research: 5 results, basic depth, images, "trending" framing
        new TavilySearch({ maxResults: 5, searchDepth: 'basic', includeImages: true })
      : // advanced_research: 10 results, advanced depth
        new TavilySearch({ maxResults: 10, searchDepth: 'advanced' });
  const searchQuery = alias === 'quick' ? `trending ${query}` : query;
  const result = await wrapped.invoke({ query: searchQuery });
  return (result.results || []).map((r) => ({ title: r.title, url: r.url }));
}

async function dispatch(name, args, alias) {
  if (name === 'web_research') {
    const results = await webResearch(args.query, alias);
    console.log(`  -> web_research(${JSON.stringify(args)}) -> ${results.length} result(s)`);
    return results;
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function ask(hub, alias, question) {
  const rendered = await hub.renderPrompt(PROMPT, alias, { question });
  console.log(`Alias: ${alias} -> model ${rendered.model}`);
  console.log(`Question: ${question}\n`);

  const result = await hub.runToolLoop({
    model: rendered.model, // bound to the prompt version in the dashboard, per alias
    messages: [...rendered.messages],
    toolDefs: rendered.tools,
    dispatch: (name, args) => dispatch(name, args, alias),
    promptVersionId: rendered.versionId,
    trace: { name: 'web-research-agent', sessionId: `web-research-${alias}` },
  });
  console.log(`Assistant: ${result.content}`);
  console.log(`\n(${result.iterations} model turn(s), trace ${result.traceId})`);
}

async function main() {
  const alias = process.argv[2] || 'quick';
  const question =
    process.argv[3] || 'What are people saying about the new Anthropic Claude models?';
  const hub = new AcruxCore(); // reads ACRUXCORE_API_KEY / ACRUXCORE_BASE_URL
  await ask(hub, alias, question);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
