/**
 * Supervisor multi-agent flow -- Node, over the gateway.
 *
 * Step A: render the router prompt, call the gateway directly (fetch) with
 *         response_format set to a typed { "route_to": ... } json_schema.
 * Step B: render the matching subagent's prompt + tools and run runToolLoop(),
 *         passing trace: { traceId } so both calls land in ONE trace.
 *
 * Requires:
 *   npm install @acruxcoreai/sdk @langchain/tavily
 */
import AcruxCore from '@acruxcoreai/sdk';
import { TavilySearch } from '@langchain/tavily';

const ACRUXCORE_API_KEY = process.env.ACRUXCORE_API_KEY;
const ACRUXCORE_BASE_URL = process.env.ACRUXCORE_BASE_URL.replace(/\/+$/, '');
const ACRUXCORE_HEADERS = { Authorization: `Bearer ${ACRUXCORE_API_KEY}`, 'Content-Type': 'application/json' };

const ROUTER_PROMPT = 'content-supervisor';
const SUBAGENT_PROMPTS = {
  finance_research_agent: 'finance-research-agent',
  general_research_agent: 'general-research-agent',
  writing_agent: 'writing-agent',
};
const ROUTE_SCHEMA = {
  type: 'object',
  properties: { route_to: { type: 'string', enum: Object.keys(SUBAGENT_PROMPTS) } },
  required: ['route_to'],
  additionalProperties: false,
};
const TOOL_REFS_BY_ROUTE = {
  finance_research_agent: [{ name: 'finance_research' }, { name: 'basic_research' }, { name: 'get_todays_date' }],
  general_research_agent: [{ name: 'advanced_research' }, { name: 'get_todays_date' }],
  writing_agent: [{ name: 'basic_research' }, { name: 'get_todays_date' }],
};

async function financeResearch(tickerSymbol) {
  const res = await fetch(`https://www.nasdaq.com/feed/rssoutbound?symbol=${tickerSymbol}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const xml = await res.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 3);
  if (items.length === 0) return `No news found for company that searched with ${tickerSymbol} ticker.`;
  return items.map((m) => (m[1].match(/<title>([\s\S]*?)<\/title>/) || [, ''])[1].trim()).join('\n');
}

async function advancedResearch(query) {
  const wrapped = new TavilySearch({ maxResults: 10, searchDepth: 'advanced' });
  const result = await wrapped.invoke({ query });
  return (result.results || []).map((r) => ({ title: r.title, url: r.url }));
}

async function basicResearch(query) {
  const wrapped = new TavilySearch({ maxResults: 5, searchDepth: 'basic', includeImages: true });
  const result = await wrapped.invoke({ query: `trending ${query}` });
  return (result.results || []).map((r) => ({ title: r.title, url: r.url }));
}

async function getTodaysDate() {
  return new Date().toISOString().slice(0, 10);
}

async function dispatch(name, args) {
  if (name === 'finance_research') return financeResearch(args.ticker_symbol);
  if (name === 'advanced_research') return advancedResearch(args.query);
  if (name === 'basic_research') return basicResearch(args.query);
  if (name === 'get_todays_date') return getTodaysDate();
  throw new Error(`Unknown tool: ${name}`);
}

async function route(hub, question) {
  const rendered = await hub.renderPrompt(ROUTER_PROMPT, 'production', { question });
  const res = await fetch(`${ACRUXCORE_BASE_URL}/gateway/chat/completions`, {
    method: 'POST',
    headers: ACRUXCORE_HEADERS,
    body: JSON.stringify({
      model: rendered.model,
      messages: rendered.messages,
      response_format: { type: 'json_schema', json_schema: { name: 'route_decision', schema: ROUTE_SCHEMA, strict: true } },
    }),
  });
  if (!res.ok) throw new Error(`gateway ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const routeTo = JSON.parse(body.choices[0].message.content).route_to;
  const traceId = res.headers.get('x-gateway-trace-id');
  return { routeTo, traceId };
}

async function main() {
  const question = process.argv[2] || 'Research Tesla (TSLA) latest stock news and tell me if investors should be worried.';
  const hub = new AcruxCore(); // reads ACRUXCORE_API_KEY / ACRUXCORE_BASE_URL

  const { routeTo, traceId } = await route(hub, question);
  console.log(`Question: ${question}`);
  console.log(`Step A -- routed to: ${routeTo}  (trace ${traceId})\n`);

  const subagentPrompt = SUBAGENT_PROMPTS[routeTo];
  const rendered = await hub.renderPrompt(subagentPrompt, 'production', { task: question });

  const result = await hub.runToolLoop({
    model: rendered.model,
    messages: [...rendered.messages],
    toolRefs: TOOL_REFS_BY_ROUTE[routeTo],
    dispatch,
    sync: false,
    promptVersionId: rendered.versionId,
    trace: { traceId },
  });
  console.log(`Step B -- ${routeTo}: ${result.content}`);
  console.log(`\n(${result.iterations} model turn(s), trace ${result.traceId})`);
}

main().catch((err) => { console.error(err); process.exit(1); });
