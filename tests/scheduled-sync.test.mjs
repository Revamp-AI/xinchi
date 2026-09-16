import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
process.env.XIN_ALLOWED_EMAIL='owner@example.com';process.env.XIN_AGENT_MODE='cloud';process.env.XIN_SECRET_STORAGE='postgres';process.env.XIN_SECRETS_KEY=randomBytes(32).toString('base64url');
const {scheduleProviderSyncs}=await import('../lib/scheduled-sync.mjs');
const {saveSecrets}=await import('../lib/secret-store.mjs');
const {startSync}=await import('../lib/connectors.mjs');
const {all,one,run,setSetting,getSetting}=await import('../lib/db.mjs');
const {prepareDispatches,advanceDurableUnit}=await import('../lib/durable-ingestion.mjs');
test.beforeEach(async()=>{await run('TRUNCATE durable_runs,sync_runs,contact_runs CASCADE');for(const k of ['granola_page','granola_since','fireflies_page','fireflies_sync'])await setSetting(k,null);await saveSecrets({granola_key:'fictional-key',fireflies_key:'fictional-key'});});
async function completed(provider,{minutes=10,full=true}={}){
 const id='previous-'+provider,finished=new Date(Date.now()-minutes*60000).toISOString();
 await run("INSERT INTO sync_runs(id,provider,state,started_at,updated_at,finished_at) VALUES(?,?,'complete',?,?,?)",id,provider,finished,finished,finished);
 await run("INSERT INTO durable_runs(kind,run_id,completed,cursor) VALUES('sync',?,true,?::jsonb)",id,JSON.stringify({phase:'done',since:full?null:finished,participant:'owner@example.com',rescan:full}));return id;
}
test('concurrent cron ticks create one import per configured provider, with no browser or HTTP calls',async t=>{
 t.mock.method(global,'fetch',()=>assert.fail('Scheduling must not call providers'));
 await Promise.all([scheduleProviderSyncs(),scheduleProviderSyncs(),scheduleProviderSyncs()]);const rows=await all("SELECT provider,count(*) AS n FROM sync_runs GROUP BY provider");assert.deepEqual(rows.sort((a,b)=>a.provider.localeCompare(b.provider)),[{provider:'fireflies',n:1},{provider:'granola',n:1}]);
 assert.equal((await getSetting('granola_page')).rescan,true);assert.equal((await getSetting('fireflies_page')).since,null);
});
test('busy and failed connections do not stall the other provider; only configured providers are scheduled',async()=>{
 await startSync('fireflies');assert.deepEqual((await scheduleProviderSyncs()).map(r=>r.provider),['granola']);
 await run('TRUNCATE durable_runs,sync_runs CASCADE');await saveSecrets({granola_key:'fictional-key'});assert.deepEqual((await scheduleProviderSyncs()).map(r=>r.provider),['granola']);
});
test('five-minute idle cadence and daily history checks are driven by completed imports',async()=>{
 await completed('granola',{minutes:1});await completed('fireflies',{minutes:1});assert.deepEqual(await scheduleProviderSyncs(),[]);
 await run("UPDATE sync_runs SET finished_at=(now()-interval '6 minutes')::text");let rows=await scheduleProviderSyncs();assert.equal(rows.length,2);assert.ok(rows.every(r=>r.rescan===false));
 await run("DELETE FROM sync_runs WHERE state='queued'");await run("UPDATE sync_runs SET finished_at=(now()-interval '25 hours')::text");rows=await scheduleProviderSyncs();assert.ok(rows.every(r=>r.rescan===true));
});
test('scheduled recovery resumes failed durable progress after backoff instead of starting over',async()=>{
 const {id}=await startSync('granola');await prepareDispatches();const cursor={v:1,provider:'granola',phase:'transcript',pendingIds:['saved'],parts:[{text:'Private saved fragment'}]};
 await run("UPDATE sync_runs SET state='failed',finished_at=(now()-interval '30 minutes')::text WHERE id=?",id);await run("UPDATE durable_runs SET cursor=?::jsonb,completed=true,outcome=?::jsonb WHERE run_id=?",JSON.stringify(cursor),JSON.stringify({failed:true}),id);
 assert.ok((await scheduleProviderSyncs()).every(r=>r.provider!=='granola'));
 await run("UPDATE sync_runs SET finished_at=(now()-interval '2 hours')::text WHERE id=?",id);const rows=await scheduleProviderSyncs();assert.equal(rows[0].id,id);assert.equal(rows[0].resumed,true);assert.deepEqual((await one('SELECT cursor FROM durable_runs WHERE run_id=?',id)).cursor,cursor);
 assert.equal((await one('SELECT count(*) AS n FROM sync_runs WHERE provider=?','granola')).n,1);
});
test('permanent errors back off for a day while another provider still schedules',async()=>{
 const id=await completed('granola',{minutes:120});await run("UPDATE sync_runs SET state='failed' WHERE id=?",id);await run("UPDATE durable_runs SET outcome=?::jsonb WHERE run_id=?",JSON.stringify({failed:true,permanent:true}),id);
 assert.deepEqual((await scheduleProviderSyncs()).map(r=>r.provider),['fireflies']);await run("UPDATE sync_runs SET finished_at=(now()-interval '25 hours')::text WHERE id=?",id);assert.equal((await scheduleProviderSyncs())[0].resumed,true);
});
test('an automatic full check cannot discard an existing pagination checkpoint',async()=>{
 const saved={cursor:'old-page',since:'2025-01-01',started:'2026-09-01'};await setSetting('granola_page',saved);const row=(await scheduleProviderSyncs()).find(r=>r.provider==='granola');assert.equal(row.rescan,false);assert.deepEqual(await getSetting('granola_page'),saved);
});
test('successive scheduled cycles automatically ingest a late shared meeting and queue contact extraction',async t=>{
 await saveSecrets({granola_key:'fictional-key'});let ready=false;
 t.mock.method(global,'fetch',async url=>{const u=new URL(url);assert.equal(u.searchParams.has('updated_after'),false);if(u.pathname==='/v1/notes')return Response.json({notes:ready?[{id:'automatic-late',updated_at:'2020-01-01'}]:[],hasMore:false});if(u.pathname.endsWith('/transcript'))return Response.json({transcript:[{text:'Fictional late shared meeting.'}],hasMore:false});return Response.json({id:'automatic-late',title:'Fictional automatic import',created_at:'2020-01-01',updated_at:'2020-01-01'});});
 async function tick(){const [queued]=await scheduleProviderSyncs();assert.equal(queued.provider,'granola');const dispatch=(await prepareDispatches()).find(r=>r.id===queued.id);let result={revision:0};for(let i=0;i<5;i++){result=await advanceDurableUnit('sync',queued.id,dispatch.token,'workflow-'+queued.id,result.revision);if(result.done)return queued.id;}assert.fail('Automatic import did not finish');}
 const first=await tick();assert.equal(await one("SELECT id FROM sources WHERE id='granola:automatic-late'"),undefined);
 await run("UPDATE sync_runs SET finished_at=(now()-interval '6 minutes')::text WHERE id=?",first);ready=true;await tick();assert.equal((await one("SELECT coverage FROM sources WHERE id='granola:automatic-late'")).coverage,'transcript');assert.ok(await one('SELECT id FROM contact_runs WHERE review_requested=true'));
});
