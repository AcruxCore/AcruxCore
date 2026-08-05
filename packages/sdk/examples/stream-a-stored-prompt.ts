/**
 * Example: fetch a stored prompt with the SDK, then STREAM the reply token by
 * token instead of waiting for the whole completion.
 *
 * This reuses the same `travel-assistant` prompt that `rest-defined-agent.ts`
 * stores in the framework — run that example first (or store the prompt yourself)
 * so `renderPrompt` has something to fetch. The flow here is fetch → stream:
 *
 *   1. `renderPrompt(name, 'production', vars)` returns the templated `messages`
 *      (and the version's attached `tools`, which this example intentionally does
 *      NOT forward — see below).
 *   2. `gateway.stream({ ... })` returns an async iterable. Each chunk carries
 *      a `delta.content` string; concatenating them rebuilds the full answer as it
 *      is generated, so a UI can render tokens live.
 *
 * Why no tools here: streaming yields text deltas. If the model decided to call a
 * tool instead of answering, the first turn would stream tool-call fragments, not
 * prose — and streaming does not auto-run tools (that is what `runToolLoop` is
 * for). To keep the streamed output a clean, readable answer, this example omits
 * `tools` so the model replies directly. Use `gateway.runToolLoop` when you need the tools.
 *
 * Run:
 *   ACRUXCORE_API_KEY=<your key> \
 *   ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1 \
 *   ACRUXCORE_MODEL=<a model your team registered> \
 *   npx tsx packages/sdk/examples/stream-a-stored-prompt.ts
 *
 * `ACRUXCORE_MODEL` must be a model your team has registered in the gateway; it
 * defaults to `gpt-4o-mini`.
 */

import acruxcore from '@acruxcoreai/sdk';

const apiKey = process.env.ACRUXCORE_API_KEY;
const baseUrl = process.env.ACRUXCORE_BASE_URL;
const model = process.env.ACRUXCORE_MODEL ?? 'gpt-4o-mini';

if (!apiKey || !baseUrl) {
  throw new Error('Set ACRUXCORE_API_KEY and ACRUXCORE_BASE_URL first.');
}

const hub = new acruxcore({ apiKey, baseUrl });

async function main(): Promise<void> {
  // ── FETCH: the templated messages come from the stored prompt version.
  const { messages } = await hub.prompts.render('travel-assistant', 'production', {
    city: 'Tokyo',
    amount: 100,
    from: 'USD',
    to: 'JPY',
  });

  // ── STREAM: print each token as it arrives. `gateway.stream()` returns an
  // async iterable of chunks (no `tools` forwarded — see file header).
  const stream = await hub.gateway.stream({ model, messages });

  let full = '';
  for await (const chunk of stream) {
    const piece = chunk.delta.content ?? '';
    process.stdout.write(piece); // render live
    full += piece;
  }

  console.log(`\n\n(streamed ${full.length} characters)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
