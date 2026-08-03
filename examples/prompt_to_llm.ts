/**
 * Get a system prompt from acruxcore, add a user message, call the LLM.
 *
 * Needs: npm install openai @acruxcoreai/sdk
 * Run: npx tsx prompt_to_llm.ts
 */
import OpenAI from 'openai';
import { acruxcore } from '@acruxcoreai/sdk';

const BASE_URL = 'http://localhost:3001/api/v1';
// Never hardcode credentials — export these before running the example.
const API_KEY = process.env.ACRUXCORE_API_KEY ?? 'acx_sk_REPLACE_WITH_YOUR_KEY'; // renders the prompt (any role)
const GATEWAY_KEY =
  process.env.ACRUXCORE_GATEWAY_KEY ?? 'agh_sk_REPLACE_WITH_YOUR_GATEWAY_KEY'; // gateway virtual key (OpenAI-compatible)

async function main() {
  // 1. Get the system message from acruxcore (renders the stored prompt).
  const hub = new acruxcore({ apiKey: API_KEY, baseUrl: BASE_URL });
  const systemMessages = await hub.renderPrompt('Test', 'production', { name: 'Alice' });

  // 2. Add a user message and call the LLM through the gateway.
  const client = new OpenAI({ apiKey: GATEWAY_KEY, baseURL: `${BASE_URL}/gateway` });
  const response = await client.chat.completions.create({
    model: 'Mimo',
    messages: [...systemMessages, { role: 'user', content: 'Hi' }],
  });

  console.log(response.choices[0].message.content);
}

main();
