import { expect, test, type Page } from '@playwright/test';
import { candidate, sources } from './global-setup';

// Sidebar label -> the h1 each view renders.
const views = {
  Overview: 'Your next move, clearer.',
  Commitments: 'Your commitments',
  'Context library': 'Context library',
  Connections: 'Your connections',
  Contacts: 'Your contacts',
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

test('navigation reaches all five views', async ({ page }) => {
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


test('contact profile, timeline, map and list work together', async ({ page }, testInfo) => {
  await open(page, 'Contacts');
  await page.getByRole('button', { name: 'New contact', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'New contact' });
  const name = 'Morgan ' + testInfo.project.name;
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByLabel('Email', { exact: true }).fill(testInfo.project.name + '@example.com');
  await dialog.getByRole('button', { name: 'Save contact' }).click();
  dialog = page.getByRole('dialog', { name, exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Log interaction' }).click();
  const log = page.getByRole('dialog', { name: 'Log an interaction' });
  await log.getByLabel('What happened?').fill('Reviewed the fictional product roadmap together.');
  await log.getByRole('button', { name: 'Save interaction' }).click();
  await expect(dialog).toContainText('A meaningful exchange is within');
  await expect(dialog).toContainText('Reviewed the fictional product roadmap together.');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const table = page.getByRole('table', { name: 'Contacts', exact: true });
  await expect(table.getByRole('button', { name: new RegExp(name) })).toBeVisible();
  await expect(table.getByRole('row').filter({ hasText: name })).toContainText('Active');
});


test('relationship map supports light, dark and narrow layouts', async ({page}, testInfo) => {
  await open(page,'Contacts');
  await expect(page.getByRole('button',{name:'Avery Chen, Active',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Change appearance'}).click();
  await page.getByRole('menuitemradio',{name:'Light',exact:true}).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  await page.screenshot({path:testInfo.outputPath('contacts-light.png'),fullPage:true});
  await page.getByRole('button',{name:'Change appearance'}).click();
  await page.getByRole('menuitemradio',{name:'Dark',exact:true}).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  await page.screenshot({path:testInfo.outputPath('contacts-dark.png'),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
test('other connections remain available while Gmail and another provider import',async({page})=>{
 let sync=[{id:'gmail-busy-fixture',provider:'gmail',state:'running',imported:20,changed:20,started_at:new Date().toISOString(),updated_at:new Date().toISOString(),message:'Fictional Gmail request in progress'}];
 const requested:string[]=[];
 await page.route('**/api/state',async route=>{
  const response=await route.fetch(),state=await response.json();
  for(const provider of ['gmail','fireflies','granola'])state.connections[provider].configured=true;
  state.sync=sync;state.worker.mode='cloud';
  await route.fulfill({response,json:state});
 });
 await page.route('**/api/sync',async route=>{
  const {provider}=route.request().postDataJSON();requested.push(provider);
  const row={...sync[0],id:provider+'-busy-fixture',provider,state:'queued',imported:0,changed:0};sync=[row,...sync];
  await route.fulfill({status:202,json:{id:row.id}});
 });
 await page.goto('/');await open(page,'Connections');
 const connection=(name:string)=>page.locator('.connection-row').filter({has:page.getByRole('heading',{name:new RegExp('^'+name)})});
 await expect(connection('Gmail').getByRole('button',{name:/Importing$/})).toBeDisabled();
 await expect(connection('Fireflies').getByRole('button',{name:'Refresh',exact:true})).toBeEnabled();
 await expect(connection('Granola').getByRole('button',{name:'Refresh',exact:true})).toBeEnabled();
 await connection('Fireflies').getByRole('button',{name:'Refresh',exact:true}).click();
 await expect(connection('Fireflies').getByRole('button',{name:/Importing$/})).toBeDisabled();
 await expect(connection('Granola').getByRole('button',{name:'Refresh',exact:true})).toBeEnabled();
 await connection('Granola').getByRole('button',{name:'Refresh',exact:true}).click();
 await expect(connection('Granola').getByRole('button',{name:/Importing$/})).toBeDisabled();
 expect(requested).toEqual(['fireflies','granola']);
});
