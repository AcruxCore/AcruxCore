/**
 * Example: store the system prompt AND the tools in the framework via REST, then
 * fetch both back through the SDK and run the agent — nothing about the prompt or
 * the tool schemas is hardcoded on the run path.
 *
 * The companion `multi-tool-agent.ts` hardcodes the tool JSON-schemas and the chat
 * messages inline. Here the flow is store → fetch → use:
 *
 *   STORE (REST, one-time setup):
 *     1. Tools  → POST /tools (shell) + POST /tools/:id/versions (schema). Each
 *        version stores the `parametersSchema` the model reads plus a
 *        `{ type: 'client' }` executor — "our own app runs this tool", so
 *        {@link dispatch} below still runs locally.
 *     2. Prompt → POST /prompts (shell) + POST /prompts/:id/versions with the
 *        templated messages AND `tools: [{ toolId }]` that ATTACH the catalog
 *        tools to this immutable version.
 *
 *   FETCH + USE (SDK, at run time):
 *     3. `renderPrompt(name, 'production', vars)` returns `{ messages, tools }` in
 *        one call: the messages are templated server-side and `tools` are the
 *        version's attached tool schemas, already in OpenAI shape. Both come from
 *        the framework — this file no longer holds them.
 *     4. `runToolLoop({ messages, tools })` runs the loop with exactly what was
 *        fetched. The only tool code left in this file is `dispatch` — the local
 *        implementations. Schemas, descriptions, and the prompt text live on the
 *        server.
 *
 * This is the realistic split for a team: prompts and tool contracts are versioned
 * and edited in the platform by whoever owns them; the app ships just the
 * executable logic and fetches the rest by name.
 *
 * The setup is written as idempotent "ensure" helpers (find-by-name, create only
 * if missing) because names are NOT unique in the catalog — a naive re-run would
 * create duplicate rows and make name resolution ambiguous. Run it as many times
 * as you like; it converges to one prompt (with the three tools attached) + three
 * tools.
 *
 * Run:
 *   ACRUXCORE_API_KEY=<your key> \
 *   ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1 \
 *   ACRUXCORE_MODEL=gpt-4o-mini \
 *   npx tsx packages/sdk/examples/rest-defined-agent.ts
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

// `baseUrl` already ends in /api/v1; the SDK trims a trailing slash, so mirror that.
const restBase = baseUrl.replace(/\/+$/, '');

/**
 * Minimal Bearer-authenticated REST call against the acruxcore API. The SDK
 * covers render/chat/tool-loop/trace; catalog authoring (create prompt/tool,
 * commit versions) is plain REST, so we call it directly here.
 *
 * @param method - HTTP method.
 * @param path - Path under the API base, e.g. `/tools` or `/prompts/:id/versions`.
 * @param body - Optional JSON body; omitted for GET/DELETE.
 * @returns The parsed JSON response (or `undefined` for a 204).
 * @throws {Error} If the response status is not 2xx, with the server's error body.
 */
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${restBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${method} ${path} → ${res.status}: ${detail}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** A row as returned by the list endpoints — only the fields we read. */
interface NamedRow {
  id: string;
  name: string;
}
/** Shape of the paginated list responses. */
interface ListResponse {
  data: NamedRow[];
  total: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Local tool implementations — the ONLY tool code left in this file. Their
// JSON-schemas live in the catalog and are fetched at run time (see main()).
// ────────────────────────────────────────────────────────────────────────────

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
 * Routes one tool call from the model to its local implementation. The tool
 * *names* here must match the catalog tools attached to the prompt version.
 *
 * @param name - The tool name the model asked for (a catalog tool name).
 * @param args - The parsed JSON arguments object for this call.
 * @returns The tool's result — any JSON-serialisable value.
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

// ────────────────────────────────────────────────────────────────────────────
// Catalog definitions used ONLY to seed the framework (the STORE step). At run
// time the schemas come back from renderPrompt, not from here.
// ────────────────────────────────────────────────────────────────────────────

/** A tool we want in the catalog: its name/description plus the JSON-schema the model reads. */
interface ToolSpec {
  name: string;
  description: string;
  parametersSchema: Record<string, unknown>;
}

/**
 * The three tools, in the shape the catalog stores. Note there is no OpenAI
 * `{ type: 'function', function: {...} }` wrapper here — the catalog stores the
 * bare `parametersSchema`, and render wraps it when it returns attached tools.
 */
const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parametersSchema: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name, e.g. "Tokyo".' } },
      required: ['city'],
    },
  },
  {
    name: 'convert_currency',
    description: 'Convert an amount of money from one currency to another.',
    parametersSchema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'The amount to convert.' },
        from: { type: 'string', description: 'ISO 4217 source currency, e.g. "USD".' },
        to: { type: 'string', description: 'ISO 4217 target currency, e.g. "JPY".' },
      },
      required: ['amount', 'from', 'to'],
    },
  },
  {
    name: 'get_current_time',
    description: 'Get the current wall-clock time in an IANA timezone.',
    parametersSchema: {
      type: 'object',
      properties: {
        timezone: { type: 'string', description: 'IANA timezone, e.g. "Asia/Tokyo".' },
      },
      required: ['timezone'],
    },
  },
];

const PROMPT_NAME = 'travel-assistant';

