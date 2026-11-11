/** The steps a new team takes before its first traced call. */
export type StepId = 'credential' | 'model' | 'apiKey' | 'firstRequest';

/**
 * How a team sends its model calls, which decides the steps it needs.
 *
 * - `gateway`: calls go through the AcruxCore gateway with a stored provider key.
 * - `direct`: the SDK calls the provider with the team's own key (BYO). There is no
 *   credential or model to set up, so the path is only "API key, then first trace".
 */
export type SetupPath = 'gateway' | 'direct';

/**
 * Which steps the team has finished, as `GET /api/v1/onboarding` returns them.
 *
 * Each flag describes the whole team, not the signed-in user: an editor in a team
 * whose owner made a key sees the key step done, because an editor cannot make one.
 */
export interface ChecklistFacts {
  credential: boolean;
  model: boolean;
  /** A member's personal key, a team key, or a gateway virtual key exists. */
  apiKey: boolean;
  /** A gateway request or a trace has arrived. */
  firstRequest: boolean;
}

/** One rendered checklist row. */
export interface ChecklistStep {
  id: StepId;
  done: boolean;
}

/** Each path's steps, in display order. */
export const PATH_STEPS: Record<SetupPath, StepId[]> = {
  gateway: ['credential', 'model', 'apiKey', 'firstRequest'],
  direct: ['apiKey', 'firstRequest'],
};

/** Each step's title, shared by the checklist page and the next-step banner. */
export const STEP_TITLES: Record<StepId, string> = {
  credential: 'Connect a model provider',
  model: 'Add a model',
  apiKey: 'Create an API key',
  firstRequest: 'Send your first request',
};

/**
 * A step's title on a given path. On the direct path the last step is a traced call
 * to the provider, not a request to AcruxCore, so it says so.
 *
 * @param id - The step.
 * @param path - The team's setup path.
 */
export function stepTitle(id: StepId, path: SetupPath): string {
  return path === 'direct' && id === 'firstRequest' ? 'Send your first traced call' : STEP_TITLES[id];
}

/**
 * The 1-based position of a step, for "Step 2 of 4" labels.
 *
 * @param id - The step.
 * @param path - The team's setup path; defaults to the gateway path.
 * @returns Its number in display order.
 */
export function stepNumber(id: StepId, path: SetupPath = 'gateway'): number {
  return PATH_STEPS[path].indexOf(id) + 1;
}

/**
 * The path to show when the viewer has not chosen one on this device.
 *
 * A saved credential means the team uses the gateway. Traces with no credential
 * mean it already calls its provider directly. With neither, the gateway path is
 * shown, since it is the one most teams start with.
 *
 * @param facts - The team's status from the API.
 * @param stored - The path saved on this device, if any.
 */
export function resolvePath(facts: ChecklistFacts, stored: SetupPath | null): SetupPath {
  if (stored) return stored;
  if (!facts.credential && facts.firstRequest) return 'direct';
  return 'gateway';
}

/**
 * Marks each onboarding step done or not from the team's real data.
 *
 * Each step is judged on its own fact, never on the steps before it: a team
 * that already sent traces through the SDK, with no gateway setup at all,
 * still sees "first request" ticked.
 *
 * @param facts - The team's status from the API.
 * @param path - Which path's steps to return; defaults to the gateway path.
 * @returns The path's steps in display order.
 */
export function checklistSteps(facts: ChecklistFacts, path: SetupPath = 'gateway'): ChecklistStep[] {
  return PATH_STEPS[path].map((id) => ({ id, done: facts[id] }));
}

/**
 * The step the page should open, which is the first one not done yet.
 *
 * @param steps - Output of {@link checklistSteps}.
 * @returns The first unfinished step's id, or `null` when every step is done.
 */
export function currentStep(steps: ChecklistStep[]): StepId | null {
  return steps.find((s) => !s.done)?.id ?? null;
}

/** The languages the first-request snippet is offered in. */
export type SnippetLang = 'curl' | 'python' | 'node';

/** Values substituted into the first-request snippet. */
export interface SnippetValues {
  /** Absolute API base, ending in `/api/v1`. */
  baseUrl: string;
  /** The plaintext key, when the user just created one on this page; otherwise `null`. */
  apiKey: string | null;
  /** A model public name from the team, or `null` when it has none yet. */
  model: string | null;
}

/** Placeholder shown when the real key is not known (it is only ever shown once). */
export const KEY_PLACEHOLDER = '<your API key>';
/** Placeholder shown when the team has no model yet. */
export const MODEL_PLACEHOLDER = '<your model name>';

/**
 * Builds a copy-paste first request through the gateway.
 *
 * The real key can only be filled in right after it is created, because the API
 * stores a hash and never returns the plaintext again. Every other time the
 * snippet carries a placeholder the user must replace.
 *
 * @param lang - Which language to render.
 * @param values - Base URL, key and model to substitute.
 * @returns A runnable snippet as one string.
 */
