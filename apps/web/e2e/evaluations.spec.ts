import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { createPrompt, setFirstMessage, signup } from './helpers';

/**
 * Capstone E2E for the whole Phase 5 evaluation feature (E2 dataset builder →
 * E3 run orchestration → E4 judge → E6 optimize/promote → E7 this UI): sign in,
 * turn real feedback into a dataset, run "Improve from feedback" against a
 * real BullMQ worker + a real OpenAI model, wait for the leaderboard to
 * populate, drill into a candidate cell, and promote it to a real prompt
 * version.
 *
 * Requires `OPENAI_TEST_KEY` in the environment the Playwright process runs
 * in (same convention as `apps/api`'s own live gateway tests) — a real
 * connection + registered model are needed because the optimizer, the judge,
 * and the cell executions all make real gateway calls. Also requires a real
 * `apps/worker` process (BullMQ workers for cells/judge/optimize/finalize)
 * running against the same Redis the API points at — this test only starts
 * the browser + drives the API; it does not boot a worker in-process (that
 * in-process trick only works for a Jest suite in the same Node process,
 * not a Playwright run driving a browser against a separately-running API).
 * Skips itself when the key is absent.
 */
const OPENAI_KEY = process.env.OPENAI_TEST_KEY;
const OPENAI_MODEL = process.env.OPENAI_TEST_MODEL ?? 'gpt-4o-mini';

/** Ingests one trace with a single `llm` span carrying captured variables — the seed the dataset builder turns into an example. */
async function ingestTraceWithVariables(
  request: APIRequestContext,
  opts: { model: string; promptVersionId: string; variables: Record<string, unknown>; input: string; output: string },
): Promise<string> {
  const now = Date.now();
  const res = await request.post('/api/v1/traces', {
    data: {
      traces: [
        {
          name: 'refund-bot-run',
          capturePayloads: true,
          spans: [
            {
              spanId: 's1',
              name: opts.model,
              kind: 'llm',
              status: 'ok',
              startTime: new Date(now).toISOString(),
              endTime: new Date(now + 500).toISOString(),
              model: opts.model,
              provider: 'openai',
              usage: { promptTokens: 40, completionTokens: 5, totalTokens: 45 },
              costUsd: 0.00001,
              promptVersionId: opts.promptVersionId,
              input: { messages: [{ role: 'user', content: opts.input }] },
              output: { content: opts.output },
              variables: opts.variables,
            },
          ],
        },
      ],
    },
  });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { traceIds: string[] }).traceIds[0];
}

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

