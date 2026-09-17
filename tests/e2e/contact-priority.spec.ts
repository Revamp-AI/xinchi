import { expect, test } from '@playwright/test';
import { saveContact } from '../../lib/contacts.mjs';

test('star contacts, filter the map, persist priority, and remove it from the profile', async ({
  page,
}, info) => {
  const prefix = `Priority browser ${info.project.name}`;
  const name = `${prefix} Z`;
  await saveContact({ name: `${prefix} A` });
  await saveContact({ name });
  await page.goto('/#contacts');
  await page.getByLabel('Search contacts').fill(prefix);
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const table = page.getByRole('table', { name: 'Contacts', exact: true });
  await expect(table.getByRole('row')).toHaveCount(3);
  await table
    .getByRole('button', { name: `Prioritize ${name}`, exact: true })
    .click();
  await expect(table.getByRole('row').nth(1)).toContainText(name);
  await expect(
    table.getByRole('button', {
      name: `Remove priority from ${name}`,
      exact: true,
    }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page
    .getByRole('button', { name: 'Priority only', exact: true })
    .click();
  await expect(table.getByRole('row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  const node = page.getByRole('button', {
    name: `${name}, Unclassified, priority`,
    exact: true,
  });
  await expect(node).toBeVisible();
  await page.screenshot({
    path: info.outputPath('priority-map.png'),
    fullPage: true,
  });
  await node.click();
  let dialog = page.getByRole('dialog', { name, exact: true });
  await expect(
    dialog.getByRole('button', { name: 'Remove priority', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await dialog
    .getByRole('button', { name: 'Edit profile', exact: true })
    .click();
  await expect(
    page.getByRole('checkbox', { name: 'Priority contact', exact: true }),
  ).toBeChecked();
  await page.reload();
  await page.getByLabel('Search contacts').fill(name);
  await page
    .getByRole('button', {
      name: `${name}, Unclassified, priority`,
      exact: true,
    })
    .click();
  dialog = page.getByRole('dialog', { name, exact: true });
  await dialog
    .getByRole('button', { name: 'Remove priority', exact: true })
    .click();
  await expect(
    dialog.getByRole('button', { name: 'Prioritize contact', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page
    .getByRole('button', { name: 'Priority only', exact: true })
    .click();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(
    page.getByRole('heading', {
      name: 'No contacts in this view',
      exact: true,
    }),
  ).toBeVisible();
});
