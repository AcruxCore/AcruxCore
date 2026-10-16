/**
 * Run your own app as an AcruxCore experiment -- TypeScript/Node.
 *
 * The app is a two-step support-ticket triage:
 *   1. a model call classifies the ticket (billing, bug, question or account);
 *   2. plain code routes the category to a team.
 *
 * `runLocal` calls the app once per dataset example, scores each answer with two
 * code scorers, and uploads the results as one run. Run it twice, once per prompt
 * version, then open Compare per example in the dashboard.
 *
 * Requires:
 *   npm install @acruxcoreai/sdk
 *
 * Env:
 *   ACRUXCORE_API_KEY   -- required, a personal key of an editor (or above)
 *   ACRUXCORE_BASE_URL  -- required, e.g. https://acruxcore.com/api/v1
 *   ACRUXCORE_MODEL     -- a model registered under Gateway -> Models, default "gpt-4o-mini"
 *
 * Run:
 *   node run_experiment.mjs v1
 *   node run_experiment.mjs v2
 */
import { readFile } from 'node:fs/promises';
import { acruxcore } from '@acruxcoreai/sdk';

const MODEL = process.env.ACRUXCORE_MODEL ?? 'gpt-4o-mini';
const DATASET_NAME = 'ticket-triage-demo';
const VERSION = process.argv[2] ?? 'v1';

// The one thing that changes between the two runs: the classification prompt.
// v1 forgets the `account` category that ROUTES below already knows about.
const PROMPTS = {
  v1: 'Classify the support ticket as billing, bug or question. Reply with JSON: {"category": "..."}',
  v2: 'Classify the support ticket as billing, bug, question or account. Reply with JSON: {"category": "..."}',
};

// Step 2 of the app is plain code, not a model call.
const ROUTES = { billing: 'finance', bug: 'engineering', question: 'support', account: 'support' };

const hub = new acruxcore();

/** Finds the demo dataset, or creates it from ../data/tickets.json on the first run. */
async function demoDataset() {
  const existing = (await hub.datasets.list()).find((d) => d.name === DATASET_NAME);
  if (existing) return existing.id;
  const examples = JSON.parse(await readFile(new URL('../data/tickets.json', import.meta.url), 'utf8'));
  const dataset = await hub.datasets.create({ name: DATASET_NAME });
  await hub.datasets.addExamples(dataset.id, examples);
  return dataset.id;
}

/** The app under test. `ctx.trace` puts the model call into this example's trace. */
async function triage(input, ctx) {
  const reply = await hub.gateway.chat({
    model: MODEL,
    messages: [
      { role: 'system', content: PROMPTS[VERSION] },
      { role: 'user', content: input.ticket },
    ],
    responseFormat: { type: 'json_object' },
    trace: ctx.trace,
  });
  const category = JSON.parse(reply.content ?? '{}').category ?? 'unknown';
  return { category, team: ROUTES[category] ?? 'support' };
}

// Scorers: plain functions that compare the output with the example's `expected`.
function categoryExact({ output, expected }) {
  return output.category === expected.category;
}

function teamExact({ output, expected }) {
  return {
    score: output.team === expected.team ? 1 : 0,
    reason: output.team === expected.team ? null : `expected ${expected.team}, got ${output.team}`,
  };
}

const datasetId = await demoDataset();
const result = await hub.experiments.runLocal(datasetId, {
  task: triage,
  scorers: [categoryExact, teamExact],
  name: VERSION,
  model: MODEL,
});

console.log(`run ${result.runId} ${result.status}`);
for (const [name, s] of Object.entries(result.summary)) {
  console.log(`  ${name.padEnd(14)} mean ${s.mean?.toFixed(2)}  passed ${Math.round((s.passRate ?? 0) * s.scored)}/${s.scored}`);
}
for (const item of result.items) {
  const failed = item.scores.filter((s) => s.passed === false).map((s) => s.name);
  if (item.error || failed.length) {
    console.log(`  ✗ ${item.input.ticket.slice(0, 60)}  ->  ${item.error ?? JSON.stringify(item.output)}`);
  }
}
console.log(`open: ${result.url}`);
await hub.close?.();
