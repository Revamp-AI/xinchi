import { expect, test } from '@playwright/test';

test('activity classifies an unconfirmed contact and confirmation leaves tracking unchanged', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const name = `Automatic classification ${testInfo.project.name}`;
  const headers = { origin: baseURL!, 'x-xin-request': '1' };
  const created = await request.post('/api/contacts', {
    headers,
    data: { name, confirmed: false, tracked: false },
  });
  expect(created.ok()).toBe(true);
  const contact = await created.json();
  const logged = await request.post('/api/contacts/interaction', {
    headers,
    data: {
      contact_id: contact.id,
      kind: 'meeting',
      direction: 'mutual',
      meaningful: true,
      occurred_at: new Date(Date.now() - 86400000).toISOString(),
      body: 'Discussed the fictional launch plan together.',
    },
  });
  expect(logged.ok()).toBe(true);

  await page.goto('/#contacts');
  await page.getByLabel('Search contacts').fill(name);
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const row = page
    .getByRole('table', { name: 'Contacts', exact: true })
    .getByRole('row')
    .filter({ hasText: name });
  await expect(row).toContainText('Active');
  await row.getByRole('button', { name: new RegExp(name) }).click();
  const dialog = page.getByRole('dialog', { name, exact: true });
  await expect(dialog).toContainText(
    'Classification already uses its verified activity.',
  );
  await dialog
    .getByRole('button', { name: 'Confirm contact', exact: true })
    .click();
  await expect(
    dialog.getByRole('button', { name: 'Confirm contact', exact: true }),
  ).toBeHidden();
  await expect(dialog).toContainText('A meaningful exchange is within');
  const saved = await (await request.get(`/api/contacts/${contact.id}`)).json();
  expect(saved.confirmed).toBe(true);
  expect(saved.tracked).toBe(false);
  expect(saved.relationship.state).toBe('Active');

  await dialog.getByRole('button', { name: 'Edit profile' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit contact' });
  await expect(
    edit.getByRole('checkbox', { name: 'Track for follow-ups' }),
  ).not.toBeChecked();
  await expect(edit).toContainText(
    'Relationship classification uses verified activity automatically.',
  );
  await edit
    .getByRole('button', { name: 'Save contact' })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('automatic-classification.png'),
    fullPage: true,
  });
});
