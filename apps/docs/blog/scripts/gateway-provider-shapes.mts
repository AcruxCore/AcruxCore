/**
 * Captures the exact outbound request each gateway provider adapter builds from
 * one identical canonical (OpenAI-shaped) request, backing "One Gateway, Three
 * Providers: Comparing Anthropic, OpenAI, and Gemini Request Shapes Behind One
 * API" (../2026-08-01-one-gateway-three-providers.md).
 *
 * This imports the real, unmodified adapter classes from apps/api/src/gateway/
 * providers/ and calls their actual `chatCompletion` methods — no source file is
 * changed or reimplemented. `fetch` is temporarily replaced for the life of this
 * process only, to capture the literal method/url/headers/body each adapter hands
 * to it, and to hand back a minimal valid response so the adapter's own response
 * normalizer also runs for real on realistic mocked provider bodies. No network
 * request actually leaves the machine, and no upstream credential is required —
 * this only needs the deterministic request/response *shape* each adapter
 * produces, not a live provider round trip.
 *
 * Usage: npx tsx gateway-provider-shapes.mts
 */

import { AnthropicAdapter } from '../../../api/src/gateway/providers/anthropic.adapter';
import { GeminiAdapter } from '../../../api/src/gateway/providers/gemini.adapter';
import { OpenAiAdapter } from '../../../api/src/gateway/providers/openai.adapter';
import type { NormalizedRequest } from '../../../api/src/gateway/providers/types';

// One request, identical across all three providers.
const REQUEST: NormalizedRequest = {
  model: 'demo-model',
  messages: [
    { role: 'system', content: 'You are a concise, friendly support agent.' },
    { role: 'user', content: 'My order has not arrived yet — can you look it up?' },
  ],
  temperature: 0.2,
  max_tokens: 200,
  tools: [
    {
      type: 'function',
      function: {
        name: 'lookup_order',
        description: 'Look up an order by its id.',
        parameters: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
      },
    },
  ],
  tool_choice: 'auto',
};

const MOCK_RESPONSES: Record<string, unknown> = {
  anthropic: {
    id: 'msg_demo',
    model: 'claude-3-haiku-20240307',
    content: [{ type: 'text', text: 'Sure — could you share the order ID?' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 42, output_tokens: 12 },
  },
  gemini: {
    candidates: [{ content: { parts: [{ text: 'Sure — could you share the order ID?' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 12 },
  },
  openai: {
    id: 'chatcmpl-demo',
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Sure — could you share the order ID?' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
  },
};

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

async function capture(label: 'anthropic' | 'gemini' | 'openai', run: () => Promise<unknown>) {
  let captured: Captured | null = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    captured = {
      url: url.toString(),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    return new Response(JSON.stringify(MOCK_RESPONSES[label]), { status: 200 });
  }) as typeof fetch;

  let normalizedResponse: unknown;
  try {
    normalizedResponse = await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
  return { captured, normalizedResponse };
}

async function main() {
  const anthropic = new AnthropicAdapter();
  const gemini = new GeminiAdapter();
  const openai = new OpenAiAdapter('openai');

  const results = {
    anthropic: await capture('anthropic', () => anthropic.chatCompletion(REQUEST, { apiKey: 'placeholder' })),
    gemini: await capture('gemini', () => gemini.chatCompletion(REQUEST, { apiKey: 'placeholder' })),
    openai: await capture('openai', () => openai.chatCompletion(REQUEST, { apiKey: 'placeholder' })),
  };

  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
