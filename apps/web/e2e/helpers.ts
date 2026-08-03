import { expect, type Page } from '@playwright/test';

let counter = 0;

/** A unique email per invocation, safe to run against a shared dev database. */
export function uniqueEmail(): string {
  counter += 1;
  return `e2e-${Date.now()}-${counter}@example.com`;
}

/** Sign up a fresh account and land on the prompts page. */
export async function signup(page: Page): Promise<string> {
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
  return email;
}

/** Create a prompt via the UI and return its name; ends on the detail page. */
export async function createPrompt(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'New prompt' }).first().click();
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Create prompt' }).click();
  await expect(page).toHaveURL(/\/prompts\/[0-9a-f-]{8}/);
}

/**
 * Set the first message's content. Always switches to the Editor tab first,
 * because committing a version auto-navigates to the Versions tab.
 */
export async function setFirstMessage(page: Page, text: string): Promise<void> {
  await page.getByRole('tab', { name: 'Editor' }).click();
  await page.getByTestId('template-input').first().fill(text);
}
