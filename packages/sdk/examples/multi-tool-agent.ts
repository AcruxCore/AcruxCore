/**
 * Example: a small agent with MULTIPLE tools, driven by `runToolLoop`.
 *
 * `runToolLoop` is the SDK's client-side tool-calling loop: it calls the model
 * through the gateway, hands any `tool_calls` the model emits to your `dispatch`
 * function, appends the results, and loops until the model answers in plain text
 * (or hits `maxIterations`). Your tools run locally — the loop just shuttles
 * arguments in and results out.
 *
 * This agent is given three independent tools:
 *   - get_weather(city)        → current conditions for a city
 *   - convert_currency(...)    → convert an amount between two currencies
 *   - get_current_time(tz)     → wall-clock time in an IANA timezone
 *
 * Because the three tools don't depend on each other, a single model turn can
 * request several at once (e.g. "weather in Tokyo AND the time there"). The SDK
 * dispatches all calls in that turn concurrently and appends the results in call
 * order, so parallelisable work isn't serialised.
 *
 * The whole run is auto-traced (one `llm` span per model round-trip + one `tool`
 * span per dispatch), so it shows up as a single trace in the Tracing UI without
 * any extra instrumentation. Pass `trace: false` to `runToolLoop` to opt out.
 *
 * Tools here are defined inline via `tools`. To use versioned tools from the Tool
 * Catalog instead, pass `toolRefs: [{ name, alias }]` and drop the inline `tools`
 * — the gateway resolves their schemas server-side.
 *
 * Run:
 *   ACRUXCORE_API_KEY=<your key> \
 *   ACRUXCORE_BASE_URL=http://localhost:3001/api/v1 \
 *   npx tsx packages/sdk/examples/multi-tool-agent.ts
 */

import acruxcore, { type ToolDefinition } from '@acruxcoreai/sdk';

const apiKey = process.env.ACRUXCORE_API_KEY;
const baseUrl = process.env.ACRUXCORE_BASE_URL;

if (!apiKey || !baseUrl) {
  throw new Error('Set ACRUXCORE_API_KEY and ACRUXCORE_BASE_URL first.');
}

/**
 * The tools the agent may call, in OpenAI function-calling shape. Each `name`
 * must match a branch in {@link dispatch}; the `description` and `parameters`
 * are what the model reads to decide when and how to call the tool.
 */
const tools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get the current weather for a city.',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'City name, e.g. "Tokyo".' },
        },
        required: ['city'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'convert_currency',
      description: 'Convert an amount of money from one currency to another.',
      parameters: {
        type: 'object',
        properties: {
          amount: { type: 'number', description: 'The amount to convert.' },
          from: { type: 'string', description: 'ISO 4217 source currency, e.g. "USD".' },
          to: { type: 'string', description: 'ISO 4217 target currency, e.g. "JPY".' },
        },
        required: ['amount', 'from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: 'Get the current wall-clock time in an IANA timezone.',
      parameters: {
        type: 'object',
        properties: {
          timezone: { type: 'string', description: 'IANA timezone, e.g. "Asia/Tokyo".' },
        },
        required: ['timezone'],
      },
    },
  },
];

/** Canned weather so the example runs without any external API or key. */
const WEATHER: Record<string, string> = {
  tokyo: '22°C, light rain',
  london: '15°C, overcast',
  'new york': '27°C, sunny',
};

/** Illustrative fixed rates (units of `to` per 1 unit of `from`). */
const RATES: Record<string, number> = {
  'USD:JPY': 157.0,
  'USD:EUR': 0.92,
  'EUR:USD': 1.09,
};

/**
 * Routes one tool call from the model to its local implementation. Called once
 * per `tool_call`; the returned value is JSON-stringified back into the
 * transcript as the tool result the model reads on the next turn.
 *
 * @param name - The tool name the model asked for (matches a `tools` entry).
 * @param args - The parsed JSON arguments object for this call.
 * @returns The tool's result — any JSON-serialisable value, or a string.
 * @throws {Error} If the model calls a tool name this agent doesn't implement.
 */
function dispatch(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'get_weather': {
      const city = String(args.city ?? '').toLowerCase();
      return { city: args.city, conditions: WEATHER[city] ?? 'no data for that city' };
    }
    case 'convert_currency': {
      const from = String(args.from ?? '').toUpperCase();
      const to = String(args.to ?? '').toUpperCase();
      const amount = Number(args.amount ?? 0);
      const rate = RATES[`${from}:${to}`];
      if (rate === undefined) return { error: `no rate for ${from}->${to}` };
      return { amount, from, to, converted: Math.round(amount * rate * 100) / 100, rate };
    }
    case 'get_current_time': {
      const timezone = String(args.timezone ?? 'UTC');
      // Intl gives us a real, timezone-aware clock with no dependencies.
      const time = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'short',
      }).format(new Date());
      return { timezone, time };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function main(): Promise<void> {
  const hub = new acruxcore({ apiKey, baseUrl });

  const result = await hub.gateway.runToolLoop({
    model: 'gpt-4o-mini',
    tools,
    dispatch,
    messages: [
      {
        role: 'system',
        content:
          'You are a helpful travel assistant. Use the provided tools to answer ' +
          'with concrete, up-to-date facts instead of guessing.',
      },
      {
        role: 'user',
        content:
          "What's the weather in Tokyo right now, what time is it there, and how " +
          'much is 100 USD in JPY?',
      },
    ],
  });

  console.log('Assistant:', result.content);
  console.log(`\n(${result.iterations} round-trip(s), trace ${result.traceId ?? 'disabled'})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
