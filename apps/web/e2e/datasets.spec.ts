import { expect, test } from '@playwright/test';
import { signup } from './helpers';

/**
 * The dashboard route into evaluation for a team with no traffic yet (#382):
 * create an empty dataset from the Datasets page, then hand-author its first
 * example. Needs no model key and no worker — nothing here runs a completion.
 */
test('a team with no feedback can create a dataset and add an example by hand', async ({ page }) => {
  await signup(page);

  await page.goto('/evaluations');
  await expect(page.getByText('No datasets yet')).toBeVisible();

  await page.getByTestId('new-dataset').click();
  await page.getByTestId('new-dataset-name').fill('regression-suite');
  await page.getByTestId('new-dataset-submit').click();

  // Lands on the new dataset, which is empty and offers the way to fill it.
  await expect(page).toHaveURL(/\/evaluations\/datasets\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { name: 'regression-suite' })).toBeVisible();
  await expect(page.getByText('No examples yet')).toBeVisible();

  // Add one example via the named-field editor.
  await page.getByTestId('add-example').click();
  await page.getByTestId('add-example-var-key').first().fill('topic');
  await page.getByTestId('add-example-var-value').first().fill('refund window');
  await page.getByTestId('add-example-criteria').fill('States the 30-day refund window.');
  await page.getByTestId('add-example-submit').click();

  await expect(page.getByText('Example added')).toBeVisible();
  await expect(page.getByText('topic:')).toBeVisible();
  await expect(page.getByText('States the 30-day refund window.')).toBeVisible();
  await expect(page.getByText('1 example', { exact: true })).toBeVisible();

  // The JSON mode carries the typed fields across and accepts non-string values.
  await page.getByTestId('add-example').click();
  await page.getByTestId('add-example-json-toggle').click();
  await page.getByTestId('add-example-json').fill('{"topic": "shipping", "retries": 2}');
  await page.getByTestId('add-example-submit').click();
  await expect(page.getByText('Example added')).toBeVisible();
  await expect(page.getByText('retries:')).toBeVisible();

  // The list picks up the new dataset and its example count.
  await page.goto('/evaluations');
  await expect(page.getByTestId('dataset-row-link')).toHaveText('regression-suite');
  await expect(page.getByRole('cell', { name: '2', exact: true })).toBeVisible();
});

/** An example with no variables at all is refused before it reaches the API. */
test('adding an example with no variables is refused in the dialog', async ({ page }) => {
  await signup(page);

  await page.goto('/evaluations');
  await page.getByTestId('new-dataset').click();
  await page.getByTestId('new-dataset-name').fill('empty-guard');
  await page.getByTestId('new-dataset-submit').click();
  await expect(page.getByText('No examples yet')).toBeVisible();

  await page.getByTestId('add-example').click();
  await page.getByTestId('add-example-submit').click();
  await expect(page.getByText('Add at least one variable.')).toBeVisible();

  await page.getByTestId('add-example-json-toggle').click();
  await page.getByTestId('add-example-json').fill('not json');
  await page.getByTestId('add-example-submit').click();
  await expect(page.getByText('That is not valid JSON.')).toBeVisible();
});
