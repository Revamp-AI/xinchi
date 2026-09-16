import { expect, test } from '@playwright/test';
import {
  parseLinkedinConnections,
  importLinkedinBatch,
} from '../../lib/linkedin-import.mjs';

test('LinkedIn imports expose profile and source evidence without inventing activity', async ({
  page,
  request,
}, testInfo) => {
  const suffix = testInfo.project.name,
    name = `LinkedIn Fixture ${suffix}`,
    url = `https://www.linkedin.com/in/fixture-${suffix}`;
  const parsed = parseLinkedinConnections(
    `Notes:\n"Emails may be missing."\n\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\nLinkedIn,Fixture ${suffix},${url},,Fictional Studio,Designer,09 Sep 2026`,
  );
  expect((await importLinkedinBatch(parsed.records)).added).toBe(1);
  await page.goto('/#contacts');
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await page.getByPlaceholder('Find a person, role, or organization').fill(url);
  const table = page.getByRole('table', { name: 'Contacts', exact: true });
  await expect(table.getByRole('row')).toHaveCount(2);
  await table.getByRole('button', { name: new RegExp(name) }).click();
  const dialog = page.getByRole('dialog', { name, exact: true });
  await expect(
    dialog.getByText('Unclassified', { exact: true }).first(),
  ).toBeVisible();
  await dialog
    .getByText('Identity bindings and relationship history', { exact: true })
    .click();
  await expect(
    dialog.getByRole('link', { name: 'LinkedIn profile' }),
  ).toHaveAttribute('href', url);
  await expect(
    dialog.getByText(/Connected on LinkedIn.*connection date only/),
  ).toBeVisible();
  await expect(dialog.getByText(/identity needs review/)).toHaveCount(0);
  const response = await request.get(
    '/api/contacts?q=' + encodeURIComponent(url),
  );
  const data = await response.json();
  expect(data.records).toHaveLength(1);
  expect(data.records[0].tracked).toBe(false);
  expect(data.records[0].confirmed).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath('linkedin-provenance.png'),
    fullPage: true,
  });
  await dialog
    .getByRole('button', { name: 'View imported connection' })
    .click();
  await expect(
    page
      .getByText(
        'Profile data from an export; a connection is not evidence of a conversation.',
        { exact: false },
      )
      .first(),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
