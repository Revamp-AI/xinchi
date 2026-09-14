import { expect, test, type Page } from '@playwright/test';
import { candidate, sources } from './global-setup';

// Sidebar label -> the h1 each view renders.
const views = {
  Overview: 'Your next move, clearer.',
  Commitments: 'Your commitments',
  'Context library': 'Context library',
  Connections: 'Your connections',
};
const [fireflies] = sources;

function heading(page: Page, name: string) {
  return page.getByRole('heading', { level: 1, name, exact: true });
}
async function open(page: Page, view: keyof typeof views) {
  const item = page.getByRole('button', { name: view, exact: true });
  // On a phone the navigation lives in the sidebar sheet behind the trigger.
  // The sheet closes itself after a navigation and its items stay visible
  // while it slides out, so let a closing sheet finish before looking.
  const sheet = page.getByRole('dialog', { name: 'Sidebar' });
  await expect(sheet).toBeHidden();
  if (!(await item.isVisible())) {
    await page.getByRole('button', { name: 'Toggle Sidebar' }).click();
    await expect(item).toBeVisible();
  }
  await item.click();
  await expect(heading(page, views[view])).toBeVisible();
  await expect(sheet).toBeHidden();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(heading(page, views.Overview)).toBeVisible();
});

test('the overview loads signed in', async ({ page, isMobile }) => {
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.locator('.breadcrumb strong')).toHaveText('Overview');
  // Phones hide the heading status badge (app/globals.css, max-width 480px),
  // so check the overview stats line there instead.
  if (isMobile) {
    await expect(page.getByText('sources in context')).toBeVisible();
  } else {
    await expect(page.getByText('Ready when you are')).toBeVisible();
  }
});

test('navigation reaches all four views', async ({ page }) => {
  for (const view of Object.keys(views) as (keyof typeof views)[]) {
    await open(page, view);
    await expect(page.locator('.breadcrumb strong')).toHaveText(view);
  }
});

test('commitment tabs switch', async ({ page }) => {
  await open(page, 'Commitments');
  const tabs = page.getByRole('tablist', { name: 'Commitment status' });
  await expect(tabs.getByRole('tab', { name: /^Now/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // Base UI keeps the leaving panel in the DOM (inert) during its exit
  // transition, so address each panel by the name its tab gives it.
  const panel = (name: RegExp) => page.getByRole('tabpanel', { name });
  await expect(panel(/^Now/)).toContainText('Make one deliberate choice');
  await tabs.getByRole('tab', { name: /^To decide/ }).click();
  await expect(panel(/^To decide/)).toContainText(candidate.title);
  await tabs.getByRole('tab', { name: /^Later/ }).click();
  await expect(panel(/^Later/)).toContainText('Nothing later yet');
});

test('New outcome opens the dialog and Cancel closes it', async ({ page }) => {
  await open(page, 'Commitments');
  await page.getByRole('button', { name: 'New outcome' }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose an outcome' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
});

test('library search finds the seeded source and a nonsense query shows the empty state', async ({
  page,
}) => {
  await open(page, 'Context library');
  const search = page.getByLabel('Search stored context');
  const table = page.getByRole('table', { name: 'Stored source material' });
  await search.fill('Orchard');
  await expect(
    table.getByRole('button', { name: fireflies.title, exact: true }),
  ).toBeVisible();
  await expect(table.getByRole('row')).toHaveCount(2);
  await search.fill('zxqvbnmplokij');
  await expect(page.getByText('No matching context')).toBeVisible();
  await expect(
    table.getByRole('button', { name: fireflies.title, exact: true }),
  ).toBeHidden();
});

test('opening a source shows the source dialog', async ({ page }) => {
  await open(page, 'Context library');
  await page.getByRole('button', { name: `Open ${fireflies.title}` }).click();
  const dialog = page.getByRole('dialog', { name: fireflies.title });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Fireflies')).toBeVisible();
  await expect(dialog).toContainText('billing migration');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
});

test('the Gmail Connect button opens its dialog and Cancel closes it', async ({
  page,
}) => {
  await open(page, 'Connections');
  await page.getByRole('button', { name: 'Connect gmail' }).click();
  const dialog = page.getByRole('dialog', { name: 'Gmail settings' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
});

test('on mobile the sidebar trigger opens navigation', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'The sidebar is always visible on a desktop viewport');
  await page.getByRole('button', { name: 'Toggle Sidebar' }).click();
  const sheet = page.getByRole('dialog', { name: 'Sidebar' });
  await expect(sheet).toBeVisible();
  for (const view of Object.keys(views)) {
    await expect(
      sheet.getByRole('button', { name: view, exact: true }),
    ).toBeVisible();
  }
  await sheet.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(heading(page, views.Connections)).toBeVisible();
});
