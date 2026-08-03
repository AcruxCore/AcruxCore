import { expect, test } from '@playwright/test';
import { createPrompt, signup } from './helpers';

test('definition of done: edit → commit → promote → render returns the new version', async ({
  page,
}) => {
  await signup(page);
  const name = `greeting-${Date.now()}`;
  await createPrompt(page, name);

  const editor = page.getByTestId('template-input').first();

  // Commit v1.
  await editor.fill('Hello {{ name }}');
  await page.getByRole('button', { name: 'Commit new version' }).first().click();
  await expect(page.getByText('Committed v1')).toBeVisible();

  // Commit v2 with changed content.
  await page.getByRole('tab', { name: 'Editor' }).click();
  await editor.fill('Hi there, {{ name }}!');
  await page.getByRole('button', { name: 'Commit new version' }).first().click();
  await expect(page.getByText('Committed v2')).toBeVisible();

  // Promote production → v2 (v1 is auto-production after the first commit).
  await page.getByRole('tab', { name: 'Versions' }).click();
  await page.getByRole('button', { name: '→ production' }).first().click();
  await page.getByRole('button', { name: 'Promote to production' }).click();
  await expect(page.getByText(/Pointed production → v2/)).toBeVisible();

  // Verify through the real render endpoint that production now serves v2.
  const res = await page.request.post(
    `/api/v1/prompts/${encodeURIComponent(name)}/production/render`,
    { data: { variables: { name: 'Alice' } } },
  );
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { messages: Array<{ content: string }> };
  expect(JSON.stringify(body.messages)).toContain('Hi there, Alice!');
});

test('preview renders the draft client-side with filled variables', async ({ page }) => {
  await signup(page);
  await createPrompt(page, `preview-${Date.now()}`);

  await page.getByTestId('template-input').first().fill('Hello {{ name }} from {{ company }}');
  await page.getByRole('tab', { name: 'Preview' }).click();

  await page.getByLabel('name').fill('Alice');
  await page.getByLabel('company').fill('Acme');

  await expect(page.getByText('Hello Alice from Acme')).toBeVisible();
});

test('diff shows added and removed lines between two versions', async ({ page }) => {
  await signup(page);
  await createPrompt(page, `diff-${Date.now()}`);
  const editor = page.getByTestId('template-input').first();

  await editor.fill('You are a polite assistant.');
  await page.getByRole('button', { name: 'Commit new version' }).first().click();
  await expect(page.getByText('Committed v1')).toBeVisible();

  await page.getByRole('tab', { name: 'Editor' }).click();
  await editor.fill('You are a concise, friendly assistant.');
  await page.getByRole('button', { name: 'Commit new version' }).first().click();
  await expect(page.getByText('Committed v2')).toBeVisible();

  await page.getByRole('tab', { name: 'Diff' }).click();
  await expect(page.getByText('You are a concise, friendly assistant.')).toBeVisible();
});

test('personal API key can be created and is revealed once', async ({ page }) => {
  await signup(page);
  await page.goto('/account');

  await page.getByRole('button', { name: 'New key' }).click();
  await page.getByLabel('Name').fill('ci');
  await page.getByRole('button', { name: 'Create key' }).click();

  await expect(page.getByText('Copy your API key')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();

  await expect(page.getByText('ci')).toBeVisible();
});

test('team invite link can be generated', async ({ page }) => {
  await signup(page);
  await page.goto('/team');

  await page.getByRole('button', { name: 'New invite' }).click();
  await page.getByRole('button', { name: 'Create link' }).click();

  await expect(page.getByRole('button', { name: 'Copy link' })).toBeVisible();
});

test('viewer-only affordances hidden for a signed-out visitor', async ({ page }) => {
  // Unauthenticated access to a protected route redirects to login.
  await page.goto('/prompts');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});
