/**
 * Call a prompt's tools from the SDK -- TypeScript/Node.
 *
 * Runs the same prompt four ways, so the four calling shapes can be compared side
 * by side against one real prompt:
 *
 *   1. runPromptWithTools(r)                    -- the preferred way, two lines.
 *   2. runPromptWithTools(r, { stream: true })  -- the same, as typed events.
 *   3. runToolLoop(...) by hand                 -- when the loop needs changing.
 *   4. chat({ toolRefs })                       -- one request, nothing dispatched.
 *
 * Expects a prompt whose alias has a tool bound to it. The defaults match the
 * `weather-brief` / `get_weather` pair from the "Connect a tool to a prompt" guide:
 *
 *   - `production` binds `get_weather` at its `production` alias, whose version has
 *     an `http` executor -- the platform runs it, so no tool code is needed here.
 *   - `staging` binds the same tool at its `staging` alias, whose version has a
 *     `client` executor -- the function in THIS file runs it.
 *
 * Requires:
 *   npm install @acruxcoreai/sdk
 *
 * Env:
 *   ACRUXCORE_API_KEY   -- required
 *   ACRUXCORE_BASE_URL  -- required, no default (e.g. http://localhost:3001/api/v1)
 *   PROMPT_NAME         -- default "weather-brief"
 *   PROMPT_ALIAS        -- default "production"
 *   CITY                -- default "Lisbon"
 *
 * Run:
 *   node run_prompt_tools.mjs
 *   PROMPT_ALIAS=staging node run_prompt_tools.mjs
 */
import { acruxcore } from '@acruxcoreai/sdk';

const PROMPT_NAME = process.env.PROMPT_NAME ?? 'weather-brief';
const PROMPT_ALIAS = process.env.PROMPT_ALIAS ?? 'production';
const CITY = process.env.CITY ?? 'Lisbon';

/** A stand-in for a real weather call, so the script needs no third-party key. */
function getWeather(city) {
  return { location: city, tempC: 21, condition: 'Sunny' };
}

/**
 * The tools this script runs itself, keyed by catalog tool name.
 *
 * `clientTools` rather than `tools: [declared]` on purpose. A declared tool passed in
 * `tools` is SYNCED to the catalog on first use, which commits a new version of a tool
 * of that name and moves its alias — so a script meant to demonstrate the calling
 * shapes would quietly rewrite the tool it is calling. `clientTools` writes nothing,
 * keeps the binding's alias or pin, and is never reached for an `http` executor, which
 * the platform runs.
 */
const CLIENT_TOOLS = { get_weather: ({ city }) => getWeather(city) };

function section(number, title) {
  console.log(`\n${'='.repeat(64)}\n${number}. ${title}\n${'='.repeat(64)}`);
}

async function main() {
  const hub = new acruxcore();

  // One render, reused by all four shapes below. `r` holds the templated messages, the
  // bound model, the resolved tool definitions, and which binding decided each one.
  const r = await hub.prompts.render(PROMPT_NAME, PROMPT_ALIAS, { city: CITY });

  section('0', 'What the render resolved');
  console.log('model         :', r.model);
  console.log('version       :', r.versionNumber, r.versionId);
  console.log('messages      :', r.messages);
  for (const res of r.toolResolutions) {
    const which = res.pinnedVersionNumber ? `pinned v${res.pinnedVersionNumber}` : `alias '${res.alias}'`;
    console.log(`tool          : ${res.name} -> ${which}, ran v${res.versionNumber} (decided by ${res.source})`);
  }

  // 1. The preferred way ------------------------------------------------------
  // Model, messages, tools and trace lineage all come from the render.
  section('1', 'runPromptWithTools(r)');
  const result = await hub.gateway.runPromptWithTools(r, { clientTools: CLIENT_TOOLS });
  console.log('answer        :', result.content);
  console.log('iterations    :', result.iterations);
  console.log('trace         :', result.traceId);

  // 2. The same call, streamed -----------------------------------------------
  // A discriminated event stream, so "a tool is running" is its own state rather
  // than more model text.
  section('2', 'runPromptWithTools(r, { stream: true })');
  for await (const event of await hub.gateway.runPromptWithTools(r, { stream: true, clientTools: CLIENT_TOOLS })) {
    if (event.type === 'content') process.stdout.write(event.delta);
    else if (event.type === 'tool_call') console.log(`\n[calling ${event.name}(${JSON.stringify(event.arguments)})]`);
    else if (event.type === 'tool_result') console.log(`[${event.name} -> ${JSON.stringify(event.result)}]`);
    else if (event.type === 'done') console.log(`\ntrace         : ${event.result.traceId}`);
  }

  // 3. By hand, when the loop needs changing ---------------------------------
  // Everything runPromptWithTools fills in, spelled out. Reach for this to pass a
  // subset of the bound tools, an extra tool that is not bound, a different
  // maxIterations, or a responseFormat.
  section('3', 'runToolLoop(...) by hand');
  const byHand = await hub.gateway.runToolLoop({
    model: r.model,
    messages: r.messages,
    clientTools: CLIENT_TOOLS,
    toolRefs: r.toolResolutions.map((t) => ({ name: t.name, alias: t.alias })),
    promptVersionId: r.versionId,
    maxIterations: 3,
  });
  console.log('answer        :', byHand.content);

  // 4. One request, one completion -------------------------------------------
  // `tool_calls` come back raw and nothing is dispatched -- for when you own the
  // loop, or want to inspect the call before running anything.
  section('4', 'chat({ toolRefs }) -- nothing dispatched');
  const once = await hub.gateway.chat({
    model: r.model,
    messages: r.messages,
    toolRefs: r.toolResolutions.map((t) => ({ name: t.name, alias: t.alias })),
    promptVersionId: r.versionId,
  });
  console.log('finishReason  :', once.finishReason);
  console.log('tool_calls    :', once.message.tool_calls);

  await hub.gateway.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
