import { test, expect } from '@playwright/test';

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' });
});

for (const provider of ['fireflies', 'granola']) {
  test(`${provider} offers automatic sync status and an immediate history rescan`, async ({
    page,
  }) => {
    const requested: any[] = [];
    let active = false;
    await page.route('**/api/state', async (route) => {
      const response = await route.fetch(),
        state = await response.json();
      state.connections[provider].configured = true;
      state.worker = { ...state.worker, mode: 'cloud' };
      state.sync = active
        ? [
            {
              id: provider + '-fixture',
              provider,
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
      await route.fulfill({ status: 202, json: { id: provider + '-fixture' } });
    });
    await page.goto('/#connections');
    const connection = page.locator('.connection-row').filter({
      has: page.getByRole('heading', { name: new RegExp(provider, 'i') }),
    });
    await expect(
      connection.getByText(/Automatically checks every five minutes/),
    ).toBeVisible();
    await expect(
      connection.getByText(
        provider === 'fireflies'
          ? /seven-day overlap/
          : /older meetings shared with you/,
      ),
    ).toBeVisible();
    await connection
      .getByRole('button', { name: 'Refresh', exact: true })
      .click();
    expect(requested).toEqual([{ provider, rescan: false }]);
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
    expect(requested[1]).toEqual({ provider, rescan: true });
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
}

test('Granola settings add a workspace without replacing an existing connection', async ({
  page,
}) => {
  const saved: any[] = [];
  await page.route('**/api/state', async (route) => {
    const response = await route.fetch(),
      state = await response.json();
    state.connections.granola = {
      configured: true,
      workspaces: [
        { id: 'default', label: 'Personal' },
        { id: 'team', label: 'Revamp' },
      ],
    };
    await route.fulfill({ json: state });
  });
  await page.route('**/api/connections', async (route) => {
    saved.push(route.request().postDataJSON());
    await route.fulfill({ json: {} });
  });
  await page.goto('/#connections');
  await expect(
    page.getByText('Personal · Revamp', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Settings for granola' }).click();
  await expect(
    page.getByRole('combobox', { name: 'Workspace connection' }),
  ).toHaveText('Add another workspace');
  await page
    .getByRole('textbox', { name: 'Workspace name', exact: true })
    .fill('Another team');
  await page
    .getByLabel('API key', { exact: true })
    .fill('fictional-new-team-key');
  await page.getByRole('button', { name: 'Save connection' }).click();
  expect(saved[0]).toEqual({
    granola_workspace: { label: 'Another team', key: 'fictional-new-team-key' },
  });
  await page.getByRole('button', { name: 'Settings for granola' }).click();
  await page.getByRole('combobox', { name: 'Workspace connection' }).click();
  await page.getByRole('option', { name: 'Revamp', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: 'Workspace name', exact: true }),
  ).toHaveValue('Revamp');
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
  await page
    .getByLabel('API key', { exact: true })
    .fill('fictional-rotated-key');
  await page.getByRole('button', { name: 'Save connection' }).click();
  expect(saved[1]).toEqual({
    granola_workspace: {
      id: 'team',
      label: 'Revamp',
      key: 'fictional-rotated-key',
    },
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
