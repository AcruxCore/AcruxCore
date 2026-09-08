/**
 * Case 3 — the system prompt is committed, the user turn is sent live, nothing declared.
 *
 * The shape most apps actually have: the system prompt is a stored, versioned asset, and
 * the user's question arrives at request time and is appended by the client. The committed
 * version therefore holds the system message ONLY, and the messages sent to the gateway
 * are `[stored system, live user]`.
 *
 * The call names its prompt version, so the trace has lineage. But it declares no
 * `variables`, so nothing records what varied between one run and the next — the question
 * is inside the message text and nowhere else. The span stores `variables: null`, and the
 * dataset build skips the row.
 *
 * That is the point of this script. Lineage alone is not enough; case 4 is the same run
 * with one field added.
 *
 *   ACRUXCORE_API_KEY=... node 03-live-user-turn-no-variables.mjs "your question"
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

console.log(`prompt:            ${prompt.name} (${prompt.id})`);
console.log(`render.versionId:  ${rendered.versionId}`);
console.log(`stored messages:   ${JSON.stringify(rendered.messages.map((m) => m.role))}`);
console.log(`messages sent:     ${JSON.stringify(messages.map((m) => m.role))}`);
console.log('variables sent:    (none)   <- the question is only inside the text');

const result = await hub.gateway.chat({
  model: MODEL,
  messages,
  promptVersionId: rendered.versionId,
});

console.log(`\nanswer:  ${result.content}`);
console.log(`trace:   ${result.gateway.traceId}`);
console.log('\nExpect this one to be SKIPPED: the span records the version but');
console.log('variables = null, so there is nothing for a candidate to render against.');
