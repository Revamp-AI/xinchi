import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const privateDir=mkdtempSync(join(tmpdir(),'focus-durable-'));process.env.XIN_DATA_DIR=privateDir;process.env.XIN_AGENT_MODE='cloud';
const {one,run,uid,stamp,upsertSource,getSetting,setSetting}=await import('../lib/db.mjs');
const {prepareDispatches,acknowledgeDispatch,advanceDurableUnit,resumeDurable,failDurableRun}=await import('../lib/durable-ingestion.mjs');
const {expireLeases,claimLease,heartbeatLease}=await import('../lib/leases.mjs');
const {reconcileWorkflows}=await import('../lib/workflow-recovery.mjs');
const {createManualUpload,appendManualChunk,finishManualUpload}=await import('../lib/manual-ingestion.mjs');
async function queued(provider='fireflies'){await run("UPDATE sync_runs SET state='complete' WHERE state IN ('queued','running','uploading')");await run("UPDATE contact_runs SET state='complete' WHERE state IN ('queued','running')");const id=uid();await run("INSERT INTO sync_runs(id,provider,state,started_at,updated_at) VALUES(?,?,'queued',?,?)",id,provider,stamp(),stamp());const rows=await prepareDispatches(),row=rows.find(r=>r.id===id);return{...row,wf:'wf-'+id};}
const unit=(row,revision,adapters)=>advanceDurableUnit('sync',row.id,row.token,row.wf,revision,adapters);
test('a replay after the database commit returns the saved revision without repeating provider work',async()=>{
 const row=await queued();let calls=0;const adapters={initial:async()=>({n:0}),advance:async()=>{calls++;return{cursor:{n:1},records:[{doc:{provider:'fireflies',external_id:row.id,title:'Fictional source',body:'Exact fictional evidence',coverage:'transcript'},raw:{fixture:true}}],complete:true};}};
 const first=await unit(row,0,adapters),replay=await unit(row,0,adapters);assert.deepEqual(replay,first);assert.equal(calls,1);
 assert.equal((await one('SELECT imported,changed FROM sync_runs WHERE id=?',row.id)).imported,1);assert.equal((await one('SELECT count(*) AS n FROM source_versions WHERE source_id=?','fireflies:'+row.id)).n,1);
 assert.equal(JSON.stringify(first).includes('fictional'),false);
});
test('a lost dispatch acknowledgement admits only one workflow owner',async()=>{
 const row=await queued();const adapters={initial:async()=>({n:0}),advance:async()=>({cursor:{n:1},records:[],complete:false})};
 await unit(row,0,adapters);await acknowledgeDispatch('sync',row.id,row.token,'duplicate');
 const ignored=await advanceDurableUnit('sync',row.id,row.token,'duplicate',1,{advance:async()=>{throw Error('Must not run');}});assert.equal(ignored.done,true);assert.equal((await one('SELECT workflow_id FROM durable_runs WHERE run_id=?',row.id)).workflow_id,row.wf);
});
test('an interrupted unit resumes after its lease expires and late workers cannot commit',async()=>{
 const row=await queued();let release;const paused=new Promise(resolve=>{release=resolve;});let started;const ready=new Promise(resolve=>{started=resolve;});
 const first=unit(row,0,{initial:async()=>({n:0}),advance:async()=>{started();await paused;return{cursor:{n:99},records:[{doc:{provider:'fireflies',external_id:'late-'+row.id,title:'Must not persist',body:'Stale data'},raw:{}}],complete:false};}});
 await ready;const waiting=await unit(row,0,{});assert.ok(waiting.waitMs>0);
 await run("UPDATE durable_runs SET unit_until=now()-interval '1 second' WHERE run_id=?",row.id);
 const resumed=await unit(row,0,{initial:async()=>({n:0}),advance:async()=>({cursor:{n:1},records:[],complete:true})});release();await first;
 assert.equal(resumed.done,true);assert.equal(await one('SELECT id FROM sources WHERE id=?','fireflies:late-'+row.id),undefined);
});
test('transient errors suspend without exposing provider contents and sleeping workflows do not expire',async()=>{
 const row=await queued();const result=await unit(row,0,{initial:async()=>({n:0}),advance:async()=>{throw Object.assign(Error('secret response'),{retryAfterMs:120000});}});
 assert.equal(result.waitMs,120000);assert.equal(result.done,false);await run("UPDATE sync_runs SET updated_at='2020-01-01T00:00:00Z' WHERE id=?",row.id);await expireLeases('sync_runs');
 const saved=await one('SELECT state,message FROM sync_runs WHERE id=?',row.id);assert.equal(saved.state,'running');assert.ok(!saved.message.includes('secret'));
});
test('failed imports resume the saved cursor with a new workflow owner',async()=>{
 const row=await queued();await unit(row,0,{initial:async()=>({n:0}),advance:async()=>({cursor:{n:7},records:[],complete:false})});
 await unit(row,1,{advance:async()=>{throw Object.assign(Error('Provider auth required'),{permanent:true,ingestionProviderError:true});}});
 await resumeDurable('sync',row.id,'fireflies');const next=(await prepareDispatches()).find(r=>r.id===row.id);assert.notEqual(next.token,row.token);
 const current=await advanceDurableUnit('sync',row.id,next.token,'new-workflow',0,{});assert.equal(current.done,false);assert.equal(current.revision,2);
 await advanceDurableUnit('sync',row.id,next.token,'new-workflow',2,{advance:async(_provider,cursor)=>{assert.equal(cursor.n,7);return{cursor,records:[],complete:true};}});
 assert.equal((await one('SELECT state FROM sync_runs WHERE id=?',row.id)).state,'complete');
});
test('manual archives stage first, ingest one record per step, and clean temporary payloads on completion',async()=>{
 await run("UPDATE sync_runs SET state='complete' WHERE state IN ('queued','running','uploading')");
 const content=JSON.stringify([{external_id:'durable-file-1',title:'First fictional record',body:'One'},{external_id:'durable-file-2',title:'Second fictional record',body:'Two'}]);
 const {id}=await createManualUpload({format:'json',title:'fictional.json',bytes:Buffer.byteLength(content)});await appendManualChunk({id,part:0,content});await finishManualUpload({id,parts:1});
 const row=(await prepareDispatches()).find(r=>r.id===id);row.wf='manual-workflow';
 assert.equal((await unit(row,0)).done,false);assert.equal(await one("SELECT id FROM sources WHERE id='manual:durable-file-1'"),undefined);
 assert.equal((await unit(row,1)).done,false);assert.equal((await unit(row,1)).revision,2);assert.equal((await unit(row,2)).done,true);
 assert.equal((await one('SELECT imported FROM sync_runs WHERE id=?',id)).imported,2);assert.equal((await one('SELECT count(*) AS n FROM import_chunks WHERE run_id=?',id)).n,0);
 const contact=await one("SELECT * FROM contact_runs WHERE state='queued'");assert.equal(contact.review_requested,true);
});
async function contactRun(){
 await run("UPDATE contact_runs SET state='complete' WHERE state IN ('queued','running')");await run("UPDATE contact_queue SET state='complete' WHERE state='pending'");
 const id=uid(),token=uid(),wf='contact-workflow-'+id;await run("INSERT INTO contact_runs(id,state,started_at,updated_at) VALUES(?,'queued',?,?)",id,stamp(),stamp());
 await run("INSERT INTO durable_runs(kind,run_id,dispatch_token) VALUES('contacts',?,?)",id,token);return{id,token,wf};
}
test('contact completion rechecks newly queued sources and late review requests under its final lock',async()=>{
 await run("UPDATE jobs SET status='complete' WHERE status IN ('queued','running')");await setSetting('pending_import_review',null);
 const activeJob=uid();await run("INSERT INTO jobs(id,kind,status,prompt,created_at,updated_at,progress) VALUES(?,'import_review','running','Fictional review already running',?,?,'Fixture')",activeJob,stamp(),stamp());
 const row=await contactRun();let lateSource;
 const first=await advanceDurableUnit('contacts',row.id,row.token,row.wf,0,{contacts:async()=>{
  assert.equal((await one('SELECT review_requested FROM contact_runs WHERE id=?',row.id)).review_requested,false);
  const emptySnapshot={cursor:{},records:[],complete:true};
  lateSource=await upsertSource({provider:'fireflies',external_id:'contact-race-'+row.id,title:'A newly imported fictional meeting',occurred_at:stamp(),body:'Fictional evidence arrived after the empty queue snapshot',coverage:'transcript'},{sentences:[]});
  await run('UPDATE contact_runs SET review_requested=true WHERE id=?',row.id);return emptySnapshot;
 }});
 assert.equal(first.done,false);assert.equal((await one('SELECT state FROM contact_runs WHERE id=?',row.id)).state,'running');assert.equal((await one('SELECT completed FROM durable_runs WHERE run_id=?',row.id)).completed,false);
 assert.equal((await one('SELECT state FROM contact_queue WHERE source_id=?',lateSource.id)).state,'pending');assert.equal(await getSetting('pending_import_review'),null);

 // A separate final step must also see review requests arriving after its claim,
 // even when no new extraction rows were added during that particular step.
 const finalRow=await contactRun();const final=await advanceDurableUnit('contacts',finalRow.id,finalRow.token,finalRow.wf,0,{contacts:async()=>{
  assert.equal((await one('SELECT review_requested FROM contact_runs WHERE id=?',finalRow.id)).review_requested,false);
  await run('UPDATE contact_runs SET review_requested=true WHERE id=?',finalRow.id);return{cursor:{},records:[],complete:true};
 }});
 assert.equal(final.done,true);assert.match(await getSetting('pending_import_review'),/Review all material added or updated/);assert.equal((await one('SELECT status FROM jobs WHERE id=?',activeJob)).status,'running');
 assert.equal((await one("SELECT count(*) AS n FROM jobs WHERE status IN ('queued','running')")).n,1);
});
test('projection savepoints roll back tentative contact writes while preserving the failed queue entry',async()=>{
 const row=await contactRun(),insertedId=uid(),existingId=uid();await run('INSERT INTO contacts(id,name) VALUES(?,?)',existingId,'Original fictional name');
 const source=await upsertSource({provider:'fireflies',external_id:'projection-rollback-'+row.id,title:'Fictional projection failure',occurred_at:stamp(),body:'Fictional source to test rollback',coverage:'transcript'},{sentences:[]});let projected=0;
 const result=await advanceDurableUnit('contacts',row.id,row.token,row.wf,0,{project:async(sourceId,guard)=>{
  projected++;assert.equal(sourceId,source.id);await guard();
  await run('INSERT INTO contacts(id,name) VALUES(?,?)',insertedId,'Tentative contact that must be rolled back');await run('UPDATE contacts SET name=? WHERE id=?','Tentative renamed contact',existingId);
  throw Error('Fictional private projection failure detail');
 }});
 assert.equal(projected,1);assert.equal(result.done,false);assert.equal(result.revision,1);assert.equal(await one('SELECT id FROM contacts WHERE id=?',insertedId),undefined);assert.equal((await one('SELECT name FROM contacts WHERE id=?',existingId)).name,'Original fictional name');
 const failed=await one('SELECT state,attempts,error FROM contact_queue WHERE source_id=?',source.id);assert.equal(failed.state,'failed');assert.equal(failed.attempts,1);assert.equal(failed.error,'Extraction failed; inspect the source and retry');assert.doesNotMatch(JSON.stringify(result)+failed.error,/private projection failure detail/);
 const complete=await advanceDurableUnit('contacts',row.id,row.token,row.wf,1);assert.equal(complete.done,true);assert.equal((await one('SELECT state FROM contact_runs WHERE id=?',row.id)).state,'partial');assert.equal((await one('SELECT state FROM contact_queue WHERE source_id=?',source.id)).state,'failed');
});
test('resuming failed contact work keeps its review request and cursor while fencing the old workflow',async()=>{
 const row=await contactRun();await run('UPDATE contact_runs SET review_requested=true WHERE id=?',row.id);
 await advanceDurableUnit('contacts',row.id,row.token,row.wf,0,{contacts:async()=>({cursor:{processed:7},records:[],complete:false})});
 const source=await upsertSource({provider:'fireflies',external_id:'contact-retry-'+row.id,title:'Fictional failed contact source',occurred_at:stamp(),body:'Fictional source awaiting extraction retry',coverage:'transcript'},{sentences:[]});
 await run("UPDATE contact_queue SET state='failed',attempts=3,error='Fictional prior failure' WHERE source_id=?",source.id);await failDurableRun('contacts',row.id,row.wf);
 await resumeDurable('contacts',row.id);const parent=await one('SELECT state,review_requested FROM contact_runs WHERE id=?',row.id),checkpoint=await one('SELECT cursor,revision,workflow_id FROM durable_runs WHERE run_id=?',row.id);
 assert.equal(parent.state,'queued');assert.equal(parent.review_requested,true);assert.deepEqual(checkpoint.cursor,{processed:7});assert.equal(checkpoint.revision,1);assert.equal(checkpoint.workflow_id,'');
 assert.deepEqual(await one('SELECT state,attempts,error FROM contact_queue WHERE source_id=?',source.id),{state:'pending',attempts:0,error:''});
 const old=await advanceDurableUnit('contacts',row.id,row.token,row.wf,1,{contacts:async()=>{throw Error('The old workflow must not continue');}});assert.equal(old.done,true);assert.equal((await one('SELECT state FROM contact_runs WHERE id=?',row.id)).state,'queued');
 const dispatch=(await prepareDispatches()).find(value=>value.id===row.id);assert.notEqual(dispatch.token,row.token);
 let resumed=false;await advanceDurableUnit('contacts',row.id,dispatch.token,'replacement-contact-workflow',1,{contacts:async cursor=>{resumed=true;assert.deepEqual(cursor,{processed:7});return{cursor,records:[],complete:false};}});assert.equal(resumed,true);assert.equal((await one('SELECT review_requested FROM contact_runs WHERE id=?',row.id)).review_requested,true);
});
test('a legacy lease acquired before Workflow adoption finishes its current invocation first',async()=>{
 const row=await queued(),legacy=await claimLease('sync_runs',row.id);assert.ok(legacy);let calls=0;
 const adapters={initial:async()=>({n:0}),advance:async()=>{calls++;return{cursor:{n:1},records:[],complete:false};}};
 const waiting=await unit(row,0,adapters);assert.equal(calls,0);assert.equal(waiting.done,false);assert.equal(waiting.revision,0);assert.ok(waiting.waitMs>=1000);
 assert.equal((await one('SELECT lease_owner FROM sync_runs WHERE id=?',row.id)).lease_owner,legacy.token);assert.equal(await heartbeatLease('sync_runs',row.id,legacy.token),true);
 // The old deployed worker saves its checkpoint and atomically yields this way.
 await run("UPDATE sync_runs SET state='queued',lease_owner='',lease_until=NULL,pid=NULL WHERE id=? AND lease_owner=?",row.id,legacy.token);
 const adopted=await unit(row,0,adapters);assert.equal(adopted.done,false);assert.equal(calls,1);assert.equal((await one('SELECT lease_owner FROM sync_runs WHERE id=?',row.id)).lease_owner,'workflow:'+row.wf);assert.equal(await heartbeatLease('sync_runs',row.id,legacy.token),false);
});
test('late legacy claims cannot attach after Workflow adoption or between durable steps',async()=>{
 for(const kind of ['sync','contacts']){
  const row=kind==='sync'?await queued():await contactRun(),table=kind==='sync'?'sync_runs':'contact_runs';
  const adapters=kind==='sync'?{initial:async()=>({n:0}),advance:async()=>({cursor:{n:1},records:[],complete:false})}:{contacts:async()=>({cursor:{n:1},records:[],complete:false})};
  const advance=revision=>advanceDurableUnit(kind,row.id,row.token,row.wf,revision,adapters);
  assert.equal((await advance(0)).done,false);const parent=await one('SELECT lease_owner,lease_until FROM '+table+' WHERE id=?',row.id);assert.equal(parent.lease_owner,'workflow:'+row.wf);assert.equal(parent.lease_until,null);
  assert.equal(await claimLease(table,row.id),null);assert.equal((await advance(1)).done,false);assert.equal(await claimLease(table,row.id),null);
 }
});
for(const terminal of ['complete','partial'])test('a legacy '+terminal+' result before the first Workflow step remains terminal after reconciliation',async()=>{
 const row=await queued(),legacy=await claimLease('sync_runs',row.id);assert.ok(legacy);await acknowledgeDispatch('sync',row.id,row.token,row.wf);
 await run('UPDATE sync_runs SET state=?,message=?,finished_at=?,imported=1000 WHERE id=?',terminal,'Legacy invocation finished',stamp(),row.id);const parent=await one('SELECT * FROM sync_runs WHERE id=?',row.id);
 const stopped=await unit(row,0,{initial:async()=>{throw Error('A terminal legacy run must not be ingested again');}});assert.equal(stopped.done,true);
 const inspected=[];await reconcileWorkflows(async id=>{inspected.push(id);return id===row.wf?'completed':'running';});
 assert.deepEqual(await one('SELECT * FROM sync_runs WHERE id=?',row.id),parent);assert.equal((await one('SELECT completed FROM durable_runs WHERE run_id=?',row.id)).completed,true);assert.equal(inspected.includes(row.wf),false);
});
test.after(()=>rmSync(privateDir,{recursive:true,force:true}));

