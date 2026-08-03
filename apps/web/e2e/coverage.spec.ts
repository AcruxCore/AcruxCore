import { expect, test } from '@playwright/test';
import { createPrompt, setFirstMessage, signup, uniqueEmail } from './helpers';

/** Commit the current draft as a new version and wait for the success toast. */
async function commit(page: import('@playwright/test').Page, versionLabel: string) {
  await page.getByRole('tab', { name: 'Editor' }).click();
  await page.getByRole('button', { name: 'Commit new version' }).first().click();
  await expect(page.getByText(versionLabel)).toBeVisible();
}

test('auth: login with existing account and logout', async ({ page }) => {
  const email = uniqueEmail();
  await page.goto('/signup');
  await page.getByLabel('Full name').fill('Test User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('password123');
  // The "I agree to..." text wraps onto a second line in the narrow signup
  // card, so clicking its bounding-box center can land on the nested "Terms
  // of Service" link instead of plain text and never toggle the checkbox.
  // Target the checkbox input directly via its accessible role instead.
  await page.getByRole('checkbox', { name: 'I agree to the' }).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/prompts/);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/prompts/);
});

test('prompts: search filters the list', async ({ page }) => {
  await signup(page);
  const alpha = `alpha-${Date.now()}`;
  const beta = `beta-${Date.now()}`;
  await createPrompt(page, alpha);
  await page.goto('/prompts');
  await createPrompt(page, beta);
  await page.goto('/prompts');

  await page.getByPlaceholder('Search prompts…').fill('alpha-');
  await expect(page.getByText(alpha)).toBeVisible();
  await expect(page.getByText(beta)).toHaveCount(0);
});

test('prompts: rename, edit description, then delete', async ({ page }) => {
  await signup(page);
  const name = `ren-${Date.now()}`;
  await createPrompt(page, name);

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Name').fill(`${name}-renamed`);
  await page.getByLabel('Description').fill('updated description');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('heading', { name: `${name}-renamed` })).toBeVisible();
  await expect(page.getByText('updated description')).toBeVisible();

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Delete prompt' }).click();
  await expect(page).toHaveURL(/\/prompts$/);
  await expect(page.getByText(`${name}-renamed`)).toHaveCount(0);
});

test('editor: add a message, change its role, commit a two-message version', async ({ page }) => {
  await signup(page);
  await createPrompt(page, `multi-${Date.now()}`);

  await page.getByTestId('template-input').first().fill('System rules about {{ topic }}');
  await page.getByRole('button', { name: '+ Add message' }).click();
  const inputs = page.getByTestId('template-input');
  await expect(inputs).toHaveCount(2);
  await inputs.nth(1).fill('The user asks about {{ topic }}');
  await page.getByRole('combobox').nth(1).selectOption('assistant');

  await page.getByRole('button', { name: 'Commit new version' }).first().click();
  await expect(page.getByText('Committed v1')).toBeVisible();

  await page.getByRole('tab', { name: 'Versions' }).click();
  await expect(page.getByText('v1', { exact: true })).toBeVisible();
  await expect(page.getByText('1 var')).toBeVisible();
});

test('aliases: promote to staging, promote production, then roll back', async ({ page }) => {
  await signup(page);
  await createPrompt(page, `roll-${Date.now()}`);

  await setFirstMessage(page, 'version one');
  await commit(page, 'Committed v1');
  await setFirstMessage(page, 'version two');
  await commit(page, 'Committed v2');

  await page.getByRole('tab', { name: 'Versions' }).click();

  // staging → v2 (immediate, no confirm)
  await page.getByRole('button', { name: '→ staging' }).first().click();
  await expect(page.getByText(/Pointed staging → v2/)).toBeVisible();

  // production → v2 (confirm)
  await page.getByRole('button', { name: '→ production' }).first().click();
  await page.getByRole('button', { name: 'Promote to production' }).click();
  await expect(page.getByText(/Pointed production → v2/)).toBeVisible();

  // roll production back to v1 (only v1 now offers → production)
  await page.getByRole('button', { name: '→ production' }).first().click();
  await page.getByRole('button', { name: 'Promote to production' }).click();
  await expect(page.getByText(/Pointed production → v1/)).toBeVisible();
});

