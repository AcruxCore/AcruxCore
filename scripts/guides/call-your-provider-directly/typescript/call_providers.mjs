/**
 * Call your provider directly with your own key (BYO) -- TypeScript.
 *
 * Walks the guide at https://docs.acruxcore.com/docs/guides/call-your-provider-directly.
 * For each provider whose key is set, the script runs three calls with the
 * provider's own key, and the SDK reports each one to AcruxCore as a trace:
 *
 *   1. a plain chat() call
 *   2. the same call with stream: true
 *   3. a tool loop: the model calls get_weather for two cities, then answers
 *
 * OpenAI and OpenRouter use the OpenAI Chat Completions format. Anthropic and
 * Gemini use their own APIs (Messages and generateContent); the SDK translates.
 * No provider SDK is needed.
 *
 * Requires:
 *   npm install @acruxcoreai/sdk zod
 *
 * Env:
 *   ACRUXCORE_API_KEY   -- required, an AcruxCore API key (it sends the traces)
 *   ACRUXCORE_BASE_URL  -- defaults to https://api.acruxcore.com/api/v1
 *   OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY
 *                       -- set any of them; providers without a key are skipped
 *   OPENAI_MODEL, ANTHROPIC_MODEL, GEMINI_MODEL, OPENROUTER_MODEL
 *                       -- optional, override the model used for that provider
 *
 * Run:
 *   node call_providers.mjs
 */
import AcruxCore, { acrux } from '@acruxcoreai/sdk';
import { z } from 'zod/v4';  // works on zod 3.25+ and zod 4

// Each entry is the same `provider` setting as in the guide, plus the model to call.
// A provider whose key is not set is skipped.
const PROVIDERS = {
  openai: {
    provider: { baseUrl: 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY },
    model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  },
  anthropic: {
    provider: { kind: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY },
    model: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5',
  },
  gemini: {
    provider: { kind: 'gemini', apiKey: process.env.GEMINI_API_KEY },
    model: process.env.GEMINI_MODEL ?? 'gemini-3-flash-preview',
  },
  openrouter: {
    provider: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY },
    model: process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini',
  },
};

const HELLO = [{ role: 'user', content: 'Say hello in five words.' }];
const WEATHER_QUESTION = [{
  role: 'user',
  content: 'What is the weather in Paris and in Rome? Call the tool once per city, then answer in one sentence.',
}];
const TEMPERATURES = { Paris: 18, Rome: 24 };

// acrux.tool() puts the tool's definition and its code in one value. The SDK turns the
// zod schema into the JSON Schema the model reads. The function runs on your machine;
// the model only sees what it returns.
const getWeather = acrux.tool(
  {
    name: 'get_weather',
    description: 'Current weather for one city.',
    parameters: z.object({ city: z.string().describe("City name, e.g. 'Paris'.") }),
  },
  ({ city }) => ({ city, temp_c: TEMPERATURES[city] ?? 20 }),
);

async function runProvider(hub, name, provider, model) {
  console.log(`== ${name} (${model})`);

  const reply = await hub.gateway.chat({ model, messages: HELLO, provider, trace: { name: `byo-${name}-chat` } });
  console.log(`  chat:   ${JSON.stringify(reply.content.trim())}  (${reply.usage?.promptTokens}+${reply.usage?.completionTokens} tokens)`);

  let text = '';
  const stream = await hub.gateway.chat({ model, messages: HELLO, provider, stream: true, trace: { name: `byo-${name}-stream` } });
  for await (const chunk of stream) text += chunk.delta.content ?? '';
  console.log(`  stream: ${JSON.stringify(text.trim())}`);

  const loop = await hub.gateway.runToolLoop({
    model,
    messages: WEATHER_QUESTION,
    tools: [getWeather],
    provider,
    trace: { name: `byo-${name}-tools` },
  });
  const calls = loop.messages.reduce((n, m) => n + (m.role === 'assistant' ? m.tool_calls?.length ?? 0 : 0), 0);
  console.log(`  tools:  ${JSON.stringify(loop.content.trim())}  (${calls} tool calls, ${loop.iterations} model turns)`);
}

const hub = new AcruxCore({
  apiKey: process.env.ACRUXCORE_API_KEY,
  baseUrl: process.env.ACRUXCORE_BASE_URL ?? 'https://api.acruxcore.com/api/v1',
});

for (const [name, { provider, model }] of Object.entries(PROVIDERS)) {
  if (!provider.apiKey) {
    console.log(`== ${name}: skipped, ${name.toUpperCase()}_API_KEY is not set`);
    continue;
  }
  try {
    await runProvider(hub, name, provider, model);
  } catch (err) {
    // A wrong key or a provider quota fails one provider, not the whole run.
    console.log(`  failed: ${err.message}`);
  }
}

// Traces are sent in the background; flush them before the process exits.
await hub.gateway.flush();
console.log('Done. Each call is a trace under Traces in the dashboard.');
