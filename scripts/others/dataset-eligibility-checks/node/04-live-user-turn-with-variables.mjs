/**
 * Case 4 — the system prompt is committed, the user turn is sent live, and declared.
 *
 * Identical to case 3 in every respect but one: the call passes
 * `variables: { question }` alongside the messages it already rendered itself. The
 * gateway does not re-render anything — the messages are sent exactly as given — it only
 * records the values behind them.
 *
 * That one field is the whole difference between a run an evaluation can replay and one
 * it cannot. The span stores `variables: { question: '...' }`, the dataset build produces
 * an example whose input holds the question, and an experiment can render a candidate
 * system prompt against that same question.
 *
 * Run this and case 3 back to back, thumbs-down both, then select both feedback rows and
 * build one dataset: it reports one added and one skipped.
 *
 *   ACRUXCORE_API_KEY=... node 04-live-user-turn-with-variables.mjs "your question"
 */
import AcruxCore from '@acruxcoreai/sdk';

const MODEL = process.env.MODEL ?? 'gpt-4o-mini';
const PROMPT_NAME = 'eligibility-check-live-user-turn';
const QUESTION = process.argv[2]?.trim() || 'How do I rotate an API key?';

// The committed version. A system message and nothing else — the user turn is not part of
// the stored prompt at all, which is what makes this different from cases 1 and 2.
const MESSAGES = [
  { role: 'system', content: 'You are a AI support agent. Answer in one sentence.' },
];

// cacheTtl 0 disables the render cache. This script promotes a new version and then
// renders again in the same process, and a cached render would serve the version that
// was live a moment ago.
const hub = new AcruxCore({ cacheTtl: 0 });

/**
 * Creates the prompt if missing, then makes sure `production` serves MESSAGES.
 *
 * Committing is not enough on its own: only a prompt's FIRST commit mints the
 * `production` and `staging` aliases, so every later version has to be promoted
 * explicitly or `render(..., 'production')` keeps serving the version it was pointed
 * at when the prompt was created.
 */
async function ensurePrompt() {
  const existing = await hub.prompts.list({ search: PROMPT_NAME, limit: 100 });
  const found = existing.data.find((p) => p.name === PROMPT_NAME);

  if (!found) {
    const prompt = await hub.prompts.create({
      name: PROMPT_NAME,
      description: 'System prompt only — the user turn is appended by the caller at request time.',
    });
    await hub.prompts.commitVersion(prompt.id, { messages: MESSAGES, model: MODEL });
    return prompt;
  }

  const shape = (messages) => JSON.stringify(messages.map((m) => [m.role, m.content]));
  const live = await hub.prompts.render(PROMPT_NAME, 'production');
  if (shape(live.messages) !== shape(MESSAGES)) {
    const version = await hub.prompts.commitVersion(found.id, { messages: MESSAGES, model: MODEL });
    await hub.prompts.promoteAlias(found.id, 'production', version.versionNumber);
    console.log(`committed v${version.versionNumber}, production now points at it`);
  }

  return found;
}

const prompt = await ensurePrompt();
const rendered = await hub.prompts.render(PROMPT_NAME, 'production');

// The live turn, appended client-side. The gateway is sent finished messages, so it
// renders nothing — `messages` and `prompt` are mutually exclusive on the API.
const messages = [...rendered.messages, { role: 'user', content: QUESTION }];

// Declaring the same value the message text already contains. It is not sent to the model
// and changes nothing about the call — it is recorded on the span so an evaluation knows
// what this run varied.
const variables = { question: QUESTION };

console.log(`prompt:            ${prompt.name} (${prompt.id})`);
console.log(`render.versionId:  ${rendered.versionId}`);
console.log(`stored messages:   ${JSON.stringify(rendered.messages.map((m) => m.role))}`);
console.log(`messages sent:     ${JSON.stringify(messages.map((m) => m.role))}`);
console.log(`variables sent:    ${JSON.stringify(variables)}   <- what an experiment replays`);

const result = await hub.gateway.chat({
  model: MODEL,
  messages,
  promptVersionId: rendered.versionId,
  variables,
});

console.log(`\nanswer:  ${result.content}`);
console.log(`trace:   ${result.gateway.traceId}`);
console.log("\nExpect this one to be ADDED, with the question as the example's input.");
