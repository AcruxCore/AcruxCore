import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { signup, createPrompt, setFirstMessage } from './helpers';

/** Ingests a trace with an llm span (linked to a prompt version) + a tool child. */
async function ingestTrace(
  request: APIRequestContext,
  opts: { model: string; promptVersionId?: string; sessionId?: string; capture?: boolean },
): Promise<string> {
  const now = Date.now();
  const res = await request.post('/api/v1/traces', {
    data: {
      traces: [
        {
          sessionId: opts.sessionId,
          name: 'support-agent-run',
          capturePayloads: opts.capture ?? false,
          spans: [
            {
              spanId: 's1',
              name: opts.model,
              kind: 'llm',
              status: 'ok',
              startTime: new Date(now).toISOString(),
              endTime: new Date(now + 900).toISOString(),
              model: opts.model,
              provider: 'openai',
              usage: { promptTokens: 120, completionTokens: 40, totalTokens: 160 },
              costUsd: 0.0000234,
              promptVersionId: opts.promptVersionId,
              input: { messages: [{ role: 'user', content: 'refunds?' }] },
              output: { content: 'See policy.' },
            },
            {
              spanId: 's2',
              parentSpanId: 's1',
              name: 'search_docs',
              kind: 'tool',
              status: 'ok',
              startTime: new Date(now + 100).toISOString(),
              endTime: new Date(now + 400).toISOString(),
            },
          ],
        },
      ],
    },
  });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { traceIds: string[] }).traceIds[0];
}

test('DoD: filter → open trace → span tree + linked version → dashboards → feedback', async ({ page }) => {
  await signup(page);
  // Create a prompt + version so the ingested span links to a real prompt_version_id.
  await createPrompt(page, `traced-${Date.now()}`);
  await setFirstMessage(page, 'Hello {{ name }}');
  await page.getByRole('button', { name: 'Commit new version' }).first().click();
  await expect(page.getByText('Committed v1')).toBeVisible();
  // Read the version id from the API (same session cookie). Strip any `?tab=` the
  // Editor tab adds to the URL. GET /prompts/:id/versions returns a Paginated envelope
  // (verified against apps/web/src/api/versions.ts -> api<Paginated<VersionListItem>>).
  const promptId = page.url().split('/prompts/')[1].split('?')[0];
  const versions = await (await page.request.get(`/api/v1/prompts/${promptId}/versions`)).json();
  const versionId = versions.data[0].id as string;

  await ingestTrace(page.request, { model: 'gpt-4o-mini', promptVersionId: versionId, sessionId: 'chat-42' });

  // Filter the list by model, open the trace.
  await page.goto('/traces');
  await page.getByTestId('trace-filter-model').fill('gpt-4o-mini');
  await page.getByTestId('trace-filter-model').blur();
  await page.getByTestId('trace-row-link').first().click();
  await expect(page).toHaveURL(/\/traces\/[0-9a-f-]+/);

  // Span tree renders the llm span + the tool child; open the llm span, see the linked version.
  await expect(page.getByTestId('span-row')).toHaveCount(2);
  await expect(page.getByText('gpt-4o-mini')).toBeVisible();
  await page.getByTestId('span-row').first().click();
  await expect(page.getByTestId('span-prompt-version')).toBeVisible();

  // Dashboards render with data. All traffic from this test lands in a single
  // day bucket, so this also guards against a line chart with one point
  // rendering an invisible bare SVG moveto (no visible marker/line).
  await page.goto('/observability');
  await expect(page.getByTestId('analytics-charts')).toBeVisible();
  await expect(page.getByTestId('line-chart-point').first()).toBeVisible();

  // Post feedback, see it appear.
  await page.goBack();
  await page.getByTestId('feedback-down').click();
  await page.getByTestId('feedback-comment').fill('Cited the wrong policy.');
  await page.getByTestId('feedback-submit').click();
  await expect(page.getByText('Feedback added')).toBeVisible();
  await expect(page.getByText('Cited the wrong policy.')).toBeVisible();
});

test('sessions list → detail shows the session traces', async ({ page }) => {
  await signup(page);
  await ingestTrace(page.request, { model: 'gpt-4o-mini', sessionId: 'sess-1' });
  await ingestTrace(page.request, { model: 'gpt-4o-mini', sessionId: 'sess-1' });
  await page.goto('/sessions');
  await page.getByTestId('session-row-link').first().click();
  await expect(page.getByTestId('trace-row-link')).toHaveCount(2);
});

