/**
 * Example: call the LLM WITHOUT naming a model (#12 "default model" binding).
 *
 * When a prompt version has a default model bound to it (set on the prompt page's
 * Editor tab, or in the Playground save dialog), a gateway completion that
 * references that stored prompt and OMITS `model` will use the bound model. The
 * gateway resolves it server-side, so this code never hard-codes a model name —
 * rebind the prompt in the UI and this file keeps working unchanged.
 *
 * Model precedence at the gateway:
 *   1. explicit request `model`            → always wins
 *   2. else the resolved version's binding → used here
 *   3. else                                → 400 "model is required"
 *
 * Note on the SDK surface: the typed client's `runToolLoop` REQUIRES a `model`
 * and always sends raw `messages`, so it cannot drive this prompt-reference path.
 * Until a `hub.complete({ prompt })` method exists, the working call is a direct
 * POST to the gateway, shown below. This is the exact request shape verified
 * against a running gateway.
 *
 * Run:
 *   ACRUXCORE_API_KEY=<your key> \
 *   ACRUXCORE_BASE_URL=http://localhost:3001/api/v1 \
 *   npx tsx packages/sdk/examples/call-with-bound-model.ts
 */

const apiKey = process.env.ACRUXCORE_API_KEY;
const baseUrl = process.env.ACRUXCORE_BASE_URL;

if (!apiKey || !baseUrl) {
  throw new Error('Set ACRUXCORE_API_KEY and ACRUXCORE_BASE_URL first.');
}

/** Minimal shape of the OpenAI-compatible completion response we read from. */
interface ChatCompletionResponse {
  choices: { message: { role: string; content: string | null } }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/**
 * Runs a stored prompt through the gateway without specifying a model.
 *
 * @param name - The stored prompt's name (slug).
 * @param alias - The alias to resolve, e.g. "production".
 * @param variables - Values for the prompt's `{{ placeholders }}`.
 * @returns The assistant's reply text.
 * @throws {Error} If the gateway returns a non-2xx status. A version with no
 *   bound model (and no explicit `model`) returns 400 "model is required".
 */
async function callBoundModel(
  name: string,
  alias: string,
  variables: Record<string, unknown>,
): Promise<string> {
  const res = await fetch(`${baseUrl}/gateway/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    // No `model` field — the gateway fills it from the prompt version's binding.
    body: JSON.stringify({ prompt: { name, alias, variables } }),
  });

  if (!res.ok) {
    throw new Error(`Gateway ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as ChatCompletionResponse;
  return data.choices[0]?.message.content ?? '';
}

async function main(): Promise<void> {
  const reply = await callBoundModel('summarise-article', 'production', {
    article: 'acruxcore lets you bind a default model to a prompt version.',
  });
  console.log('Assistant:', reply);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