/**
 * The prompt version's messages, with nunjucks `{{ variables }}` the server fills
 * at render time. Seed data only — after the first run this text lives in the
 * catalog and is fetched via renderPrompt.
 */
const PROMPT_MESSAGES = [
  {
    role: 'system' as const,
    content:
      'You are a helpful travel assistant. Use the provided tools to answer with ' +
      'concrete, up-to-date facts instead of guessing.',
  },
  {
    role: 'user' as const,
    content:
      "What's the weather in {{ city }} right now, what time is it there, and how " +
      'much is {{ amount }} {{ from }} in {{ to }}?',
  },
];

// ────────────────────────────────────────────────────────────────────────────
// STORE (idempotent): create each resource only if a same-named one is missing.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Ensures a catalog tool with `spec.name` exists and has at least one committed
 * version, and returns its id. Safe to call repeatedly: it finds an existing tool
 * by exact name and only creates the shell/version that is missing.
 *
 * @param spec - The tool name, description, and parameters schema to converge to.
 * @returns The tool's id (used to attach it to the prompt version).
 * @throws {Error} On any non-2xx REST response.
 */
async function ensureTool(spec: ToolSpec): Promise<string> {
  const found = await api<ListResponse>(
    'GET',
    `/tools?search=${encodeURIComponent(spec.name)}`,
  );
  let tool = found.data.find((t) => t.name === spec.name);

  if (!tool) {
    tool = await api<NamedRow>('POST', '/tools', {
      name: spec.name,
      description: spec.description,
    });
    console.log(`  + created tool "${spec.name}"`);
  }

  const versions = await api<ListResponse>('GET', `/tools/${tool.id}/versions`);
  if (versions.total === 0) {
    // `{ type: 'client' }` = our own app executes the tool (see dispatch); the
    // platform stores the schema but never calls it itself. The first version
    // auto-creates the `production` alias the prompt attachment resolves against.
    await api('POST', `/tools/${tool.id}/versions`, {
      description: spec.description,
      parametersSchema: spec.parametersSchema,
      executor: { type: 'client' },
    });
    console.log(`  + committed v1 for tool "${spec.name}"`);
  }

  return tool.id;
}

/**
 * Ensures a prompt named {@link PROMPT_NAME} exists with a committed version that
 * carries {@link PROMPT_MESSAGES} and has the given catalog tools attached.
 * Idempotent, like {@link ensureTool}.
 *
 * @param toolIds - Catalog tool ids to attach to the version (from {@link ensureTool}).
 * @throws {Error} On any non-2xx REST response.
 */
async function ensurePrompt(toolIds: string[]): Promise<void> {
  const found = await api<ListResponse>(
    'GET',
    `/prompts?search=${encodeURIComponent(PROMPT_NAME)}`,
  );
  let prompt = found.data.find((p) => p.name === PROMPT_NAME);

  if (!prompt) {
    prompt = await api<NamedRow>('POST', '/prompts', {
      name: PROMPT_NAME,
      description: 'Travel assistant used by the rest-defined-agent SDK example.',
    });
    console.log(`  + created prompt "${PROMPT_NAME}"`);
  }

  const versions = await api<ListResponse>('GET', `/prompts/${prompt.id}/versions`);
  if (versions.total === 0) {
    // Attach the catalog tools to this immutable version. renderPrompt then
    // returns them alongside the messages. First commit auto-creates the
    // `production` alias renderPrompt reads below.
    await api('POST', `/prompts/${prompt.id}/versions`, {
      messages: PROMPT_MESSAGES,
      tools: toolIds.map((toolId) => ({ toolId })),
    });
    console.log(`  + committed v1 for prompt "${PROMPT_NAME}" (${toolIds.length} tools attached)`);
  }
}

async function main(): Promise<void> {
  // ── STORE: push the tools and the prompt (with tools attached) to the framework.
  console.log('Storing catalog tools and prompt in the framework…');
  const toolIds: string[] = [];
  for (const spec of TOOL_SPECS) {
    // Sequential so the log reads top-to-bottom; setup is one-time, off the hot path.
    toolIds.push(await ensureTool(spec));
  }
  await ensurePrompt(toolIds);

  const hub = new acruxcore({ apiKey, baseUrl });

  // ── FETCH: one SDK call returns BOTH the templated messages and the attached
  // tool schemas. Neither is defined on this run path — they came from the server.
  const { messages, tools } = await hub.renderPrompt(PROMPT_NAME, 'production', {
    city: 'Tokyo',
    amount: 100,
    from: 'USD',
    to: 'JPY',
  });
  console.log(
    `\nFetched from framework: ${messages.length} message(s) + ${tools.length} tool(s) ` +
      `[${tools.map((t) => t.function.name).join(', ')}]`,
  );

  // ── USE: run the loop with exactly what was fetched. `dispatch` supplies the
  // local execution for each fetched tool.
  // `toolDefs`, not `tools`: these are raw OpenAI-shaped definitions from
  // renderPrompt. `tools` is for tools declared with `acrux.tool`, which carry
  // their own body and need no dispatch.
  const result = await hub.runToolLoop({ model, messages, toolDefs: tools, dispatch });

  console.log('\nAssistant:', result.content);
  console.log(`\n(${result.iterations} round-trip(s), trace ${result.traceId ?? 'disabled'})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
