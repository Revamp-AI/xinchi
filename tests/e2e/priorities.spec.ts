import { expect, test } from '@playwright/test';
import { one, run, stamp, upsertSource } from '../../lib/db.mjs';
import {
  savePriority,
  priorityDetail,
  prioritiesState,
} from '../../lib/priorities.mjs';
import { saveResult } from '../../lib/agent.mjs';

test.afterEach(async () => {
  await run(
    "UPDATE jobs SET status='complete',progress='Fixture finished' WHERE id='priorities-e2e-blocker'",
  );
  await run('UPDATE review_queue SET completed=true,job_id=NULL');
});

test('priorities keep manual order, enrich from meetings, and connect the overview on desktop and mobile', async ({
  page,
}, info) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await run(
    'TRUNCATE priority_updates,priority_suggestions,priorities CASCADE',
  );
  await run(
    "UPDATE priority_stacks SET position=CASE id WHEN 'deal-flow' THEN 0 WHEN 'product' THEN 1 ELSE 2 END",
  );
  // Hold model work in the isolated test database: browser tests never use real AI.
  await run(
    "INSERT INTO jobs(id,kind,status,prompt,created_at,updated_at,lease_owner,lease_until) VALUES('priorities-e2e-blocker','review','running','Fictional held review',?,?,'fixture',now()+interval '1 hour') ON CONFLICT(id) DO UPDATE SET status='running',lease_until=now()+interval '1 hour'",
    stamp(),
    stamp(),
  );
  const birch = await savePriority({
    title: 'Birch expansion',
    stack_id: 'deal-flow',
    owner: 'Priya Shah',
    financials: '$120,000 potential ARR',
  });
  await savePriority({
    title: 'Meeting-to-priority linking',
    stack_id: 'product',
    owner: 'Alex',
    next_decision: 'Confirm the first release scope',
  });
  await savePriority({
    title: 'Launch positioning',
    stack_id: 'go-to-market',
    owner: 'Alex',
    next_decision: 'Choose the core message',
  });
  await page.goto('/#priorities');
  await expect(
    page.getByRole('heading', { name: 'Priorities', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'New priority', exact: true }).click();
  let form = page.getByRole('dialog', { name: 'Add a priority', exact: true });
  await form.getByLabel('Title', { exact: true }).fill('Atlas pilot');
  await form.getByLabel('Owner', { exact: true }).click();
  await page.getByRole('option', { name: 'Priya Shah', exact: true }).click();
  await form.getByLabel('Financials').fill('$48,000 potential ARR');
  await form
    .getByLabel('Next decision', { exact: true })
    .fill('Confirm pilot scope');
  await form.getByLabel('Names & keywords').fill('Atlas');
  await form
    .getByRole('button', { name: 'Save priority', exact: true })
    .click();
  let panel = page.getByRole('dialog', { name: 'Atlas pilot', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Priya Shah');
  await panel
    .getByRole('button', { name: 'Close priority', exact: true })
    .click();
  await expect(panel).toBeHidden();
  const stack = page.getByRole('region', {
    name: 'Deal flow stack',
    exact: true,
  });
  const atlas = await one("SELECT * FROM priorities WHERE title='Atlas pilot'");
  // Keyboard sorting is available from the drag handle, including on touch layouts.
  await stack
    .getByRole('button', { name: 'Reorder Atlas pilot', exact: true })
    .focus();
  const handle = stack.getByRole('button', {
    name: 'Reorder Atlas pilot',
    exact: true,
  });
  await expect(handle).toBeFocused();
  await page.keyboard.press('Space');
  await expect(handle).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.keyboard.press('ArrowUp');
  await expect(
    stack.getByTestId('priority-card').filter({ hasText: 'Atlas pilot' }),
  ).toHaveAttribute('style', /translate3d\(0px, -/);
  await expect
    .poll(async () =>
      (await page.locator('[id^=DndLiveRegion]').allTextContents()).join(' '),
    )
    .toContain('over droppable area ' + birch.id);
  await page.keyboard.press('Space');
  await expect(stack.getByTestId('priority-card').first()).toContainText(
    'Atlas pilot',
  );
  await expect
    .poll(async () =>
      (await prioritiesState()).items
        .filter((p) => p.stack_id === 'deal-flow')
        .map((p) => p.id),
    )
    .toEqual([atlas.id, birch.id]);
  await page.reload();
  await expect(stack.getByTestId('priority-card').first()).toContainText(
    'Atlas pilot',
  );
  if (info.project.name === 'desktop-chromium') {
    const dragHandle = stack.getByRole('button', {
      name: 'Reorder Atlas pilot',
      exact: true,
    });
    const from = await dragHandle.boundingBox();
    const target = await stack
      .getByTestId('priority-card')
      .filter({ hasText: 'Birch expansion' })
      .boundingBox();
    expect(from).toBeTruthy();
    expect(target).toBeTruthy();
    await page.mouse.move(
      from!.x + from!.width / 2,
      from!.y + from!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      from!.x + from!.width / 2,
      from!.y + from!.height / 2 + 12,
      { steps: 3 },
    );
    await expect(dragHandle).toHaveAttribute('aria-pressed', 'true');
    await page.mouse.move(
      from!.x + from!.width / 2,
      target!.y + target!.height / 2,
      { steps: 10 },
    );
    await expect
      .poll(async () =>
        (await page.locator('[id^=DndLiveRegion]').allTextContents()).join(' '),
      )
      .toContain('over droppable area ' + birch.id);
    await page.mouse.up();
    await expect(stack.getByTestId('priority-card').first()).toContainText(
      'Birch expansion',
    );
    await stack
      .getByRole('button', { name: 'Move Atlas pilot up', exact: true })
      .click();
    await expect(stack.getByTestId('priority-card').first()).toContainText(
      'Atlas pilot',
    );
  }
  // A background review saves exact evidence; the manual next decision remains unchanged.
  const body =
    'Atlas pilot scope is agreed. Priya needs to approve pricing and success criteria.';
  const source = await upsertSource({
    provider: 'granola',
    external_id: 'priority-browser-' + info.project.name,
    title: 'Commercial sync',
    body,
    occurred_at: stamp(),
    coverage: 'summary',
  });
  const job = 'priorities-e2e-blocker';
  await saveResult(job, {
    brief: 'Pilot context updated.',
    findings: [],
    proposals: [],
    questions: [],
    coverage_note: 'One meeting.',
    priority_updates: [
      {
        priority_id: atlas.id,
        summary:
          'Pilot scope agreed; pricing and success criteria need a decision.',
        next_decision: 'Approve the pilot terms',
        suggested_rank: null,
        reason: 'Commercial sync identified the next decision.',
        citations: [{ source_id: source.id, quote: body }],
      },
    ],
  });
  await run(
    "UPDATE jobs SET status='running',lease_until=now()+interval '1 hour' WHERE id=?",
    job,
  );
  await expect(stack.getByTestId('priority-card').first()).toContainText(
    '1 suggestion',
  );
  await page.screenshot({
    path: info.outputPath('priorities-stacks.png'),
    fullPage: true,
  });
  await stack.getByRole('button', { name: /Atlas pilot.*48,000/ }).click();
  panel = page.getByRole('dialog', { name: 'Atlas pilot', exact: true });
  await expect(panel).toContainText('Confirm pilot scope');
  await expect(panel).toContainText('Pilot scope agreed');
  await expect(
    panel.getByRole('button', { name: 'Apply update', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath('priority-detail.png'),
    fullPage: false,
    animations: 'disabled',
  });
  await panel
    .getByRole('button', { name: 'Apply update', exact: true })
    .click();
  await expect(
    panel.getByRole('button', { name: 'Apply update', exact: true }),
  ).toHaveCount(0);
  await expect(panel).toContainText('Approve the pilot terms');
  await panel
    .getByLabel('Add an update', { exact: true })
    .fill('Pricing was approved today. Scope is unchanged.');
  await panel.getByRole('button', { name: 'Save update', exact: true }).click();
  await expect(panel.getByLabel('Add an update', { exact: true })).toHaveValue(
    '',
  );
  await expect(panel).toContainText('Pricing was approved today.');
  await panel
    .getByRole('button', { name: 'Close priority', exact: true })
    .click();
  // A selected card has a uniform border, with no accent stripe on either edge.
  await stack.getByRole('button', { name: /Atlas pilot.*48,000/ }).click();
  const border = await stack
    .getByTestId('priority-card')
    .first()
    .evaluate((el) => {
      const c = getComputedStyle(el);
      return [
        c.borderLeftWidth,
        c.borderRightWidth,
        c.borderLeftColor,
        c.borderRightColor,
      ];
    });
  expect(border[0]).toBe(border[1]);
  expect(border[2]).toBe(border[3]);
  await panel
    .getByRole('button', { name: 'Commercial sync', exact: false })
    .first()
    .click();
  await expect(page.getByRole('dialog').last()).toContainText(body);
  await page.keyboard.press('Escape');
  await page.goto('/#agent');
  const overview = page.getByRole('region', {
    name: 'Priority overview',
    exact: true,
  });
  await expect(overview).toContainText('Atlas pilot');
  await overview.getByRole('button', { name: /Deal flow Atlas pilot/ }).click();
  await expect(
    page.getByRole('dialog', { name: 'Atlas pilot', exact: true }),
  ).toBeVisible();
  await panel
    .getByRole('button', { name: 'Close priority', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Product stack options', exact: true })
    .click();
  await page
    .getByRole('menuitem', { name: 'Move stack earlier', exact: true })
    .click();
  await expect
    .poll(async () => (await prioritiesState()).stacks[0].id)
    .toBe('product');
  await page.reload();
  await expect(page.locator('.priority-stack').first()).toHaveAttribute(
    'aria-label',
    'Product stack',
  );
  expect((await priorityDetail(atlas.id)).next_decision).toBe(
    'Approve the pilot terms',
  );
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({
    path: info.outputPath('priorities-dark.png'),
    fullPage: true,
  });
});
