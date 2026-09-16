import { expect, test } from '@playwright/test';
import { one, run, uid, upsertSource } from '../../lib/db.mjs';
import { saveContact } from '../../lib/contacts.mjs';

async function match(a: any, b: any) {
  const id = uid(),
    [left, right] = [a.id, b.id].sort();
  await run(
    'INSERT INTO identity_reviews(id,left_id,right_id,reason) VALUES(?,?,?,?)',
    id,
    left,
    right,
    'Fictional bulk review match',
  );
  return {
    id,
    label: `Select match: ${left === a.id ? a.name : b.name} and ${right === b.id ? b.name : a.name}`,
  };
}
test('selecting, previewing, choosing a keeper, merging and undoing work for overlapping matches', async ({
  page,
  request,
}, testInfo) => {
  const suffix = testInfo.project.name;
  const a = await saveContact({
    name: `Bulk A ${suffix}`,
    email: `bulk-a-${suffix}@example.com`,
  });
  const b = await saveContact({
    name: `Bulk B ${suffix}`,
    email: `bulk-b-${suffix}@example.com`,
    do_not_contact: true,
  });
  const c = await saveContact({
    name: `Bulk C ${suffix}`,
    email: `bulk-c-${suffix}@example.com`,
  });
  const d = await saveContact({ name: `Bulk Unselected ${suffix}` });
  const ab = await match(a, b),
    bc = await match(b, c),
    cd = await match(c, d);
  await page.goto('/#contacts');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  const toolbar = page.getByRole('group', { name: 'Bulk identity review' });
  await expect(
    toolbar.getByRole('button', { name: 'Review selected merges' }),
  ).toBeDisabled();
  // Select-all never silently includes the next page; clearing it clears every visible box.
  await toolbar.getByRole('checkbox').check();
  await expect(
    page.getByRole('checkbox', { name: ab.label, exact: true }),
  ).toBeChecked();
  await toolbar.getByRole('checkbox').uncheck();
  await expect(
    page.getByRole('checkbox', { name: ab.label, exact: true }),
  ).not.toBeChecked();
  await page.getByRole('checkbox', { name: ab.label, exact: true }).check();
  await page.getByRole('checkbox', { name: bc.label, exact: true }).check();
  await expect(toolbar.getByText(/2 selected/)).toBeVisible();
  await toolbar.getByRole('button', { name: 'Review selected merges' }).click();
  const dialog = page.getByRole('dialog', {
    name: 'Review selected merges',
    exact: true,
  });
  await expect(dialog.getByText('Group 1 · 3 profiles')).toBeVisible();
  await expect(dialog.getByText(d.name, { exact: true })).toHaveCount(0);
  await dialog
    .getByRole('combobox', { name: 'Keep profile for group 1' })
    .click();
  await page
    .getByRole('option', { name: `${b.name} · ${b.email}`, exact: true })
    .click();
  await page.screenshot({
    path: testInfo.outputPath('bulk-merge-preview.png'),
    fullPage: true,
  });
  await dialog
    .getByRole('button', { name: 'Merge 2 profiles in 1 group' })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText(
      '2 profiles merged. Each completed group is available in Recent merges.',
      { exact: true },
    ),
  ).toBeVisible();
  expect(
    (await one('SELECT merged_into FROM contacts WHERE id=?', a.id))
      .merged_into,
  ).toBe(b.id);
  expect(
    (await one('SELECT merged_into FROM contacts WHERE id=?', c.id))
      .merged_into,
  ).toBe(b.id);
  expect(
    (await one('SELECT merged_into FROM contacts WHERE id=?', d.id))
      .merged_into,
  ).toBeNull();
  const decision = await one(
    'SELECT id FROM identity_decisions WHERE left_id=? ORDER BY created_at DESC LIMIT 1',
    b.id,
  );
  const recent = page
    .locator('.contact-review-row')
    .filter({ has: page.getByText(`2 profiles → ${b.name}`, { exact: true }) });
  await recent.getByRole('button', { name: 'Undo merge' }).click();
  await expect(
    page.getByRole('checkbox', { name: ab.label, exact: true }),
  ).toBeVisible();
  expect(
    (
      await one(
        'SELECT undone_at FROM identity_decisions WHERE id=?',
        decision.id,
      )
    ).undone_at,
  ).toBeTruthy();
  // Bulk separation resolves only the selected IDs, leaving the other match pending.
  await page.getByRole('checkbox', { name: ab.label, exact: true }).check();
  await page.getByRole('checkbox', { name: bc.label, exact: true }).check();
  await toolbar
    .getByRole('button', { name: 'Mark selected as different people' })
    .click();
  await expect(
    page.getByRole('checkbox', { name: ab.label, exact: true }),
  ).toHaveCount(0);
  expect(
    (await one('SELECT status FROM identity_reviews WHERE id=?', ab.id)).status,
  ).toBe('separate');
  expect(
    (await one('SELECT status FROM identity_reviews WHERE id=?', cd.id)).status,
  ).toBe('pending');
  const invalid = await request.post('/api/contacts/bulk-merge-preview', {
    headers: { Origin: new URL(page.url()).origin, 'X-Xin-Request': '1' },
    data: { ids: [] },
  });
  expect(invalid.status()).toBe(400);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('recording bulk actions report partial failures and keep later rows untouched', async ({
  page,
}, testInfo) => {
  const suffix = testInfo.project.name,
    records = [];
  for (let n = 0; n < 3; n++) {
    const id = uid(),
      other = uid(),
      title = `Bulk recording ${suffix} ${n}`;
    const s = await upsertSource({
      provider: 'manual',
      external_id: id,
      title,
      body: 'Fictional recording evidence.',
      coverage: 'document',
    });
    const o = await upsertSource({
      provider: 'manual',
      external_id: other,
      title: 'Original ' + title,
      body: 'Fictional original evidence.',
      coverage: 'document',
    });
    await run(
      "INSERT INTO interactions(id,source_id,kind,title) VALUES(?,?,'meeting',?)",
      other,
      o.id,
      'Original ' + title,
    );
    await run(
      "INSERT INTO interactions(id,source_id,kind,title,duplicate_of,duplicate_status) VALUES(?,?,'meeting',?,?,'review')",
      id,
      s.id,
      title,
      other,
    );
    records.push({ id, title });
  }
  await page.goto('/#contacts');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  const toolbar = page.getByRole('group', { name: 'Bulk recording review' });
  await page
    .getByRole('checkbox', {
      name: 'Select recording: ' + records[0].title,
      exact: true,
    })
    .check();
  await page
    .getByRole('checkbox', {
      name: 'Select recording: ' + records[1].title,
      exact: true,
    })
    .check();
  // A concurrent edit makes one selected row stale. The other can still finish.
  await run(
    'UPDATE interactions SET version=version+1 WHERE id=?',
    records[1].id,
  );
  await toolbar
    .getByRole('button', { name: 'Mark selected as same meeting' })
    .click();
  await expect(
    page.getByText('1 recording match marked as the same meeting.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(/Some decisions could not be confirmed/),
  ).toBeVisible();
  expect(
    (
      await one(
        'SELECT duplicate_status FROM interactions WHERE id=?',
        records[0].id,
      )
    ).duplicate_status,
  ).toBe('confirmed');
  expect(
    (
      await one(
        'SELECT duplicate_status FROM interactions WHERE id=?',
        records[1].id,
      )
    ).duplicate_status,
  ).toBe('review');
  expect(
    (
      await one(
        'SELECT duplicate_status FROM interactions WHERE id=?',
        records[2].id,
      )
    ).duplicate_status,
  ).toBe('review');
  await toolbar
    .getByRole('button', { name: 'Mark selected as separate meetings' })
    .click();
  await expect(
    page.getByRole('checkbox', {
      name: 'Select recording: ' + records[1].title,
      exact: true,
    }),
  ).toHaveCount(0);
  expect(
    (
      await one(
        'SELECT duplicate_status FROM interactions WHERE id=?',
        records[1].id,
      )
    ).duplicate_status,
  ).toBe('separate');
  await page.screenshot({
    path: testInfo.outputPath('bulk-recording-results.png'),
    fullPage: true,
  });
});