test('audit: lists prompt-created, version-committed and alias-promoted events', async ({ page }) => {
  await signup(page);
  await createPrompt(page, `aud-${Date.now()}`);
  await setFirstMessage(page, 'first');
  await commit(page, 'Committed v1');
  await setFirstMessage(page, 'second');
  await commit(page, 'Committed v2');

  await page.getByRole('tab', { name: 'Versions' }).click();
  await page.getByRole('button', { name: '→ production' }).first().click();
  await page.getByRole('button', { name: 'Promote to production' }).click();
  await expect(page.getByText(/Pointed production → v2/)).toBeVisible();

  await page.getByRole('tab', { name: 'Audit' }).click();
  await expect(page.getByText('Version committed').first()).toBeVisible();
  await expect(page.getByText('Alias promoted').first()).toBeVisible();
  await expect(page.getByText('Prompt created')).toBeVisible();
});

test('export: downloads a version as JSON', async ({ page }) => {
  await signup(page);
  await createPrompt(page, `exp-${Date.now()}`);
  await page.getByTestId('template-input').first().fill('hello {{ name }}');
  await commit(page, 'Committed v1');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.json$/);
});

test('account: personal API key can be revoked', async ({ page }) => {
  await signup(page);
  await page.goto('/account');

  await page.getByRole('button', { name: 'New key' }).click();
  await page.getByRole('button', { name: 'Create key' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('No API keys yet')).toHaveCount(0);

  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await page.getByRole('button', { name: 'Revoke key' }).click();
  await expect(page.getByText('API key revoked')).toBeVisible();
  await expect(page.getByText('No API keys yet')).toBeVisible();
});

test('theme: toggle switches light/dark on the document root', async ({ page }) => {
  await signup(page);
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Toggle theme' }).click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Toggle theme' }).click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
});

test('team: create + revoke a team API key', async ({ page }) => {
  await signup(page);
  await page.goto('/team');
  const keys = page.locator('section').filter({ hasText: 'Team API keys' });

  await keys.getByRole('button', { name: 'New key' }).click();
  await page.getByRole('button', { name: 'Create key' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(keys.getByText(/••••/)).toBeVisible();

  await keys.getByRole('button', { name: 'Revoke', exact: true }).click();
  await page.getByRole('button', { name: 'Revoke key' }).click();
  await expect(page.getByText('API key revoked')).toBeVisible();
});

test('team: invite → second user accepts → edit roles → remove member → revoke invite', async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const A = await ctxA.newPage();
  await signup(A);

  // Create an invite (viewer) via the UI.
  await A.goto('/team');
  const invites = A.locator('section').filter({ hasText: 'Invites' });
  await invites.getByRole('button', { name: 'New invite' }).click();
  await A.getByRole('button', { name: 'Create link' }).click();
  await expect(A.getByRole('button', { name: 'Copy link' })).toBeVisible();

  // Read team id + token from the real API (same session cookies).
  const me = await (await A.request.get('/api/v1/auth/me')).json();
  const teamId = me.team.id as string;
  const list = await (await A.request.get(`/api/v1/teams/${teamId}/invites`)).json();
  const token = list[0].token as string;

  // Second user signs up and accepts the invite via the accept page.
  const ctxB = await browser.newContext();
  const B = await ctxB.newPage();
  const bEmail = await signup(B);
  await B.goto(`/invite/${token}`);
  await expect(B).toHaveURL(/\/team/);
  // Acceptance is verified through the API (B has no team-switch UI by design).
  const membersB = await (await B.request.get(`/api/v1/teams/${teamId}/members`)).json();
  expect((membersB as Array<{ email: string }>).map((m) => m.email)).toContain(bEmail);

  // Back in A: the new member shows up; edit their roles, then remove them.
  await A.goto('/team');
  await expect(A.getByText(bEmail)).toBeVisible();
  await A.getByRole('button', { name: 'Edit roles' }).first().click();
  await A.locator('label').filter({ hasText: 'commit versions' }).getByRole('checkbox').check();
  await A.getByRole('button', { name: 'Save roles' }).click();
  await expect(A.getByText('Roles updated')).toBeVisible();

  await A.getByRole('button', { name: 'Remove', exact: true }).first().click();
  await A.getByRole('button', { name: 'Remove member' }).click();
  await expect(A.getByText('Member removed')).toBeVisible();
  await expect(A.getByText(bEmail)).toHaveCount(0);

  await ctxA.close();
  await ctxB.close();
});

test('team: an invite can be created and revoked', async ({ page }) => {
  await signup(page);
  await page.goto('/team');
  const invites = page.locator('section').filter({ hasText: 'Invites' });

  await invites.getByRole('button', { name: 'New invite' }).click();
  await page.getByRole('button', { name: 'Create link' }).click();
  await expect(page.getByRole('button', { name: 'Copy link' })).toBeVisible();

  await invites.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.getByText('No pending invites')).toBeVisible();
});
