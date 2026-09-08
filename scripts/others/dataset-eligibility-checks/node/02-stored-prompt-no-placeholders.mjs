/**
 * Case 2 — the prompt IS stored in AcruxCore, and has no placeholders.
 *
 * The version holds both messages verbatim: a fixed system message and a fixed user
 * message. Nothing varies between runs, so `prompts.render()` is called with no
 * variables and the render result carries `variables: {}`.
 *
 * The run therefore has lineage (a promptVersionId) but nothing to replay against.
 * Run it, then thumbs-down the trace and try to build a dataset from that feedback —
 * the point of this script is to see what the build does with an empty variables object.
 *
 *   ACRUXCORE_API_KEY=... node 02-stored-prompt-no-placeholders.mjs
 */
import AcruxCore from '@acruxcoreai/sdk';

const MODEL = process.env.MODEL ?? 'gpt-4o-mini';
const PROMPT_NAME = 'eligibility-check-no-placeholders';

// The version this script wants live. Edit these and re-run: `ensurePrompt` commits a
// new version and rolls `production` onto it, so the next trace shows the edit.
const MESSAGES = [
  { role: 'system', content: 'You are a AI support agent. Answer in one sentence.' },
  { role: 'user', content: 'How do I rotate an API key?' },
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
      description: 'No placeholders anywhere \u2014 a fixed system message and a fixed question.',
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

console.log(`prompt:            ${prompt.name} (${prompt.id})`);
console.log(`render.versionId:  ${rendered.versionId}`);
console.log(`render.variables:  ${JSON.stringify(rendered.variables)}   <- nothing to replay`);

const result = await hub.gateway.runPromptWithTools(rendered, { model: MODEL });

console.log(`\nanswer:  ${result.content}`);
console.log(`trace:   ${result.traceId}`);
console.log('\nNext: open the trace, leave a thumbs-down with a comment, then');
console.log('Observability → Feedback → select the row → Create dataset.');
