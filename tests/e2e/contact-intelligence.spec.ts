import { expect, test } from '@playwright/test';
import { run, uid } from '../../lib/db.mjs';
import { saveContact } from '../../lib/contacts.mjs';
import { logInteraction } from '../../lib/contact-extraction.mjs';
import { contactEvidence } from '../../lib/contact-intelligence.mjs';

test('relationship context explains purpose, estimated cooling, evidence and deliberate pause', async ({
  page,
}, info) => {
  const name = `Relationship context ${info.project.name}`;
  const contact = await saveContact({ name, confirmed: true });
  const quote =
    'We reviewed the customer renewal and agreed to prepare the revised brief.';
  await logInteraction({
    contact_id: contact.id,
    kind: 'meeting',
    direction: 'mutual',
    meaningful: true,
    occurred_at: new Date(Date.now() - 45 * 86400000).toISOString(),
    body: quote,
  });
  const packet = await contactEvidence(contact);
  const source = packet.sources.find((s) => s.body.includes(quote))!;
  await run(
    'INSERT INTO contact_insights(contact_id,input_hash,result,run_id) VALUES(?,?,?::jsonb,?)',
    contact.id,
    'fixture',
    JSON.stringify({
      contact_id: contact.id,
      purpose_tags: ['Customer'],
      summary: 'Reviewed their customer renewal.',
      next_action: 'Prepare the revised brief.',
      confidence: 'high',
      citations: [
        {
          source_id: source.source_id,
          source_version_id: source.source_version_id,
          quote,
        },
      ],
    }),
    uid(),
  );
  await page.goto('/#contacts');
  await expect(
    page.getByRole('region', { name: 'Relationship agent' }),
  ).toBeVisible();
  await page.getByLabel('Search contacts').fill(name);
  await expect(
    page
      .getByRole('region', { name: 'Cooling relationships' })
      .getByRole('button', {
        name: `${name}, Cooling, estimated`,
        exact: true,
      }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const row = page
    .getByRole('table', { name: 'Contacts', exact: true })
    .getByRole('row')
    .filter({ hasText: name });
  await expect(row).toContainText('Customer');
  await expect(row).toContainText('Estimated · partial history');
  await row.getByRole('button').click();
  const dialog = page.getByRole('dialog', { name, exact: true });
  await expect(
    dialog.getByRole('region', { name: 'Relationship context' }),
  ).toContainText('Customer · inferred');
  await expect(dialog).toContainText(quote);
  await page.screenshot({
    path: info.outputPath('relationship-context.png'),
    fullPage: true,
  });
  await dialog
    .getByRole('button', { name: 'Pause relationship', exact: true })
    .click();
  await expect(
    dialog.getByRole('button', { name: 'Resume relationship', exact: true }),
  ).toBeVisible();
  await expect(dialog).not.toContainText('Suggested next step:');
  await dialog
    .getByRole('button', { name: 'Resume relationship', exact: true })
    .click();
  await expect(
    dialog.getByRole('button', { name: 'Pause relationship', exact: true }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'View evidence 1' }).click();
  await expect(page.getByRole('dialog').last()).toContainText(quote);
});
