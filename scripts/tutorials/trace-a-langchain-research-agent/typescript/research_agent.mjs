/**
 * Trace a LangChain research agent via OTLP -- no AcruxCore SDK calls in the agent
 * itself.
 *
 * A two-tool agent: Tavily web search for facts it does not know, and a local
 * split_cost calculator it is told to use for any arithmetic. Run twice in one
 * session, the second turn a genuine follow-up on the first. The only
 * AcruxCore-specific code in this file is the `register()` block below --
 * everything else is plain LangChain.
 *
 * Requires:
 *   npm install @acruxcoreai/sdk langchain @langchain/openai @langchain/core \
 *     @langchain/tavily zod dotenv \
 *     @arizeai/openinference-instrumentation-langchain @arizeai/openinference-core \
 *     @opentelemetry/api @opentelemetry/sdk-trace-node @opentelemetry/sdk-trace-base \
 *     @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources \
 *     @opentelemetry/semantic-conventions
 *
 * Env vars (exported directly, or via a .env file in the directory you run
 * `node` from -- dotenv/config only reads the current working directory, it
 * does not search upward like Python's dotenv does):
 *   OPENAI_API_KEY       -- real OpenAI key, calls gpt-4o-mini
 *   TAVILY_API_KEY       -- real Tavily key, powers the search tool
 *   ACRUXCORE_API_KEY    -- e.g. acx_sk_...
 *   ACRUXCORE_BASE_URL   -- e.g. https://api.acruxcore.com/api/v1
 */
import 'dotenv/config';
import { register } from '@acruxcoreai/sdk/otel';
import { createAgent, tool } from 'langchain';
import { ChatOpenAI } from '@langchain/openai';
import { TavilySearch } from '@langchain/tavily';
import { context } from '@opentelemetry/api';
import { setSession } from '@arizeai/openinference-core';
import { z } from 'zod';

// --- OTel + OpenInference wiring --------------------------------------------
// One instrumentor is enough, unlike the CrewAI tutorial: instrument:
// ['langchain'] patches LangChain's own CallbackManager, which already sees the
// model call ChatOpenAI makes. Adding 'openai' on top would double-report every
// LLM span. Nothing below this block is AcruxCore-specific.
const provider = await register({
  serviceName: 'langchain-research-agent',
  instrument: ['langchain'],
});
// -----------------------------------------------------------------------------

const MODEL = 'gpt-4o-mini';

const SYSTEM_PROMPT =
  'You are a research assistant. Search the web for facts you do not already know, ' +
  'and name your sources. When a question involves splitting a cost between people ' +
  'or across months, you MUST use the split_cost tool rather than doing the ' +
  'arithmetic yourself.';

const splitCost = tool(
  async ({ totalAmount, people, months }) => {
    if (people <= 0 || months <= 0) return 'people and months must both be greater than zero';
    const grandTotal = totalAmount * months;
    const perPersonPerMonth = totalAmount / people;
    const perPersonTotal = grandTotal / people;
    return (
      `Total for ${months} month(s): ${grandTotal.toFixed(2)}. ` +
      `Per person per month: ${perPersonPerMonth.toFixed(2)}. ` +
      `Per person for the whole ${months} month(s): ${perPersonTotal.toFixed(2)}.`
    );
  },
  {
    name: 'split_cost',
    description: 'Split a total cost between people and across months.',
    schema: z.object({
      totalAmount: z.number().describe('The full amount for ONE month, in any single currency.'),
      people: z.number().int().describe('How many people share the cost.'),
      months: z.number().int().describe('How many months the cost runs for.'),
    }),
  },
);

/** Builds the two-tool agent. Rebuilt per turn so each run is independent. */
function buildAgent() {
  return createAgent({
    model: new ChatOpenAI({ model: MODEL, temperature: 0 }),
    tools: [new TavilySearch({ maxResults: 5 }), splitCost],
    systemPrompt: SYSTEM_PROMPT,
  });
}

/**
 * Invokes the agent on a message list and returns the final assistant text.
 *
 * `runName` is what makes the trace findable: without it LangGraph names every
 * root span after the graph class, so the trace list fills with identical
 * "LangGraph" rows and you cannot tell one run from another.
 */
async function runTurn(messages) {
  const result = await buildAgent().invoke({ messages }, { runName: 'research-agent' });
  return result.messages.at(-1).content;
}

async function main() {
  const sessionId = 'langchain-research-agent-demo-node';

  const question1 =
    'What does a hot desk at Second Home Lisboa in Lisbon cost per month? ' +
    'Give the price and the source.';
  const question2 =
    'Four of us want that hot desk for 3 months. What is the total, and the ' +
    'cost per person per month?';

  await context.with(setSession(context.active(), { sessionId }), async () => {
    const answer1 = await runTurn([{ role: 'user', content: question1 }]);
    console.log('\n=== Turn 1 answer ===\n');
    console.log(answer1);

    // Turn 2 carries turn 1's real answer forward, so the model has the price it
    // found and only needs the calculator -- a genuine follow-up, not a fresh
    // question wearing the same session id.
    const answer2 = await runTurn([
      { role: 'user', content: question1 },
      { role: 'assistant', content: answer1 },
      { role: 'user', content: question2 },
    ]);
    console.log('\n=== Turn 2 answer (follow-up) ===\n');
    console.log(answer2);
  });

  console.log(`\nsession.id used for both turns: ${sessionId}`);

  await provider.forceFlush();
}

main();
