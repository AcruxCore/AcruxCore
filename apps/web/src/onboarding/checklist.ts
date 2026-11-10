/** The steps a new team takes before its first traced gateway call, in order. */
export type StepId = 'credential' | 'model' | 'apiKey' | 'firstRequest';

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

const ORDER: StepId[] = ['credential', 'model', 'apiKey', 'firstRequest'];

/** Each step's title, shared by the checklist page and the next-step banner. */
export const STEP_TITLES: Record<StepId, string> = {
  credential: 'Connect a model provider',
  model: 'Add a model',
  apiKey: 'Create an API key',
  firstRequest: 'Send your first request',
};

/**
 * The 1-based position of a step, for "Step 2 of 4" labels.
 *
 * @param id - The step.
 * @returns Its number in display order.
 */
export function stepNumber(id: StepId): number {
  return ORDER.indexOf(id) + 1;
}

/**
 * Marks each onboarding step done or not from the team's real data.
 *
 * Each step is judged on its own fact, never on the steps before it: a team
 * that already sent traces through the SDK, with no gateway setup at all,
 * still sees "first request" ticked.
 *
 * @param facts - The team's status from the API.
 * @returns The four steps in display order.
 */
export function checklistSteps(facts: ChecklistFacts): ChecklistStep[] {
  return ORDER.map((id) => ({ id, done: facts[id] }));
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
