import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { serializeAcrossProjects } from './cross-project-lock';

// The shortlist keeps at most ten pending suggestions for the whole workspace,
// so the other project's proposal fixtures would displace this file's.
serializeAcrossProjects('proposal-shortlist');

test('Commitments exposes pending proposals before any outcomes are saved', async ({
  page,
}, testInfo) => {
  const url = new URL(process.env.DATABASE_URL!);
  expect(['127.0.0.1', 'localhost']).toContain(url.hostname);
  const pg = (await import('pg')).default;
  const db = new pg.Client({ connectionString: url.href });
  await db.connect();
  const jobId = randomUUID();
  const ids: string[] = [randomUUID(), randomUUID()];
  const titles = [
    'Review the Orchard migration checklist',
    'Confirm the Orchard reporting date',
  ].map((title) => `${title} (${testInfo.project.name})`);
  try {
    const version = (
      await db.query(
        "SELECT id FROM source_versions WHERE source_id = 'fireflies:e2e-fireflies-1' LIMIT 1",
      )
    ).rows[0].id;
    const quote =
      'I will own the migration checklist and report back on Friday.';
    const timestamp = new Date().toISOString();
    await db.query(
      "INSERT INTO jobs(id, kind, status, prompt, created_at, updated_at) VALUES($1, 'review', 'complete', 'Fictional proposal review', $2, $2)",
      [jobId, timestamp],
    );
    for (const [i, id] of ids.entries()) {
      const payload = {
        title: titles[i],
        kind: 'action',
        rationale: 'Check the agreed follow-up.',
        done_when: 'The checklist has been reviewed.',
        next_action: 'Read the migration checklist.',
        existing_item_id: '',
        confidence: 'high',
        uncertainty: 'Confirm whether this is still open.',
        citations: [
          {
            source_id: 'fireflies:e2e-fireflies-1',
            source_version_id: version,
            quote,
          },
        ],
      };
      await db.query(
        'INSERT INTO proposals(id, job_id, fingerprint, payload, created_at) VALUES($1, $2, $1, $3, $4)',
        [id, jobId, JSON.stringify(payload), timestamp],
      );
    }
    // Isolate the visible workspace from other browser projects' fixtures.
    // Evidence, save, and dismiss still use the real authenticated API and database.
    await page.route('**/api/state', async (route) => {
      const response = await route.fetch();
      const state = await response.json();
      state.items = state.items.filter((item: { title: string }) =>
        titles.includes(item.title),
      );
      state.proposals = state.proposals.filter((proposal: { id: string }) =>
        ids.includes(proposal.id),
      );
      await route.fulfill({ response, json: state });
    });
    await page.goto('/#board');
    const queueTab = page.getByRole('tab', { name: /^To decide/ });
    const queue = page.getByRole('region', {
      name: 'Proposals awaiting your decision',
    });
    await expect(page.getByRole('tab', { name: /^Now/ })).toHaveText('Now0');
    await expect(queueTab).toHaveText('To decide2');
    await expect(
      page.getByText('2 proposals are ready for your decision'),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Review proposals', exact: true })
      .click();
    await expect(queue.locator('.decision-card')).toHaveCount(2);
    await expect(page.getByText('Nothing to decide yet')).toBeHidden();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath('commitment-proposals.png'),
      fullPage: true,
    });

    // Both entry points expose the same pending suggestions.
    await page.goto('/#agent');
    await expect(queue.locator('.decision-card')).toHaveCount(2);
    await page.goto('/#board');
    await queueTab.click();
    const first = queue
      .locator('.decision-card')
      .filter({ hasText: titles[0] });
    const evidenceResponse = page.waitForResponse((response) => {
      const target = new URL(response.url());
      return (
        target.pathname.startsWith('/api/sources/') &&
        target.searchParams.get('version') === version
      );
    });
    await first.getByRole('button', { name: 'Evidence', exact: true }).click();
    expect((await evidenceResponse).status()).toBe(200);
    const evidence = page.getByRole('dialog', { name: 'Orchard roadmap sync' });
    await expect(evidence).toContainText(quote);
    await evidence.getByRole('button', { name: 'Close', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: 'Choose an outcome' });
    await first.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(dialog.getByLabel('What is the outcome?')).toHaveValue(
      titles[0]!,
    );
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(
      (await db.query('SELECT status FROM proposals WHERE id = $1', [ids[0]]))
        .rows[0].status,
    ).toBe('pending');
    await expect(queueTab).toHaveText('To decide2');

    await first.getByRole('button', { name: 'Review', exact: true }).click();
    await dialog
      .getByRole('button', { name: 'Save decision', exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect(queue.locator('.decision-card')).toHaveCount(1);
    // One saved candidate plus one pending proposal still makes two decisions.
    await expect(queueTab).toHaveText('To decide2');
    const saved = (
      await db.query(
        'SELECT p.status, i.status AS item_status, i.source_version_id FROM proposals p JOIN items i ON p.item_id = i.id WHERE p.id = $1',
        [ids[0]],
      )
    ).rows[0];
    expect(saved).toEqual({
      status: 'accepted',
      item_status: 'candidate',
      source_version_id: version,
    });
    await expect(page.locator('.commitment-list')).toContainText(titles[0]!);

    await queue.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(queue).toBeHidden();
    await expect(queueTab).toHaveText('To decide1');
    expect(
      (await db.query('SELECT status FROM proposals WHERE id = $1', [ids[1]]))
        .rows[0].status,
    ).toBe('dismissed');
    await expect(page.locator('.commitment-list')).toContainText(titles[0]!);
  } finally {
    await db.end();
  }
});

test('Commitments shows an empty queue only when both candidates and proposals are absent', async ({
  page,
}) => {
  await page.route('**/api/state', async (route) => {
    const response = await route.fetch();
    const state = await response.json();
    await route.fulfill({
      response,
      json: { ...state, items: [], proposals: [] },
    });
  });
  await page.goto('/#board');
  await expect(
    page.getByRole('button', { name: 'Review proposals', exact: true }),
  ).toBeHidden();
  const tab = page.getByRole('tab', { name: /^To decide/ });
  await expect(tab).toHaveText('To decide0');
  await tab.click();
  await expect(page.getByText('Nothing to decide yet')).toBeVisible();
});

test('ranked shortlist keeps overflow accessible and lets the user restore removed suggestions', async ({ page }, testInfo) => {
  const url = new URL(process.env.DATABASE_URL!);
  expect(['127.0.0.1', 'localhost']).toContain(url.hostname);
  const pg = (await import('pg')).default;
  const db = new pg.Client({ connectionString: url.href });
  await db.connect();
  const job = randomUUID();
  const ids: string[] = Array.from({length: 12}, () => randomUUID());
  const titles = ids.map((_, i) => `Fictional customer promise ${i} (${testInfo.project.name})`);
  const errors: string[] = [];page.on('pageerror', error => errors.push(error.message));
  try {
    const version = (await db.query("SELECT id FROM source_versions WHERE source_id='fireflies:e2e-fireflies-1' LIMIT 1")).rows[0].id;
    await db.query("INSERT INTO jobs(id,kind,status,prompt,created_at,updated_at) VALUES($1,'review','complete','Fictional shortlist test',$2,$2)",[job,new Date().toISOString()]);
    for (const [i,id] of ids.entries()) {
      const payload = {title:titles[i],kind:'action',confidence:'high',rationale:'The owner explicitly promised this customer output.',done_when:'Delivered',next_action:'Draft it',existing_item_id:'',uncertainty:'',qualification:{basis:'verbal_promise',area:'customer',deliverable_key:id,owner_basis:'The owner spoke.',commitment_quote:'I will own the migration checklist and report back on Friday.',due_date:'',deadline_kind:'none',deadline_source_id:'',deadline_quote:''},citations:[{source_id:'fireflies:e2e-fireflies-1',source_version_id:version,quote:'I will own the migration checklist and report back on Friday.'}]};
      await db.query('INSERT INTO proposals(id,job_id,fingerprint,status,payload,created_at,priority_score) VALUES($1,$2,$1,$3,$4,$5,700)',[id,job,i<10?'pending':'deferred',JSON.stringify(payload),new Date(Date.now()-i*1000).toISOString()]);
    }
    await page.route('**/api/state',async route=>{
      const response=await route.fetch(),state=await response.json();
      for(const key of ['proposals','deferred_proposals'])state[key]=state[key].filter((p:{id:string})=>ids.includes(p.id));
      state.proposal_history=state.proposal_history.filter((e:{proposal_id:string})=>ids.includes(e.proposal_id));state.items=[];
      await route.fulfill({response,json:state});
    });
    await page.goto('/#board');await page.getByRole('tab',{name:/^To decide/}).click();
    const queue=page.getByRole('region',{name:'Proposals awaiting your decision'});
    await expect(queue.locator('.decision-card:visible')).toHaveCount(10);
    await expect(queue.getByText('Your verbal promise · Customer').first()).toBeVisible();
    await queue.getByText('For later · 2 suggestions').click();
    await expect(queue.locator('.decision-card:visible')).toHaveCount(12);
    await queue.getByText('For later · 2 suggestions').click();
    await queue.locator('.decision-card').filter({hasText:titles[0]}).getByRole('button',{name:'Dismiss',exact:true}).click();
    await expect(queue.locator('.decision-card:visible')).toHaveCount(10);
    await page.getByText('Recently removed · 1').click();
    await page.getByRole('button',{name:'Restore suggestion'}).click();
    await expect(queue.locator('.decision-card:visible')).toHaveCount(10);
    expect((await db.query('SELECT status FROM proposals WHERE id=$1',[ids[0]])).rows[0].status).toBe('pending');
    await page.goto('/#connections');await page.getByRole('button',{name:'Connect calendar',exact:true}).click();
    await expect(page.getByRole('dialog',{name:'Google Calendar settings'})).toContainText('read-only');
    await page.screenshot({path:testInfo.outputPath('calendar-connection.png')});
    expect(errors).toEqual([]);
  } finally { await db.query('DELETE FROM proposals WHERE id=ANY($1)',[ids]);await db.end(); }
});