/** Polls `GET /runs/:id` until the run leaves `queued`/`running`, then returns its final status (+ error, if any). */
async function waitForRunToSettle(
  page: Page,
  runId: string,
  timeoutMs = 120_000,
): Promise<{ status: string; error: string | null }> {
  let last: { status: string; error: string | null } = { status: 'queued', error: null };
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/v1/runs/${runId}`);
        const body = (await res.json()) as { status: string; error: string | null };
        last = body;
        return body.status;
      },
      { timeout: timeoutMs, intervals: [1500] },
    )
    .toMatch(/succeeded|failed/);
  return last;
}

test.skip(!OPENAI_KEY, 'Requires OPENAI_TEST_KEY (a real OpenAI key) to exercise the real cell/judge/optimize gateway calls.');

test('DoD: feedback → dataset → improve from feedback → leaderboard → drill-down → promote', async ({ page }) => {
  test.setTimeout(180_000);

  await signup(page);
  const modelName = await registerRealOpenAiModel(page.request);

  // A prompt with a deliberately weak, terse production version — a real,
  // improvable aspect for the optimizer to fix.
  const promptName = `refund-bot-${Date.now()}`;
  await createPrompt(page, promptName);
  await setFirstMessage(page, "You are a support bot. Answer the customer's question about {{ topic }} in the fewest words possible.");
  await page.getByRole('button', { name: 'Commit new version' }).first().click();
  await expect(page.getByText('Committed v1')).toBeVisible();
  const promptId = page.url().split('/prompts/')[1].split('?')[0];
  const versionsRes = await page.request.get(`/api/v1/prompts/${promptId}/versions`);
  const versionId = ((await versionsRes.json()) as { data: { id: string }[] }).data[0].id;

  // A real trace (captured variables + a linked prompt version) and real
  // feedback describing the weakness — this is what the dataset builder turns
  // into a dataset example + judge criteria.
  const traceId = await ingestTraceWithVariables(page.request, {
    model: modelName,
    promptVersionId: versionId,
    variables: { topic: 'a delayed refund' },
    input: 'What is the refund policy for a delayed refund?',
    output: 'Contact support.',
  });
  const feedbackRes = await page.request.post(`/api/v1/traces/${traceId}/feedback`, {
    data: {
      rating: -1,
      comment: 'Too terse — must explain the refund policy in at least two sentences, including the expected timeframe.',
      source: 'user',
    },
  });
  expect(feedbackRes.ok()).toBeTruthy();

  // ── Feedback list: select the row, "Create dataset" (the plain dataset-builder flow) ──
  await page.goto('/observability/feedback');
  await expect(page.getByTestId('feedback-feed-item')).toHaveCount(1);
  await page.getByTestId('feedback-feed-item').getByRole('checkbox').check();
  await expect(page.getByTestId('feedback-selection-bar')).toBeVisible();

  await page.getByTestId('feedback-selection-bar').getByRole('button', { name: 'Create dataset' }).click();
  const createDialog = page.getByRole('dialog');
  await createDialog.getByLabel('Name').fill(`regression-${Date.now()}`);
  await createDialog.getByRole('button', { name: 'Create dataset', exact: true }).click();
  await expect(createDialog.getByTestId('create-dataset-result')).toBeVisible();
  await createDialog.getByRole('button', { name: 'Done' }).click();

  // ── Re-select the same row, "Improve from feedback" (dataset + optimize run in one step) ──
  await page.getByTestId('feedback-feed-item').getByRole('checkbox').check();
  await page.getByTestId('feedback-selection-bar').getByRole('button', { name: 'Improve from feedback' }).click();
  const improveDialog = page.getByRole('dialog');
  await improveDialog.getByLabel('Dataset name').fill(`improve-${Date.now()}`);
  await improveDialog.getByRole('combobox', { name: 'Prompt to improve' }).selectOption({ label: promptName });
  await improveDialog.getByTestId('improve-model-checkboxes').getByLabel(modelName).check();

  const startedNavigation = page.waitForURL(/\/evaluations\/runs\/[0-9a-f-]+/);
  await improveDialog.getByRole('button', { name: 'Improve' }).click();
  await startedNavigation;
  const runId = page.url().split('/evaluations/runs/')[1].split('?')[0];

  // ── Wait for the REAL worker (cells + judge + optimize, all real gateway calls) to settle the run ──
  const settled = await waitForRunToSettle(page, runId);
  expect(settled.status, `run ${runId} did not succeed: ${settled.error}`).toBe('succeeded');

  // ── Leaderboard/report populated; drill into a candidate cell ──
  await page.reload();
  await expect(page.getByTestId('leaderboard-list')).toBeVisible();
  const candidateRow = page.locator('tbody tr').filter({ hasText: 'candidate-A' });
  await expect(candidateRow).toBeVisible();
  await candidateRow.getByTestId('matrix-cell').first().click();

  const drawer = page.getByTestId('drawer-content');
  await expect(drawer.getByTestId('drilldown-example')).toHaveCount(1);

  // ── As the (owner) authorized user: promote the candidate ──
  // `Drawer` and `Dialog` are both built on the same Radix dialog primitive,
  // so with the drill-down drawer still open behind it, `page.getByRole('dialog')`
  // alone would match both. The drawer's title is "<variant> · <model>" and
  // never contains "Promote", so filtering by accessible name isolates the
  // PromoteDialog specifically (its title is always "Promote <candidate|label>").
  await drawer.getByRole('button', { name: 'Promote to production' }).click();
  const promoteDialog = page.getByRole('dialog', { name: /Promote/ });
  // Always rendered (unlike the optimizer's rationale block, which only shows
  // when the model actually returned one) — proves the promote-review evidence
  // panel loaded real judge data for this exact cell before confirming.
  await expect(promoteDialog.getByText('Judge evidence for this cell')).toBeVisible();
  await promoteDialog.getByRole('button', { name: 'Promote', exact: true }).click();
  await expect(page.getByText(/Promoted to v\d+/)).toBeVisible();

  // ── A new prompt version now exists and production points at it ──
  // The Versions tab (asserted via UI) plus a direct API read of the alias
  // (VersionsTab has no per-row testid to scope a "which row says
  // 'production'" DOM query robustly) together confirm both halves of the
  // promote: a real v2 was committed, and `production` now points at it.
  await page.goto(`/prompts/${promptId}`);
  await page.getByRole('tab', { name: 'Versions' }).click();
  await expect(page.getByText('v2', { exact: true })).toBeVisible();
  await expect(page.getByText('v1', { exact: true })).toBeVisible();

  const aliasesRes = await page.request.get(`/api/v1/prompts/${promptId}/aliases`);
  const aliases = (await aliasesRes.json()) as Array<{ alias: string; versionNumber: number }>;
  expect(aliases.find((a) => a.alias === 'production')?.versionNumber).toBe(2);

  const finalVersionsRes = await page.request.get(`/api/v1/prompts/${promptId}/versions`);
  const finalVersions = (await finalVersionsRes.json()) as { data: unknown[] };
  expect(finalVersions.data).toHaveLength(2);
});
