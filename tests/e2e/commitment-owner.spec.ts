import { expect, test } from '@playwright/test';

test('an owner can be found by email, selected, saved, and changed back to You', async ({
  page,
  request,
}, testInfo) => {
  const title = `Owner dropdown check (${testInfo.project.name})`;
  await page.goto('/#board');
  await page.getByRole('button', { name: 'New outcome', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Choose an outcome' });
  await dialog.getByLabel('What is the outcome?').fill(title);
  await expect(dialog.getByLabel('Owner', { exact: true })).toHaveText('You');
  await dialog.getByLabel('Owner', { exact: true }).click();
  await page
    .getByLabel('Search owners', { exact: true })
    .fill('avery.chen@example.com');
  await expect(
    page.getByRole('option', { name: 'Avery Chen', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Search owners', { exact: true }).press('ArrowDown');
  await page.getByLabel('Search owners', { exact: true }).press('Enter');
  await expect(dialog.getByLabel('Owner', { exact: true })).toHaveText(
    'Avery Chen',
  );
  await dialog
    .getByRole('button', { name: 'Save decision', exact: true })
    .click();
  await expect(dialog).toBeHidden();
  let state = await (await request.get('/api/state')).json();
  const saved = state.items.find(
    (item: { title: string }) => item.title === title,
  );
  expect(saved.owner).toBe('Avery Chen');

  await page.getByRole('tab', { name: /^To decide/ }).click();
  await page.getByRole('button', { name: title, exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Review commitment' });
  await expect(dialog.getByLabel('Owner', { exact: true })).toHaveText(
    'Avery Chen',
  );
  await dialog.getByLabel('Owner', { exact: true }).click();
  await page.getByLabel('Search owners', { exact: true }).fill('zzznomatch');
  await expect(page.getByText('No matching owners.')).toBeVisible();
  await page.getByLabel('Search owners', { exact: true }).fill('');
  await expect(
    page.getByRole('option', { name: 'You', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('owner-dropdown.png'),
    fullPage: true,
  });
  await page.getByRole('option', { name: 'You', exact: true }).click();
  await dialog
    .getByRole('button', { name: 'Save decision', exact: true })
    .click();
  await expect(dialog).toBeHidden();
  state = await (await request.get('/api/state')).json();
  expect(
    state.items.find((item: { id: string }) => item.id === saved.id).owner,
  ).toBe('Alex');
});