test('bounded workflow handoff retains cursor and rejects late writes from the old owner',async()=>{
 const {yieldDurableRun}=await import('../lib/durable-ingestion.mjs');
 const row=await queued();await unit(row,0,{initial:async()=>({n:0}),advance:async()=>({cursor:{n:500},records:[],complete:false})});
 assert.equal(await yieldDurableRun('sync',row.id,row.token,'not-the-owner'),false);
 assert.equal(await yieldDurableRun('sync',row.id,row.token,row.wf),true);
 assert.equal((await one('SELECT state FROM sync_runs WHERE id=?',row.id)).state,'queued');
 const next=(await prepareDispatches()).find(r=>r.id===row.id);assert.notEqual(next.token,row.token);
 assert.equal((await unit(row,1,{advance:async()=>{throw Error('Old owner must not run');}})).done,true);
 const caughtUp=await advanceDurableUnit('sync',row.id,next.token,'continued-workflow',0);assert.equal(caughtUp.revision,1);
 await advanceDurableUnit('sync',row.id,next.token,'continued-workflow',1,{advance:async(_provider,cursor)=>{assert.equal(cursor.n,500);return{cursor,records:[],complete:true};}});
 assert.equal((await one('SELECT state FROM sync_runs WHERE id=?',row.id)).state,'complete');
});
test('automatic historical extraction fills only missing source work and keeps progress',async()=>{
 const {scheduleContactHistory}=await import('../lib/contact-jobs.mjs');
 await run("UPDATE contact_runs SET state='complete' WHERE state IN ('queued','running')");await run("UPDATE contact_queue SET state='complete'");
 const s=await upsertSource({provider:'fireflies',external_id:'old-backfill-test',title:'Old fictional meeting',occurred_at:'2020-01-01T12:00:00Z',body:'Old fictional evidence.'});await run('DELETE FROM contact_queue WHERE source_id=?',s.id);
 const first=await scheduleContactHistory();assert.ok(first.id);assert.equal((await one('SELECT state FROM contact_queue WHERE source_id=?',s.id)).state,'pending');
 await run("UPDATE contact_queue SET state='complete' WHERE source_id=?",s.id);await scheduleContactHistory();assert.equal((await one('SELECT state FROM contact_queue WHERE source_id=?',s.id)).state,'complete');
});
