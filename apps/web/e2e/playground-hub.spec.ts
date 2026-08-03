import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { signup } from './helpers';

/**
 * Capstone E2E for the Playground experimentation hub (F1 editable
 * stored-prompt mode, F2 Save menu, B1 server-side ad-hoc rendering): sign
 * up, register a real OpenAI model, seed a "greeting" prompt with a system +
 * `{{ name }}` user message, load it into the Playground's Stored-prompt
 * tab, add a new turn, run it through the real gateway, and save the edited
 * messages back as a new version — verifying the whole
 * compose -> run -> save-back loop against real servers (no mocks).
 *
 * Requires `OPENAI_TEST_KEY` in the environment the Playwright process runs
 * in (same convention as apps/api's own live gateway tests and
 * evaluations.spec.ts) — skips itself when the key is absent.
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
 * Seeds a prompt with a system + `{{ name }}` user message as its v1 (which
 * also auto-creates the `production` alias the Playground's Stored-prompt
 * tab hydrates from). Returns the prompt's id for later verification.
 */
async function seedGreetingPrompt(
  request: APIRequestContext,
  name: string,
): Promise<{ promptId: string }> {
  const createRes = await request.post('/api/v1/prompts', { data: { name } });
  expect(createRes.ok()).toBeTruthy();
  const { id: promptId } = (await createRes.json()) as { id: string };

  const versionRes = await request.post(`/api/v1/prompts/${promptId}/versions`, {
    data: {
      messages: [
        { role: 'system', content: 'You are a warm, concise greeter.' },
        { role: 'user', content: 'Greet {{ name }} in one short sentence.' },
      ],
    },
  });
  expect(versionRes.ok()).toBeTruthy();
  return { promptId };
}

test.skip(
  !OPENAI_KEY,
  'Requires OPENAI_TEST_KEY (a real OpenAI key) to exercise a real gateway completion.',
);

test('compose in playground, add a turn, save as a new version', async ({ page }) => {
  test.setTimeout(90_000);

  await signup(page);
  const modelName = await registerRealOpenAiModel(page.request);

  const promptName = `greeting-${Date.now()}`;
  const { promptId } = await seedGreetingPrompt(page.request, promptName);

  // ── Open the Playground, switch to Stored prompt, select "greeting" ──
  await page.goto('/gateway/playground');
  await page.getByRole('button', { name: 'Stored prompt' }).click();

  const promptSelect = page.getByLabel('Prompt name');
  // Wait for the seeded prompt to appear in the (async-loaded) options list
  // before selecting it, so we don't race the initial usePrompts() fetch.
  await expect(promptSelect.locator('option', { hasText: promptName })).toHaveCount(1);
  await promptSelect.selectOption({ label: promptName });

  // ── The two stored messages load into the editable template list ──
  const templateTextareas = page.getByPlaceholder('Message content…');
  await expect(templateTextareas).toHaveCount(2);
  await expect(templateTextareas.nth(0)).toHaveValue('You are a warm, concise greeter.');
  await expect(templateTextareas.nth(0)).toBeEditable();
  await expect(templateTextareas.nth(1)).toHaveValue('Greet {{ name }} in one short sentence.');
  await expect(templateTextareas.nth(1)).toBeEditable();

  // ── Add a turn, set variables, pick the model, and run ──
  await page.getByRole('button', { name: '+ Add message' }).click();
  await expect(templateTextareas).toHaveCount(3);
  await templateTextareas.nth(2).fill('Also greet {{ name }} in French.');

  await page.getByLabel('Variables (JSON)').fill('{\n  "name": "Alice"\n}');
  await page.getByLabel('Model').selectOption({ label: modelName });

  await page.getByRole('button', { name: 'Send completion' }).click();
  // Tolerant of real-provider latency/flakiness: just require a non-empty
  // response to have rendered (the config's retries:1 covers transient
  // provider errors on the whole test).
  await expect(page.locator('pre')).toHaveText(/\S/, { timeout: 30_000 });

  // ── Save the edited messages back as a new version of "greeting" ──
  await page.getByRole('button', { name: 'Save ▾' }).click();
  await page.getByRole('menuitem', { name: `New version of ${promptName}` }).click();
  await expect(page.getByText(`→ ${promptName} v2`)).toBeVisible();

  // ── Verify a real v2 was committed, including the added French turn ──
  const versionsRes = await page.request.get(`/api/v1/prompts/${promptId}/versions`);
  const versions = (await versionsRes.json()) as {
    data: { versionNumber: number }[];
    total: number;
  };
  expect(versions.total).toBe(2);
  expect(versions.data.some((v) => v.versionNumber === 2)).toBe(true);

  const v2Res = await page.request.get(`/api/v1/prompts/${promptId}/versions/2`);
  const v2 = (await v2Res.json()) as { messages: { role: string; content: string }[] };
  expect(v2.messages).toHaveLength(3);
  expect(v2.messages.some((m) => m.content === 'Also greet {{ name }} in French.')).toBe(true);
});
