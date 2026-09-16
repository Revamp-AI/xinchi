import { expect, test } from '@playwright/test';
import { one, setSetting } from '../../lib/db.mjs';
import { saveContact } from '../../lib/contacts.mjs';
import {
  parseLinkedinConnections,
  importLinkedinBatch,
} from '../../lib/linkedin-import.mjs';
import { employerDomainCacheKey } from '../../lib/contact-auto-match.mjs';
import { websiteCompanyEvidence } from '../../lib/company-domain.mjs';
import { importAppleContacts } from '../../lib/apple-contacts.mjs';

test('automatic employer matching can be paused, run, explained and undone', async ({
  page,
}, info) => {
  const suffix = info.project.name.replaceAll('-', ''),
    name = 'Employer ' + suffix;
  const email = await saveContact({
    name,
    email: suffix + '@fictionalworks.com',
  });
  const records = parseLinkedinConnections(
    'First Name,Last Name,URL,Email Address,Company,Position,Connected On\nEmployer,' +
      suffix +
      ',https://www.linkedin.com/in/' +
      suffix +
      ',,Fictionalworks,Designer,09 Sep 2026',
  ).records;
  await importLinkedinBatch(records);
  const proof = websiteCompanyEvidence('Fictionalworks', 'fictionalworks.com', {
    url: 'https://fictionalworks.com/',
    html: '<title>Fictionalworks</title>',
  });
  await setSetting(
    employerDomainCacheKey('Fictionalworks', 'fictionalworks.com'),
    { verified: true, proof, checked_at: new Date().toISOString() },
  );
  await setSetting('contact_auto_match', {});
  await page.goto('/#contacts');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  const controls = page.getByRole('group', {
    name: 'Automatic LinkedIn matching',
  });
  await controls.getByRole('checkbox', { name: 'Match automatically' }).click();
  await expect(
    controls.getByRole('checkbox', { name: 'Match automatically' }),
  ).not.toBeChecked();
  await expect(
    controls.getByRole('checkbox', { name: 'Match automatically' }),
  ).toBeEnabled();
  await expect(
    controls.getByRole('button', { name: 'Match now' }),
  ).toBeDisabled();
  await controls.getByRole('checkbox', { name: 'Match automatically' }).click();
  await expect(
    controls.getByRole('button', { name: 'Match now' }),
  ).toBeEnabled();
  await controls.getByRole('button', { name: 'Match now' }).click();
  await expect(
    page.getByText('1 profile matched automatically.', { exact: true }),
  ).toBeVisible();
  const row = page
    .locator('.contact-review-row')
    .filter({ hasText: `${name} → ${name}` });
  await expect(row.getByText(/Automatically matched: same name/)).toBeVisible();
  await expect(
    row.getByRole('link', { name: 'Company website' }),
  ).toHaveAttribute('href', 'https://fictionalworks.com/');
  await page.screenshot({
    path: info.outputPath('automatic-matching.png'),
    fullPage: true,
  });
  await row.getByRole('button', { name: 'Undo merge' }).click();
  await expect(
    page.getByText('Merge undone. The original profiles were restored.', {
      exact: true,
    }),
  ).toBeVisible();
  const linked = await one(
    "SELECT contact_id FROM contact_identities WHERE provider='linkedin' AND external_key=?",
    records[0].key,
  );
  expect(linked.contact_id).not.toBe(email.id);
  await controls.getByRole('button', { name: 'Match now' }).click();
  await expect(
    page.getByText('0 profiles matched automatically.', { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('Apple phone numbers are searchable and visible on the contact profile', async ({
  page,
}, info) => {
  const suffix = info.project.name,
    name = 'Apple ' + suffix;
  await importAppleContacts(
    [
      {
        key: 'e2e-apple-' + suffix,
        name,
        emails: ['apple-' + suffix + '@example.com'],
        phones: [
          suffix.startsWith('desktop') ? '+14155550901' : '+14155550902',
        ],
        company: 'Fictional Studio',
      },
    ],
    { apply: true },
  );
  await page.goto('/#contacts');
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search contacts' }).fill(name);
  await page
    .getByRole('button')
    .filter({ has: page.getByText(name, { exact: true }) })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('heading', { name: 'Apple contact details' }),
  ).toBeVisible();
  await expect(
    dialog.getByText(
      suffix.startsWith('desktop') ? '+14155550901' : '+14155550902',
      { exact: true },
    ),
  ).toBeVisible();
});