export function buildSnippet(lang: SnippetLang, values: SnippetValues): string {
  const key = values.apiKey ?? KEY_PLACEHOLDER;
  const model = values.model ?? MODEL_PLACEHOLDER;
  const base = values.baseUrl.replace(/\/+$/, '');

  if (lang === 'curl') {
    return [
      `curl -X POST "${base}/gateway/chat/completions" \\`,
      `  -H "Authorization: Bearer ${key}" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '{`,
      `    "model": "${model}",`,
      `    "messages": [{ "role": "user", "content": "Say hello in five words." }]`,
      `  }'`,
    ].join('\n');
  }

  if (lang === 'python') {
    return [
      '# pip install acruxcore',
      'import asyncio',
      'from acruxcore import AcruxCore',
      '',
      'async def main():',
      `    async with AcruxCore(api_key="${key}", base_url="${base}") as hub:`,
      '        reply = await hub.gateway.chat(',
      `            "${model}",`,
      '            [{"role": "user", "content": "Say hello in five words."}],',
      '        )',
      '        print(reply.content)',
      '',
      'asyncio.run(main())',
    ].join('\n');
  }

  return [
    '// npm install @acruxcoreai/sdk',
    "import AcruxCore from '@acruxcoreai/sdk';",
    '',
    `const hub = new AcruxCore({ apiKey: '${key}', baseUrl: '${base}' });`,
    '',
    'const { content } = await hub.gateway.chat({',
    `  model: '${model}',`,
    "  messages: [{ role: 'user', content: 'Say hello in five words.' }],",
    '});',
    'console.log(content);',
  ].join('\n');
}

/** The providers the direct-call snippet is offered for. */
export type DirectProvider = 'openai' | 'anthropic' | 'gemini' | 'openrouter';

/** What each direct provider needs in the SDK's `provider` setting. */
export const DIRECT_PROVIDERS: Record<DirectProvider, {
  label: string;
  /** `kind`, when the provider needs one. */
  kind?: 'anthropic' | 'gemini';
  /** `base_url`, when the provider needs one. Anthropic and Gemini default to their own hosts. */
  baseUrl?: string;
  envVar: string;
  model: string;
}> = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', envVar: 'OPENAI_API_KEY', model: 'gpt-4o-mini' },
  anthropic: { label: 'Anthropic', kind: 'anthropic', envVar: 'ANTHROPIC_API_KEY', model: 'claude-haiku-4-5' },
  gemini: { label: 'Gemini', kind: 'gemini', envVar: 'GEMINI_API_KEY', model: 'gemini-3.5-flash' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', envVar: 'OPENROUTER_API_KEY', model: 'openai/gpt-4o-mini' },
};

/**
 * Builds a copy-paste direct (BYO) call: the SDK calls the provider with the team's
 * own key, which never reaches AcruxCore, and reports the trace in the background.
 *
 * @param lang - `python` or `node`; there is no curl version, since the trace is
 *   written by the SDK.
 * @param provider - Which provider's settings to show.
 * @param values - Base URL and AcruxCore key; `model` is ignored, since no AcruxCore
 *   model is involved.
 * @returns A runnable snippet as one string.
 */
export function buildDirectSnippet(lang: 'python' | 'node', provider: DirectProvider, values: SnippetValues): string {
  const key = values.apiKey ?? KEY_PLACEHOLDER;
  const base = values.baseUrl.replace(/\/+$/, '');
  const p = DIRECT_PROVIDERS[provider];

  if (lang === 'python') {
    const fields = [
      ...(p.kind ? [`"kind": "${p.kind}"`] : []),
      ...(p.baseUrl ? [`"base_url": "${p.baseUrl}"`] : []),
      `"api_key": os.environ["${p.envVar}"]`,
    ];
    return [
      '# pip install acruxcore',
      'import asyncio, os',
      'from acruxcore import AcruxCore',
      '',
      '# Your provider key goes to the provider only. AcruxCore receives the trace.',
      `provider = {${fields.join(', ')}}`,
      '',
      'async def main():',
      `    async with AcruxCore(api_key="${key}", base_url="${base}", provider=provider) as hub:`,
      '        reply = await hub.gateway.chat(',
      `            "${p.model}",`,
      '            [{"role": "user", "content": "Say hello in five words."}],',
      '        )',
      '        print(reply.content)',
      '',
      'asyncio.run(main())',
    ].join('\n');
  }

  const fields = [
    ...(p.kind ? [`kind: '${p.kind}'`] : []),
    ...(p.baseUrl ? [`baseUrl: '${p.baseUrl}'`] : []),
    `apiKey: process.env.${p.envVar}`,
  ];
  return [
    '// npm install @acruxcoreai/sdk',
    "import AcruxCore from '@acruxcoreai/sdk';",
    '',
    '// Your provider key goes to the provider only. AcruxCore receives the trace.',
    'const hub = new AcruxCore({',
    `  apiKey: '${key}',`,
    `  baseUrl: '${base}',`,
    `  provider: { ${fields.join(', ')} },`,
    '});',
    '',
    'const { content } = await hub.gateway.chat({',
    `  model: '${p.model}',`,
    "  messages: [{ role: 'user', content: 'Say hello in five words.' }],",
    '});',
    'console.log(content);',
  ].join('\n');
}

