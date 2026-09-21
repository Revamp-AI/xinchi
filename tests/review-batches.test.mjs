import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.XIN_AGENT_MODE='cloud';
const {upsertSource,all,one,run,stamp,uid,saveItem}=await import('../lib/db.mjs');
const {takePendingImportReview,saveResult}=await import('../lib/agent.mjs');
const {readReviewBatch,completeReviewBatch,releaseFailedReviewBatches}=await import('../lib/review-batches.mjs');
const {callContextTool}=await import('../lib/context-tools.mjs');
const empty={brief:'Scoped review complete.',findings:[],proposals:[],drafts:[],questions:[],coverage_note:'Only assigned pages reviewed.'};
const source=(id,body='Fictional recent meeting text.')=>({provider:'granola',external_id:id,title:'Fictional meeting '+id,occurred_at:stamp(),body,coverage:'transcript'});
test.beforeEach(async()=>{await run('TRUNCATE review_batches,review_queue,jobs,items,sources CASCADE');});
test('new source pages queue independently of contact extraction; batches are bounded and continue without gaps',async()=>{
 const body='🌻 a fictional transcript. '.repeat(4500);await upsertSource(source('long',body));
 let position=0;
 while(position<body.length){const id=await takePendingImportReview();assert.ok(id);const packet=(await readReviewBatch(id)).sources[0];assert.equal(packet.offset,position);assert.equal(packet.body,body.slice(packet.offset,packet.end));assert.ok(packet.body.length<=40000);position=packet.end;await saveResult(id,empty);}
 assert.equal(await takePendingImportReview(),null);assert.equal((await one('SELECT count(*) n FROM contact_queue WHERE state=?','pending')).n,1);
});
test('raw metadata changes do not repeat a review, and a newer source snapshot survives completion of an older batch',async()=>{
 const doc=source('revisions');await upsertSource(doc,{revision:1});const old=await takePendingImportReview();const oldPage=(await readReviewBatch(old)).sources[0];
 await upsertSource(doc,{revision:2});assert.equal((await one('SELECT source_version_id FROM review_queue')).source_version_id,oldPage.source_version_id);
 await upsertSource({...doc,body:'A changed fictional meeting decision.'},{revision:3});await saveResult(old,empty);
 const next=await takePendingImportReview();assert.ok(next);const packet=(await readReviewBatch(next)).sources[0];assert.notEqual(packet.source_version_id,oldPage.source_version_id);assert.equal(packet.offset,0);assert.match(packet.body,/changed/);
});
test('failed pages back off, never disappear, and stop automatic retries after three attempts',async()=>{
 await upsertSource(source('failure'));
 for(let n=0;n<3;n++){const id=await takePendingImportReview();assert.ok(id);await run("UPDATE jobs SET status='failed' WHERE id=?",id);await releaseFailedReviewBatches();assert.equal(await takePendingImportReview(),null);await run("UPDATE review_queue SET retry_after=now()-interval '1 minute'");}
 assert.equal(await takePendingImportReview(),null);const row=await one('SELECT * FROM review_queue');assert.equal(row.completed,false);assert.equal(row.attempts,3);assert.equal(row.next_offset,0);
});
test('historic archives and user review prompts do not generate automatic obligations',async()=>{
 await upsertSource({...source('old'),occurred_at:'2020-01-01'});await upsertSource({provider:'manual',external_id:'agent-request-fixture',title:'Request',occurred_at:stamp(),body:'Review everything.'});
 assert.equal(await takePendingImportReview(),null);
});
test('large review history and decision snapshots cannot crowd out current commitments',async()=>{
 const item=await saveItem({title:'Fictional active work',status:'now',done_when:'Done',next_action:'Next',owner:'You',checkpoint:'2026-10-01'});
 for(let i=0;i<6;i++)await run("INSERT INTO jobs(id,kind,status,prompt,result_json,created_at,updated_at) VALUES(?,'review','complete',?,?,?,?)",uid(),'Review','x'.repeat(90000),stamp(),stamp());
 await run('INSERT INTO events VALUES(?,?,?,?,?,?,?)',uid(),item.id,'updated','x'.repeat(90000),'x'.repeat(90000),'Reason',stamp());
 const result=await callContextTool('read_commitments');assert.ok(result.items.some(i=>i.id===item.id));assert.ok(JSON.stringify(result).length<20000);assert.equal(result.recent_agent_requests[0].result_json,undefined);assert.equal(result.recent_changes[0].after_json,undefined);
});