test('enabling payload capture makes a new trace show its payload', async ({ page }) => {
  await signup(page); // signup creator is owner -> toggle enabled
  await page.goto('/observability/settings');
  await expect(page.getByTestId('capture-toggle')).toBeEnabled();
  await page.getByTestId('capture-toggle').click();
  await expect(page.getByText('Settings updated')).toBeVisible();

  await ingestTrace(page.request, { model: 'gpt-4o-mini', capture: true });
  await page.goto('/traces');
  await page.getByTestId('trace-row-link').first().click();
  await page.getByTestId('span-row').first().click();
  await expect(page.getByText('Input')).toBeVisible(); // MonoBlock payload label
});

// A viewer session against the owner's team is reproduced via the team switcher
// (see apps/web/src/app/TeamSwitcher.tsx, testids `team-switcher` / `team-switcher-option`).
test('viewer sees the capture toggle disabled', async ({ page }) => {
  // Owner O signs up and creates a viewer invite (InvitesPanel defaults to role 'viewer').
  await signup(page);
  await page.goto('/team');
  const invites = page.locator('section').filter({ hasText: 'Invites' });
  await invites.getByRole('button', { name: 'New invite' }).click();
  await page.getByRole('button', { name: 'Create link' }).click();
  await expect(page.getByRole('button', { name: 'Copy link' })).toBeVisible();

  // Read O's team + the invite token from the real API (same session cookies).
  const ownerMe = await (await page.request.get('/api/v1/auth/me')).json();
  const ownerTeamId = ownerMe.team.id as string;
  const ownerTeamName = ownerMe.team.name as string;
  const inviteList = await (await page.request.get(`/api/v1/teams/${ownerTeamId}/invites`)).json();
  const token = inviteList[0].token as string;

  // Sign out O, sign up a second account V (the invitee).
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await signup(page);
  const vMe = await (await page.request.get('/api/v1/auth/me')).json();
  const vTeamName = vMe.team.name as string;

  // V accepts the invite. Since PR #34 (fix(teams): switch active team on invite
  // accept) the accept endpoint switches V's session onto O's team immediately —
  // do NOT click O's team in the switcher here: it is already the active team, so
  // the switcher short-circuits without firing /auth/switch-team and a
  // waitForResponse on it would hang forever.
  await page.goto(`/invite/${token}`);
  await expect(page).toHaveURL(/\/team/);

  // `keys.myTeams` uses the global 15s staleTime and invite-acceptance does not
  // invalidate it, so the switcher's option list can still be stale here. Force a
  // full navigation (not client-side routing) to get a fresh fetch of the team list.
  await page.goto('/prompts');

  // Right after the reload the switcher may still be the non-interactive
  // single-team label (myTeams hasn't resolved yet) -- wait for the interactive,
  // dropdown-capable button, and confirm accept landed V on O's team.
  const switcher = page.getByTestId('team-switcher');
  await expect(switcher).toHaveAttribute('aria-haspopup', 'menu');
  await expect(switcher).toContainText(ownerTeamName);

  /** Switches the active team via the top-bar switcher and waits for the real request. */
  async function switchTo(teamName: string): Promise<void> {
    await switcher.click();
    const option = page.getByTestId('team-switcher-option').filter({ hasText: teamName });
    await expect(option).toBeVisible();
    // Wait for the switch-team request to actually complete before navigating away --
    // navigating too early can abort the in-flight request and leave the old team active.
    const switched = page.waitForResponse((r) => r.url().includes('/auth/switch-team') && r.ok());
    await option.click();
    await switched;
    await expect(page).toHaveURL(/\/prompts/);
    await expect(switcher).toContainText(teamName);
  }

  // Round-trip the switcher. On V's own team V is the owner -> toggle enabled…
  await switchTo(vTeamName);
  await page.goto('/observability/settings');
  await expect(page.getByTestId('capture-toggle')).toBeEnabled();

  // …and back on O's team V is a viewer -> the capture toggle is disabled.
  await switchTo(ownerTeamName);
  await page.goto('/observability/settings');
  await expect(page.getByTestId('capture-toggle')).toBeDisabled();
});
