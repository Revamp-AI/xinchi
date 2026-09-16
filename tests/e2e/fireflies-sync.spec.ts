import { test, expect } from '@playwright/test';

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' });
});

test('Fireflies refresh is incremental and history rescan is an explicit separate action', async ({
  page,
}) => {
  const requested: any[] = [];
  let active = false;
  await page.route('**/api/state', async (route) => {
    const response = await route.fetch(),
      state = await response.json();
    state.connections.fireflies.configured = true;
    state.sync = active
      ? [
          {
            id: 'fireflies-fixture',
            provider: 'fireflies',
            state: 'running',
            imported: 0,
            changed: 0,
            started_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            message: 'Syncing recent Fireflies transcripts',
          },
        ]
      : [];
    await route.fulfill({ json: state });
  });
  await page.route('**/api/sync', async (route) => {
    requested.push(route.request().postDataJSON());
    active = true;
    await route.fulfill({ status: 202, json: { id: 'fireflies-fixture' } });
  });
  await page.goto('/#connections');
  const connection = page
    .locator('.connection-row')
    .filter({ has: page.getByRole('heading', { name: /^Fireflies/ }) });
  await expect(connection.getByText(/seven-day overlap/)).toBeVisible();
  await connection
    .getByRole('button', { name: 'Refresh', exact: true })
    .click();
  expect(requested).toEqual([{ provider: 'fireflies', rescan: false }]);
  await expect(
    connection.getByRole('button', { name: /Importing/ }),
  ).toBeVisible();
  await expect(
    connection.getByRole('button', { name: 'Rescan history' }),
  ).toBeDisabled();
  active = false;
  await expect(
    connection.getByRole('button', { name: 'Rescan history' }),
  ).toBeEnabled();
  await connection.getByRole('button', { name: 'Rescan history' }).click();
  expect(requested[1]).toEqual({ provider: 'fireflies', rescan: true });
  await expect(
    page.getByText('History rescan started. Progress appears below.'),
  ).toBeVisible();
  await expect(
    connection.getByRole('button', { name: /Importing/ }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
