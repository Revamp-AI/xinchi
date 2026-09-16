import {expect,test} from '@playwright/test';
test.skip(process.env.FOCUS_E2E_DURABLE !== '1','Dedicated disposable-database Workflow check');
test('manual upload runs through compiled Workflow steps, then extraction, with no model invocation',async({page,request})=>{
 test.setTimeout(120000);
 await page.goto('/');
 await page.getByRole('button',{name:'Context library',exact:true}).click();
 const records=Array.from({length:3},(_,i)=>({provider:'manual',external_id:'workflow-e2e-'+i,title:'Workflow fixture '+i,body:'Fictional import evidence '+i,coverage:'document'}));
 await page.locator('input[type=file]').setInputFiles({name:'workflow-fixtures.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(records))});
 await expect(page.getByRole('heading',{name:'Your connections',exact:true})).toBeVisible();
 let imported:any;
 await expect.poll(async()=>{const state=await (await request.get('/api/state')).json();imported=state.sync.find((r:any)=>r.provider==='manual');return imported?.state;},{timeout:60000}).toBe('complete');
 expect(imported.imported).toBe(3);
 const dispatch=await request.get('/api/internal/jobs',{headers:{Authorization:'Bearer fictional-e2e-cron'}});expect(dispatch.status()).toBe(200);
 const pg=(await import('pg')).default;
 const url=new URL(process.env.DATABASE_URL!);expect(['127.0.0.1','localhost']).toContain(url.hostname);
 const db=new pg.Client({connectionString:url.href});await db.connect();
 try{
  await expect.poll(async()=>{const r=await db.query("SELECT state FROM contact_runs ORDER BY started_at DESC LIMIT 1");return r.rows[0]?.state;},{timeout:60000}).toBe('complete');
  const persisted=await db.query("SELECT kind,workflow_id,revision,completed FROM durable_runs ORDER BY kind");expect(persisted.rows).toHaveLength(2);expect(persisted.rows.every((r:any)=>r.workflow_id&&r.completed&&r.revision>0)).toBe(true);
  expect((await db.query("SELECT count(*) AS n FROM sources WHERE external_id LIKE 'workflow-e2e-%'")).rows[0].n).toBe('3');
  expect((await db.query('SELECT count(*) AS n FROM import_chunks')).rows[0].n).toBe('0');
  expect((await db.query('SELECT count(*) AS n FROM jobs')).rows[0].n).toBe('1');
  expect((await db.query("SELECT value FROM settings WHERE key='pending_import_review'")).rows[0]?.value).toBeTruthy();
 }finally{await db.end();}
});