/** The question the tool snippet asks; it needs two tool calls in one turn. */
const TOOL_QUESTION = 'What is the weather in Paris and in Rome?';

/**
 * Builds the optional tool step's snippet: one tool defined with the SDK's decorator
 * (`@acrux.tool` in Python, `acrux.tool()` with zod in Node) and a tool loop that runs it.
 *
 * The loop also saves the tool to the team's catalog, which is what ticks the step.
 * On the gateway path the loop calls the team's model by its public name. On the direct
 * path it calls the provider with the team's own key, as the first-call snippet does.
 *
 * @param lang - `python` or `node`. There is no curl version: the decorator is an SDK feature.
 * @param path - Which setup path the snippet is for.
 * @param provider - The direct provider; ignored on the gateway path.
 * @param values - Base URL, AcruxCore key and, on the gateway path, the team's model.
 * @returns A runnable script as one string.
 */
export function buildToolSnippet(
  lang: 'python' | 'node',
  path: SetupPath,
  provider: DirectProvider,
  values: SnippetValues,
): string {
  const key = values.apiKey ?? KEY_PLACEHOLDER;
  const base = values.baseUrl.replace(/\/+$/, '');
  const direct = path === 'direct';
  const p = DIRECT_PROVIDERS[provider];
  const model = direct ? p.model : (values.model ?? MODEL_PLACEHOLDER);

  if (lang === 'python') {
    const fields = [
      ...(p.kind ? [`"kind": "${p.kind}"`] : []),
      ...(p.baseUrl ? [`"base_url": "${p.baseUrl}"`] : []),
      `"api_key": os.environ["${p.envVar}"]`,
    ];
    return [
      '# pip install acruxcore',
      direct ? 'import asyncio, os' : 'import asyncio',
      'from acruxcore import AcruxCore, acrux',
      '',
      'TEMPERATURES = {"Paris": 18, "Rome": 24}',
      '',
      '@acrux.tool',
      'async def get_weather(city: str) -> dict:',
      '    """Current weather for one city.',
      '',
      '    Args:',
      "        city: City name, e.g. 'Paris'.",
      '    """',
      '    return {"city": city, "temp_c": TEMPERATURES.get(city, 20)}',
      '',
      ...(direct ? [`provider = {${fields.join(', ')}}`, ''] : []),
      'async def main():',
      `    async with AcruxCore(api_key="${key}", base_url="${base}"${direct ? ', provider=provider' : ''}) as hub:`,
      '        loop = await hub.gateway.run_tool_loop(',
      `            "${model}",`,
      `            [{"role": "user", "content": "${TOOL_QUESTION}"}],`,
      '            tools=[get_weather],',
      '        )',
      '        print(loop.content)',
      '',
      'asyncio.run(main())',
    ].join('\n');
  }

  const fields = [
    ...(p.kind ? [`kind: '${p.kind}'`] : []),
    ...(p.baseUrl ? [`baseUrl: '${p.baseUrl}'`] : []),
    `apiKey: process.env.${p.envVar}`,
  ];
  return [
    '// npm install @acruxcoreai/sdk zod',
    "import AcruxCore, { acrux } from '@acruxcoreai/sdk';",
    "import { z } from 'zod/v4';",
    '',
    'const TEMPERATURES = { Paris: 18, Rome: 24 };',
    '',
    'const getWeather = acrux.tool(',
    '  {',
    "    name: 'get_weather',",
    "    description: 'Current weather for one city.',",
    "    parameters: z.object({ city: z.string().describe(\"City name, e.g. 'Paris'.\") }),",
    '  },',
    '  ({ city }) => ({ city, temp_c: TEMPERATURES[city] ?? 20 }),',
    ');',
    '',
    'const hub = new AcruxCore({',
    `  apiKey: '${key}',`,
    `  baseUrl: '${base}',`,
    ...(direct ? [`  provider: { ${fields.join(', ')} },`] : []),
    '});',
    '',
    'const loop = await hub.gateway.runToolLoop({',
    `  model: '${model}',`,
    `  messages: [{ role: 'user', content: '${TOOL_QUESTION}' }],`,
    '  tools: [getWeather],',
    '});',
    'console.log(loop.content);',
  ].join('\n');
}
