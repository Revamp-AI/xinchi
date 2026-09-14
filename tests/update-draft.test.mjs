import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const temp=mkdtempSync(join(tmpdir(),'xin-update-draft-test-'));process.env.XIN_DATA_DIR=temp;process.env.XIN_ALLOWED_EMAIL='owner@example.com';
const {buildUpdateDraft,renderUpdateDraft}=await import('../lib/update-draft.mjs');
const db=await import('../lib/db.mjs');
const auth=await import('../lib/auth.mjs');
const route=await import('../app/api/[...path]/route.js');
const {localToday}=await import('../lib/urgency.mjs');
const since='2026-09-07',today='2026-09-14';
const item=o=>({kind:'action',status:'candidate',done_when:'',next_action:'',owner:'You',checkpoint:'',hard_deadline:'',dependency:'',evidence:'',reason:'',shared:1,updated_at:'2026-09-10T09:00:00.000Z',...o});
const items=[
 item({id:'a',title:'Ship the onboarding checklist',status:'done',evidence:'Checklist published to the shared drive.'}),
 item({id:'b',title:'Private cleanup',status:'done',evidence:'Done quietly.',shared:0}),
 item({id:'c',title:'Old finish',status:'done',evidence:'Finished earlier.',updated_at:'2026-09-06T23:59:59.000Z'}),
 item({id:'d',title:'Boundary finish',status:'done',evidence:'Finished on the boundary.',updated_at:'2026-09-07T00:00:00.000Z'}),
 item({id:'e',title:'Draft the pricing memo',status:'now',done_when:'A one-page memo',next_action:'Collect the three quotes',checkpoint:'2026-09-18',hard_deadline:'2026-09-30'}),
 item({id:'f',title:'Vendor contract',status:'waiting',dependency:'Legal review',checkpoint:'2026-09-16',last_action:'Sent the redline'}),
 item({id:'g',title:'Choose the launch week',kind:'decision',status:'candidate',next_action:'Compare the two weeks'}),
 item({id:'h',title:'Pick the analytics vendor',kind:'decision',status:'now',done_when:'A signed order',next_action:'Score the finalists',checkpoint:'2026-09-20'}),
 item({id:'i',title:'Hidden decision',kind:'decision',status:'candidate',shared:0}),
 item({id:'j',title:'Venue booking',status:'waiting',dependency:'Venue confirmation',checkpoint:'2026-09-22'}),
 item({id:'k',title:'Private wait',status:'waiting',dependency:'A friend',checkpoint:'2026-09-22',shared:0}),
 item({id:'l',title:'Private now',status:'now',done_when:'x',next_action:'y',checkpoint:'2026-09-22',shared:0}),
];
const ev=o=>({id:o.id,item_id:o.item_id,action:'updated',before_json:o.before?JSON.stringify(o.before):null,after_json:JSON.stringify(o.after),reason:o.reason||'',created_at:o.at});
const base={status:'now',checkpoint:'2026-09-12',done_when:'A one-page memo',owner:'You'};
const events=[
 ev({id:'e1',item_id:'e',before:{...base,status:'candidate',checkpoint:'',done_when:''},after:{...base,checkpoint:'2026-09-18'},at:'2026-09-08T10:00:00.000Z'}),
 ev({id:'e2',item_id:'a',before:base,after:{...base,status:'done'},at:'2026-09-10T09:00:00.000Z'}),
 ev({id:'e3',item_id:'f',before:{...base,status:'waiting'},after:{...base,status:'waiting',checkpoint:'2026-09-16'},reason:'Legal asked for a week',at:'2026-09-11T10:00:00.000Z'}),
 ev({id:'e4',item_id:'b',before:base,after:{...base,status:'later'},at:'2026-09-11T11:00:00.000Z'}),
 ev({id:'e5',item_id:'e',before:null,after:base,at:'2026-09-11T12:00:00.000Z'}),
 ev({id:'e6',item_id:'h',before:{...base,status:'candidate'},after:base,at:'2026-09-06T12:00:00.000Z'}),
 ev({id:'e7',item_id:'f',before:{...base,status:'waiting'},after:{...base,status:'waiting',owner:'Someone else'},at:'2026-09-12T10:00:00.000Z'}),
 ev({id:'e8',item_id:'e',before:{...base,done_when:'A memo'},after:base,at:'2026-09-07T00:00:00.000Z'}),
];
const draft=buildUpdateDraft({items,events,since,today});
test('only shared commitments reach the draft',async()=>{
 const ids=[...draft.completed,...draft.next,...draft.needs].map(r=>r.id);
 for(const hidden of ['b','i','k','l'])assert.ok(!ids.includes(hidden),hidden);
 assert.ok(!draft.changed.some(c=>c.id==='e4'));
 assert.equal(draft.since,since);assert.equal(draft.today,today);
});
test('completed lists shared done items from the since boundary onward',async()=>{
 assert.deepEqual(draft.completed.map(r=>r.id),['a','d']);
 assert.deepEqual(draft.completed[0],{id:'a',title:'Ship the onboarding checklist',evidence:'Checklist published to the shared drive.',at:'2026-09-10T09:00:00.000Z'});
});
test('changed reports status, checkpoint, and scope moves but not completions',async()=>{
 assert.deepEqual(draft.changed.map(c=>c.id+':'+c.what),['e1:status','e1:checkpoint','e1:scope','e3:checkpoint','e8:scope']);
 assert.deepEqual(draft.changed[3],{id:'e3',title:'Vendor contract',what:'checkpoint',from:'2026-09-12',to:'2026-09-16',reason:'Legal asked for a week',at:'2026-09-11T10:00:00.000Z'});
 assert.deepEqual(draft.changed[0],{id:'e1',title:'Draft the pricing memo',what:'status',from:'candidate',to:'now',reason:'',at:'2026-09-08T10:00:00.000Z'});
 assert.ok(!draft.changed.some(c=>['e2','e5','e6','e7'].includes(c.id)));
});
test('next lists active shared outcomes',async()=>{
 assert.deepEqual(draft.next.map(r=>r.id),['e','h']);
 assert.deepEqual(draft.next[0],{id:'e',title:'Draft the pricing memo',done_when:'A one-page memo',next_action:'Collect the three quotes',checkpoint:'2026-09-18',hard_deadline:'2026-09-30'});
});
test('needs lists waiting items and open decisions',async()=>{
 assert.deepEqual(draft.needs.map(r=>r.id),['f','j','g','h']);
 assert.deepEqual(draft.needs[0],{id:'f',title:'Vendor contract',dependency:'Legal review',checkpoint:'2026-09-16',last_action:'Sent the redline'});
 assert.deepEqual(draft.needs[1],{id:'j',title:'Venue booking',dependency:'Venue confirmation',checkpoint:'2026-09-22',last_action:''});
 assert.deepEqual(draft.needs[2],{id:'g',title:'Choose the launch week',next_action:'Compare the two weeks'});
});
test('markdown has the four headings in order, day-only dates, and no names',async()=>{
 const text=renderUpdateDraft(draft);
 assert.deepEqual(text.match(/^#+ .*$/gm),['## Completed','## Changed','## Next','## Need from you']);
 assert.match(text,/Ship the onboarding checklist/);assert.match(text,/2026-09-10/);assert.ok(!text.includes('2026-09-10T'));
 assert.match(text,/Legal asked for a week/);assert.match(text,/waiting on Legal review/);assert.match(text,/Compare the two weeks/);
 assert.ok(!text.includes('Nothing to report.'));assert.ok(!text.includes('Someone else'));
 assert.match(text,/2026-09-14/);assert.match(text,/2026-09-07/);
});
test('empty sections say so and keep the structure',async()=>{
 const text=renderUpdateDraft(buildUpdateDraft({items:[],events:[],since,today}));
 assert.deepEqual(text.match(/^#+ .*$/gm),['## Completed','## Changed','## Next','## Need from you']);
 assert.equal(text.match(/Nothing to report\./g).length,4);
 assert.match(text,/## Need from you\nNothing to report\.\n?$/);
});
const token='u'.repeat(43);
const get=(path,cookie='')=>route.GET(new Request(auth.APP_ORIGIN+'/api/'+path,{headers:{host:'127.0.0.1:3210',...(cookie?{cookie:auth.SESSION_COOKIE+'='+cookie}:{})}}));
test('the update-draft path is in the protected GET list and rejects anonymous callers',async()=>{
 const line=readFileSync(new URL('./auth.test.mjs',import.meta.url),'utf8').split('\n').find(l=>l.includes('route.GET(req(p))'));
 assert.ok(line&&line.includes("'update-draft'"));
 assert.equal((await get('update-draft')).status,401);
});
test('GET update-draft builds the window from the database for the signed-in owner',async()=>{
 (await auth.authDb.prepare('INSERT INTO owner VALUES(1,?,?,?)').run('google-owner-1','owner@example.com','Owner'));
 (await auth.authDb.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update(token).digest('hex'),'google-owner-1',Date.now(),Date.now()+3600000));
 const a=(await db.saveItem({title:'Ship the onboarding checklist',status:'now',done_when:'Checklist live',next_action:'Publish it',owner:'You',checkpoint:'2026-09-18',shared:true}));
 (await db.saveItem({...a,status:'done',evidence:'Checklist published.'}));
 const w=(await db.saveItem({title:'Vendor contract',status:'waiting',dependency:'Legal review',checkpoint:'2026-09-16',shared:true}));
 (await db.saveItem({...w,checkpoint:'2026-09-23',reason:'Legal asked for a week'}));
 (await db.saveItem({title:'Private task',status:'now',done_when:'x',next_action:'y',owner:'You',checkpoint:'2026-09-18'}));
 const r=await get('update-draft',token);assert.equal(r.status,200);const body=await r.json();
 const n=new Date();assert.equal(body.since,localToday(new Date(n.getFullYear(),n.getMonth(),n.getDate()-7)));assert.equal(body.draft.today,localToday());
 assert.deepEqual(body.draft.completed.map(x=>x.title),['Ship the onboarding checklist']);
 assert.deepEqual(body.draft.changed.map(x=>x.title+':'+x.what+':'+x.reason),['Vendor contract:checkpoint:Legal asked for a week']);
 assert.deepEqual(body.draft.next,[]);assert.deepEqual(body.draft.needs.map(x=>x.title),['Vendor contract']);
 assert.deepEqual(body.text.match(/^#+ .*$/gm),['## Completed','## Changed','## Next','## Need from you']);
 assert.equal((await (await get('update-draft?since=2026-01-01',token)).json()).since,'2026-01-01');
 assert.equal((await get('update-draft?since=yesterday',token)).status,400);
 const future=(await (await get('update-draft?since=2999-01-01',token)).json()).draft;assert.deepEqual([future.completed,future.changed],[[],[]]);
});
test('GET update-draft rejects overflow and out-of-range dates',async()=>{
 for(const bad of ['2026-02-30','2026-13-01']){const r=await get('update-draft?since='+bad,token);assert.equal(r.status,400,bad);assert.deepEqual(await r.json(),{error:'Choose a valid date.'},bad);}
});
test.after(async ()=>{(await auth.authDb.close());(await db.db.close());rmSync(temp,{recursive:true,force:true});});
