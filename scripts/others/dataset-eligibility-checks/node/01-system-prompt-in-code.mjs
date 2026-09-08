/**
 * Case 1 — the system prompt lives in code, not in AcruxCore.
 *
 * Nothing about this run names a prompt version: the messages are built here, in source,
 * and sent as-is. This is what a LangChain or LangGraph agent looks like from the
 * gateway's side, and it is the case that has no lineage at all to replay.
 *
 * Run it, then thumbs-down the trace and try to build a dataset from that feedback.
 * Expected: the row is skipped with "the prompt is not stored in AcruxCore" — the trace's
 * spans carry no promptVersionId, so there is no template to render a candidate against.
 *
 *   ACRUXCORE_API_KEY=... node 01-system-prompt-in-code.mjs
 */
import AcruxCore from '@acruxcoreai/sdk';

const MODEL = process.env.MODEL ?? 'gpt-4o-mini';

// The prompt AcruxCore never sees.
const SYSTEM_PROMPT = 'You are a terse support agent. Answer in one sentence.';
// `trim() ||` guards a blank argument: an empty user message is a 400 from the gateway
// ("content must not be empty"), a confusing way to learn you forgot the question.
const QUESTION = process.argv[2]?.trim() || 'How do I rotate an API key?';

const hub = new AcruxCore();

const result = await hub.gateway.chat({
  model: MODEL,
  messages: [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: QUESTION },
  ],
  // No promptVersionId and no variables — there is nothing to name.
});

console.log(`answer:  ${result.content}`);
console.log(`trace:   ${result.gateway.traceId}`);
console.log('\nNext: open the trace, leave a thumbs-down with a comment, then');
console.log('Observability → Feedback → select the row → Create dataset.');
