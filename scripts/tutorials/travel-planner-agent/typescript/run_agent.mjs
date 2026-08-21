/**
 * Travel-planner agent: one platform-stored system prompt, three bound tools.
 *
 * The system prompt and all three tool definitions live in Acrux Core. This script
 * supplies only the traveller's question and the code for the one tool whose
 * executor is `client`. The model decides which tools to call — often one, sometimes
 * two, and for a general question, none at all.
 *
 * Run it:
 *
 *   npm install @acruxcoreai/sdk
 *   export ACRUXCORE_API_KEY=acx_sk_...
 *   export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1   # or your own host
 *   node run_agent.mjs "Any flights from Amsterdam to Lisbon on 2026-08-28?"
 *
 * With no argument it runs all four demo questions.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import AcruxCore from '@acruxcoreai/sdk';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, '..', 'data', 'flights.json');

const DEMO_QUESTIONS = [
  // Needs no tool at all — general knowledge, so the loop ends on round 1.
  "What's the best time of year to visit Japan, and do I need a visa as a Dutch citizen?",
  // Needs exactly one tool: search_flights.
  'Any flights from Amsterdam to Lisbon on 2026-08-28?',
  // Needs exactly one tool: get_city_weather.
  'Should I pack a raincoat for Lisbon? I land tomorrow.',
  // Needs two tools in one turn: get_city_weather and convert_currency.
  "I'm in Lisbon for the next three days with a budget of 500 EUR. " +
    "What's the weather, and what is that worth in Japanese yen?",
];

/**
 * Looks up the in-house flight inventory. This is the `client` executor.
 *
 * Acrux Core stores this tool's name, description and JSON Schema so the model knows
 * how to call it, but never the code or the data — both stay here.
 */
function searchFlights(args) {
  const { routes } = JSON.parse(readFileSync(DATA, 'utf8'));
  const origin = String(args.origin ?? '').trim().toLowerCase();
  const destination = String(args.destination ?? '').trim().toLowerCase();
  const flights = routes[`${origin}|${destination}`] ?? [];
  return {
    origin: args.origin,
    destination: args.destination,
    departure_date: args.departure_date,
    flights,
    count: flights.length,
  };
}

async function ask(hub, question) {
  // 1. The system prompt lives on the platform. Render it — this also returns the
  //    version's bound model and the tools bound to this prompt alias.
  const rendered = await hub.prompts.render('travel-planner', 'production', {
    today: new Date().toISOString().slice(0, 10),
  });

  // 2. The traveller's question is appended here, client-side. A tool loop has to own
  //    its message list, so the user turn is added rather than sent as a `prompt`
  //    reference.
  const messages = [...rendered.messages, { role: 'user', content: question }];

  // 3. Run the loop. Tools bound to the prompt, the bound model and the prompt
  //    version id all come from `rendered`, so nothing is restated here.
  //    `clientTools` names the one tool this app has to run itself — keyed by the
  //    catalog tool name. The two http tools are absent because the platform runs
  //    those, so there is nothing to supply for them.
  const result = await hub.gateway.runPromptWithTools(rendered, {
    messages,
    clientTools: { search_flights: searchFlights },
  });

  const called = result.messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.tool_calls ?? [])
    .map((c) => c.function.name);

  console.log(`\n\x1b[1mQ:\x1b[0m ${question}`);
  console.log(
    `\x1b[2mrounds: ${result.iterations}  tools called: ${called.length ? called.join(', ') : 'none'}\x1b[0m`,
  );
  console.log(`\x1b[1mA:\x1b[0m ${result.content}`);
  if (result.traceId) console.log(`\x1b[2mtrace: ${result.traceId}\x1b[0m`);
}

async function main() {
  const questions = process.argv.slice(2).length ? process.argv.slice(2) : DEMO_QUESTIONS;
  const hub = new AcruxCore();
  try {
    for (const question of questions) await ask(hub, question);
  } finally {
    await hub.gateway.close();
  }
}

await main();
