/**
 * Trace an OpenAI Agents SDK support-triage system via OTLP -- no AcruxCore SDK
 * involved in the agents themselves.
 *
 * A Triage agent hands off to a Billing agent or a Tech Support agent, each with
 * its own tool. The only AcruxCore-specific code in this file is the block under
 * "OTel + OpenInference wiring" below -- everything else is plain OpenAI Agents
 * SDK (JS) code.
 *
 * Requires:
 *   npm install @acruxcoreai/sdk @openai/agents zod dotenv \
 *     @arizeai/openinference-instrumentation-openai-agents @arizeai/openinference-core
 *
 * Env vars (exported directly, or via a .env file in the directory you run
 * `node` from -- dotenv/config only reads the current working directory, it
 * does not search upward like Python's dotenv does):
 *   OPENAI_API_KEY       -- real OpenAI key, calls gpt-4o-mini
 *   ACRUXCORE_API_KEY    -- e.g. acx_sk_...
 *   ACRUXCORE_BASE_URL   -- e.g. https://api.acruxcore.com/api/v1
 */
import 'dotenv/config';
import { register } from '@acruxcoreai/sdk/otel';
import { Agent, run, tool } from '@openai/agents';
import { context } from '@opentelemetry/api';
import { setSession } from '@arizeai/openinference-core';
import { z } from 'zod';

// --- OTel + OpenInference wiring --------------------------------------------
// instrument: ['openai_agents'] replaces the Agents SDK's default trace
// processor (which reports to platform.openai.com) with the OpenInference one --
// there is no separate "disable" step. Nothing below this block is
// AcruxCore-specific.
const provider = await register({
  serviceName: 'support-triage-agents-sdk',
  instrument: ['openai_agents'],
});
// -----------------------------------------------------------------------------

const MOCK_SUBSCRIPTIONS = {
  'alex@example.com': { tier: 'Pro', renewedOn: '2026-08-01', lastChargeUsd: 49.0 },
};

const MOCK_ORDERS = {
  A1234: { status: 'delivered', appVersion: '3.4.1', knownCrashBug: true },
};

const checkSubscription = tool({
  name: 'check_subscription',
  description: "Look up a customer's subscription tier and most recent charge.",
  parameters: z.object({ customerEmail: z.string().describe("The customer's account email address.") }),
  execute: async ({ customerEmail }) => {
    const record = MOCK_SUBSCRIPTIONS[customerEmail];
    if (!record) return `No subscription found for ${customerEmail}.`;
    return (
      `${customerEmail} is on the ${record.tier} plan, renewed ${record.renewedOn}, ` +
      `last charge $${record.lastChargeUsd.toFixed(2)}.`
    );
  },
});

const lookupOrder = tool({
  name: 'lookup_order',
  description: "Look up an order's delivery status and the app version tied to it.",
  parameters: z.object({ orderId: z.string().describe('The order identifier, e.g. "A1234".') }),
  execute: async ({ orderId }) => {
    const record = MOCK_ORDERS[orderId];
    if (!record) return `No order found with id ${orderId}.`;
    const crashNote = record.knownCrashBug
      ? ' This app version has a known crash bug, already fixed in the latest release.'
      : '';
    return `Order ${orderId} was ${record.status} on app version ${record.appVersion}.${crashNote}`;
  },
});

const billingAgent = new Agent({
  name: 'Billing',
  handoffDescription: 'Handles subscription, billing, and charge questions.',
  instructions:
    "You help with billing questions. Use check_subscription to look up the customer's " +
    'plan and charges before answering. Be concise.',
  tools: [checkSubscription],
  model: 'gpt-4o-mini',
});

const techSupportAgent = new Agent({
  name: 'Tech Support',
  handoffDescription: 'Handles app crashes, bugs, and order/delivery status.',
  instructions:
    'You help with technical issues and order status. Use lookup_order to check the ' +
    'order before answering. Be concise.',
  tools: [lookupOrder],
  model: 'gpt-4o-mini',
});

const triageAgent = new Agent({
  name: 'Triage',
  instructions:
    'Route the customer to Billing for subscription/charge questions, or to Tech Support ' +
    'for app/order problems. Do not answer directly yourself.',
  handoffs: [billingAgent, techSupportAgent],
  model: 'gpt-4o-mini',
});

async function main() {
  const sessionId = 'support-triage-demo-session';

  await context.with(setSession(context.active(), { sessionId }), async () => {
    const turn1 = await run(
      triageAgent,
      'I was charged twice this month, can you check my subscription? My email is alex@example.com',
    );
    console.log('--- Turn 1 (expect Billing handoff) ---');
    console.log(turn1.finalOutput);

    const turn2Input = [
      ...turn1.history,
      {
        role: 'user',
        content: 'Also my app keeps crashing on order #A1234, can you check that order’s status?',
      },
    ];
    const turn2 = await run(triageAgent, turn2Input);
    console.log('\n--- Turn 2 (expect Tech Support handoff) ---');
    console.log(turn2.finalOutput);
  });

  console.log(`\nsession.id used for both turns: ${sessionId}`);

  await provider.forceFlush();
}

main();
