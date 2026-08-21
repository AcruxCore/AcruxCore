/**
 * Stream a prompt's tools -- TypeScript/Node, standalone.
 *
 * The whole point of the streaming tool loop in one file: text arrives token by token,
 * and a running tool is its own event rather than more model text. The timings printed
 * at the end show what that bought you -- the answer starts appearing a few hundred
 * milliseconds after the tool returns, instead of when the loop ends.
 *
 * Expects a prompt whose alias has a tool bound to it. The defaults match the
 * `weather-brief` / `get_weather` pair from the "Connect a tool to a prompt" guide:
 *
 *   - `production` binds `get_weather` at its `production` alias, whose version has an
 *     `http` executor -- the platform runs it, so CLIENT_TOOLS below is never used.
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
 *   node stream_prompt_tools.mjs
 *   PROMPT_ALIAS=staging CITY=Karachi node stream_prompt_tools.mjs
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
 * `tools` is SYNCED to the catalog on first use, which commits a new version of a tool of
 * that name and moves its alias — so this script would quietly rewrite the tool it is
 * calling. `clientTools` writes nothing, keeps the binding's alias or pin, and is never
 * reached for an `http` executor, which the platform runs.
 */
const CLIENT_TOOLS = { get_weather: ({ city }) => getWeather(city) };

async function main() {
  const hub = new acruxcore();

  // One render. It carries the templated messages, the version's bound model, the tools
  // bound to this prompt alias, and the version id for trace lineage — which is why the
  // call below needs no arguments of its own.
  const rendered = await hub.prompts.render(PROMPT_NAME, PROMPT_ALIAS, { city: CITY });

  const tools = rendered.toolResolutions
    .map((t) => (t.alias ? `${t.name}@${t.alias}` : `${t.name} v${t.pinnedVersionNumber}`))
    .join(', ');
  console.log(`prompt   ${PROMPT_NAME}@${PROMPT_ALIAS}  (version ${rendered.versionNumber})`);
  console.log(`model    ${rendered.model}`);
  console.log(`tools    ${tools || 'none bound'}`);
  console.log('─'.repeat(72));

  const started = performance.now();
  let firstEventAt;
  let firstTextAt;
  let lastToolAt;

  let stream;
  try {
    // If every bound tool has an `http` executor — the default `production` alias here
    // — the platform runs them and this is the whole call:
    //
    //     stream = await hub.gateway.runPromptWithTools(rendered, { stream: true });
    //
    // `clientTools` is passed only so `PROMPT_ALIAS=staging` works too: that alias binds a
    // `client`-executor version, whose code lives in THIS file.
    stream = await hub.gateway.runPromptWithTools(rendered, { stream: true, clientTools: CLIENT_TOOLS });
  } catch (err) {
    // The most likely one here: the prompt version has no bound model, and the message
    // names both fixes.
    console.error(`\n${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  for await (const event of stream) {
    firstEventAt ??= performance.now();

    if (event.type === 'content') {
      firstTextAt ??= performance.now();
      // No newline, no buffering — this is what "streaming" has to look like.
      process.stdout.write(event.delta);
    } else if (event.type === 'tool_call') {
      console.log(`\n  ⚙  calling ${event.name}(${JSON.stringify(event.arguments)}) …`);
    } else if (event.type === 'tool_result') {
      lastToolAt = performance.now();
      if (event.error) console.log(`  ✗  ${event.name} failed: ${event.error}`);
      else console.log(`  ✓  ${event.name} → ${JSON.stringify(event.result)}\n`);
    } else if (event.type === 'done') {
      console.log('\n' + '─'.repeat(72));
      console.log(`rounds   ${event.result.iterations}`);
      if (event.result.stoppedAtLimit) {
        console.log('         (stopped at maxIterations — the model was still calling tools)');
      }
      console.log(`trace    ${event.result.traceId}`);
    }
  }

  // What these numbers do and do not show. A tool round runs before the answer exists at
  // all, so "first token" being late is the loop, not the streaming — the number that
  // shows what streaming bought you is the one after the last tool. Unstreamed, you would
  // have waited for the whole loop before seeing anything.
  const end = performance.now();
  const ms = (v) => String(Math.round(v)).padStart(7);
  if (firstEventAt !== undefined) console.log(`first event                 ${ms(firstEventAt - started)} ms  (a tool call, or text)`);
  if (firstTextAt !== undefined) console.log(`first token of the answer   ${ms(firstTextAt - started)} ms`);
  if (firstTextAt !== undefined && lastToolAt !== undefined) {
    console.log(`  … after the last tool      ${ms(firstTextAt - lastToolAt)} ms`);
  }
  console.log(`whole loop                  ${ms(end - started)} ms`);

  // The loop reports its trace in the background; wait for that write so the trace is
  // readable the moment this script exits.
  await hub.gateway.close();
  console.log('\nOpen the trace to see one llm span per round with the tool span nested');
  console.log('under it — a streamed loop records exactly what a blocking one does.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
