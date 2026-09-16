import { expect, test } from '@playwright/test';
import { all, run, uid } from '../../lib/db.mjs';
import { resolveExactEmailContact } from '../../lib/contact-identity.mjs';

test('an exact-email match appears once and source names remain visible and searchable', async ({
  page,
  request,
}, testInfo) => {
  const suffix = testInfo.project.name,
    email = `identity-${suffix}@example.com`,
    name = `Dana Ellis ${suffix}`,
    alias = `dana-alias-${suffix}`;
  for (const [provider, displayName] of [
    ['gmail', name],
    ['granola', alias],
    ['fireflies', email],
  ]) {
    const id = uid();
    await run(
      'INSERT INTO contacts(id,name,email,confirmed) VALUES(?,?,?,false)',
      id,
      displayName,
      email,
    );
    await run(
      'INSERT INTO contact_identities(id,contact_id,provider,account,external_key,display_name,address) VALUES(?,?,?,?,?,?,?)',
      uid(),
      id,
      provider,
      'owner@example.com',
      email,
      displayName,
      email,
    );
  }
  const matched = await resolveExactEmailContact(email);
  expect(matched.name).toBe(name);
  await page.goto('/#contacts');
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await page.getByPlaceholder('Find a person, role, or organization').fill(email);
  const table = page.getByRole('table', { name: 'Contacts', exact: true });
  await expect(table.getByRole('row')).toHaveCount(2);
  await table.getByRole('button', { name: new RegExp(name) }).click();
  const dialog = page.getByRole('dialog', { name, exact: true });
  await dialog
    .getByText('Identity bindings and relationship history', { exact: true })
    .click();
  await expect(
    dialog.getByText(`granola · ${alias} · ${email}`, { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText(`gmail · ${name} · ${email}`, { exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByPlaceholder('Find a person, role, or organization').fill(alias);
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(
    table.getByRole('button', { name: new RegExp(name) }),
  ).toBeVisible();
  const status = await (await request.get('/api/contacts/status')).json();
  expect(
    status.reviews.filter(
      (r: any) => r.left_email === email || r.right_email === email,
    ),
  ).toHaveLength(0);
  expect(
    await all(
      'SELECT id FROM contacts WHERE email=? AND merged_into IS NULL',
      email,
    ),
  ).toHaveLength(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('contact-email-match.png'),
    fullPage: true,
  });
});
