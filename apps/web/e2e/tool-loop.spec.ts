import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { signup } from './helpers';

/**
 * Capstone E2E for the Playground's tool-calling loop (TC5 Tasks 2-3): sign
 * up, register a real OpenAI model, create a `client`-executor tool in the
 * Tool Catalog (a `get_weather`-style tool with a required `city` argument),
 * attach it in the Playground, and drive a real completion that makes the
 * model request a tool call. Asserts a `ToolCallCard` renders the call's
 * name and parsed arguments, hand-types a manual result into its textarea
 * (the real client-tool UX — the human IS the executor), and asserts the
 * loop re-sends and lands on a final, non-empty assistant response.
 *
 * Requires `OPENAI_TEST_KEY` in the environment the Playwright process runs
 * in (same convention as `playground-hub.spec.ts`) — skips itself when the
 * key is absent.
 */
const OPENAI_KEY = process.env.OPENAI_TEST_KEY;
const OPENAI_MODEL = process.env.OPENAI_TEST_MODEL ?? 'gpt-4o-mini';

/** Registers a real OpenAI connection + model for the signed-in team, returning the model's `publicName`. */
async function registerRealOpenAiModel(request: APIRequestContext): Promise<string> {
  const connRes = await request.post('/api/v1/gateway/connections', {
    data: { provider: 'openai', label: 'openai e2e', apiKey: OPENAI_KEY, config: {} },
  });
  expect(connRes.ok()).toBeTruthy();
  const { id: credentialId } = (await connRes.json()) as { id: string };

  const modelRes = await request.post('/api/v1/gateway/models', {
    data: { publicName: OPENAI_MODEL, upstreamModel: OPENAI_MODEL, credentialId },
  });
  expect(modelRes.ok()).toBeTruthy();
  return OPENAI_MODEL;
}

/**
 * Creates a `get_weather`-style tool with a `client` executor and commits its
 * v1, which auto-promotes `production` (and `staging`) — confirmed against
 * `apps/api/src/tools/versions/versions.service.ts`'s `commitVersion` (auto-
 * creates aliases when `versionNumber === 1`) and the working request shape
 * in `apps/api/src/tools/versions/versions.test.ts`. Returns the tool's name,
 * which the Playground's chip row and the model's `tool_calls` both key on.
 */
async function createClientWeatherTool(request: APIRequestContext, name: string): Promise<string> {
  const createRes = await request.post('/api/v1/tools', {
    data: { name, description: 'Look up the current weather for a city.' },
  });
  expect(createRes.ok()).toBeTruthy();
  const { id: toolId } = (await createRes.json()) as { id: string };

  const versionRes = await request.post(`/api/v1/tools/${toolId}/versions`, {
    data: {
      parametersSchema: {
        type: 'object',
        properties: { city: { type: 'string', description: 'City name, e.g. "Paris"' } },
        required: ['city'],
      },
      executor: { type: 'client' },
    },
  });
  expect(versionRes.ok()).toBeTruthy();
  const versionBody = (await versionRes.json()) as { aliases?: { alias: string }[] };
  expect(versionBody.aliases?.map((a) => a.alias).sort()).toEqual(['production', 'staging']);

  return name;
}

test.skip(
  !OPENAI_KEY,
  'Requires OPENAI_TEST_KEY (a real OpenAI key) to exercise a real gateway completion.',
);

test('attach a client tool, resolve its call by hand, and reach a final answer', async ({ page }) => {
  test.setTimeout(90_000);

  await signup(page);
  const modelName = await registerRealOpenAiModel(page.request);
  const toolName = `get_weather_${Date.now()}`;
  await createClientWeatherTool(page.request, toolName);

  // ── Open the Playground, pick the model, write a tool-forcing prompt ──
  await page.goto('/gateway/playground');
  await page.getByLabel('Model').selectOption({ label: modelName });

  // Default Messages-mode state is a single user message — fold the
  // tool-forcing instruction and the question into it, avoiding the
  // per-message role <Select> (no accessible label to target by).
  const messageTextareas = page.getByPlaceholder('Message content…');
  await messageTextareas.first().fill(
    'You must call the get_weather tool (with a "city" argument) to answer this — never answer from ' +
      'your own knowledge. What is the weather like in Paris right now?',
  );

  // ── Attach the tool via its chip ──
  await page.getByRole('button', { name: toolName, exact: true }).click();
  await expect(page.getByText('The model may call these tools before answering')).toBeVisible();

  // ── Send — the model should request a tool call ──
  await page.getByRole('button', { name: 'Send completion' }).click();

  // ── A ToolCallCard renders with the call's name and parsed arguments ──
  // Scoped to the <section> holding the in-flight tool calls (rendered only
  // once `activeCalls` is non-empty) so it can't collide with the chip row,
  // which also renders the tool's bare name as text.
  const toolCallSection = page.locator('section').filter({ hasText: 'needs input' });
  await expect(toolCallSection).toBeVisible({ timeout: 30_000 });
  await expect(toolCallSection.getByText(toolName, { exact: true })).toBeVisible();
  await expect(toolCallSection.getByTestId('mono-block')).toContainText('Paris');

  // ── Hand-type the manual result (the real client-tool UX) and submit ──
  const resultTextarea = toolCallSection.getByPlaceholder("Paste this tool's result…");
  await resultTextarea.fill(JSON.stringify({ city: 'Paris', tempC: 21, conditions: 'Partly cloudy' }));
  await toolCallSection.getByRole('button', { name: 'Use this result' }).click();

  // ── The loop re-sends and lands on a final, non-empty assistant response ──
  const responseSection = page.locator('section').filter({ hasText: 'Response' });
  await expect(responseSection.locator('pre')).toHaveText(/\S/, { timeout: 30_000 });
  await expect(page.getByText('needs input')).toHaveCount(0);
});
