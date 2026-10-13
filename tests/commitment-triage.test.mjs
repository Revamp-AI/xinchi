import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import {randomBytes} from 'node:crypto';
process.env.XIN_SECRET_STORAGE='postgres';process.env.XIN_SECRETS_KEY=randomBytes(32).toString('base64url');
import assert from 'node:assert/strict';
process.env.XIN_AGENT_MODE='cloud';
const {upsertSource,one,all,run,uid,stamp,saveItem}=await import('../lib/db.mjs');
const {saveResult,takePendingImportReview}=await import('../lib/agent.ts');
const {callContextTool}=await import('../lib/context-tools.ts');
const empty={brief:'Review complete.',findings:[],proposals:[],questions:[],coverage_note:'Fictional fixtures only.'};
async function job(kind='import_review'){const id=uid();await run('INSERT INTO jobs(id,kind,status,prompt,created_at,updated_at) VALUES(?,?,?,?,?,?)',id,kind,'queued','Review the current evidence',stamp(),stamp());return id;}
async function proposal(n,area='customer',basis='verbal_promise'){
 const quote='Avery: I will send the project '+n+' implementation plan.';
 const source=await upsertSource({provider:'granola',external_id:'meeting-'+n,title:'Project '+n,occurred_at:stamp(),coverage:'transcript',body:'Transcript\n'+quote});
 return{title:'Send project '+n+' plan',kind:'action',rationale:'An explicit promise.',done_when:'Plan delivered',next_action:'Draft plan',existing_item_id:'',uncertainty:'',confidence:'high',citations:[{source_id:source.id,quote}],qualification:{basis,area,deliverable_key:'project-'+n+'-implementation-plan',owner_basis:'Avery is the workspace owner in this transcript.',commitment_quote:quote,due_date:'',deadline_kind:'none',deadline_source_id:'',deadline_quote:''}};
}
test.beforeEach(async()=>{await run('TRUNCATE jobs,sources,items CASCADE');await run("DELETE FROM settings WHERE key LIKE 'commitment_review_%'");});
test('recurring imports admit explicit promises, cap the shortlist, and retain overflow for review',async()=>{
 for(let i=0;i<13;i++)await saveResult(await job(),{...empty,proposals:[await proposal(i,i===12?'customer':'personal')]});
 assert.equal((await one("SELECT count(*) n FROM proposals WHERE status='pending'")).n,10);
 assert.equal((await one("SELECT count(*) n FROM proposals WHERE status='deferred'")).n,3);
 const first=await one("SELECT payload FROM proposals WHERE status='pending' ORDER BY priority_score DESC,created_at DESC");assert.match(first.payload,/project 12/);
 const notice=await proposal('notice');delete notice.qualification;
 await saveResult(await job(),{...empty,proposals:[notice]});assert.equal((await one('SELECT count(*) n FROM proposals')).n,13);
});
test('reworded imports do not resurrect a dismissed deliverable',async()=>{
 const p=await proposal('same');await saveResult(await job(),{...empty,proposals:[p]});
 const row=await one('SELECT * FROM proposals');
 const {dismissProposal}=await import('../lib/proposals.ts');await dismissProposal(row.id);
 await saveResult(await job(),{...empty,proposals:[{...p,title:'Finish the implementation document'}]});
 assert.equal((await one('SELECT count(*) n FROM proposals')).n,1);assert.equal((await one('SELECT status FROM proposals')).status,'dismissed');
});
test('completion pruning needs cited evidence, records history, and cannot overwrite a user acceptance',async()=>{
 const p=await proposal('done');await saveResult(await job(),{...empty,proposals:[p]});const row=await one('SELECT * FROM proposals');
 const s=await upsertSource({provider:'gmail',external_id:'delivery',title:'Delivery',body:'Avery: The implementation plan is attached and delivered.',coverage:'email body',occurred_at:stamp()});
 const reconciliation={proposal_id:row.id,version:row.version,reason:'completed',explanation:'The owner sent the plan.',related_proposal_id:'',citations:[{source_id:s.id,quote:'The implementation plan is attached and delivered.'}]};
 await assert.rejects(saveResult(await job(),{...empty,proposal_reconciliations:[{...reconciliation,citations:[{source_id:s.id,quote:'Invented proof of completion.'}]}]}),/unverified/);
 await run("UPDATE jobs SET status='failed' WHERE status='queued'");
 await saveResult(await job(),{...empty,proposal_reconciliations:[reconciliation]});
 assert.equal((await one('SELECT status FROM proposals WHERE id=?',row.id)).status,'dismissed');assert.equal((await one("SELECT count(*) n FROM proposal_events WHERE proposal_id=? AND reason='completed'",row.id)).n,1);
 const next=await proposal('accepted');await saveResult(await job(),{...empty,proposals:[next]});const other=await one("SELECT * FROM proposals WHERE status='pending'");
 const item=await saveItem({title:next.title,proposal_id:other.id,status:'candidate'});
 await saveResult(await job(),{...empty,proposal_reconciliations:[{...reconciliation,proposal_id:other.id,version:other.version}]});
 assert.equal((await one('SELECT status FROM proposals WHERE id=?',other.id)).status,'accepted');assert.equal((await one('SELECT status FROM items WHERE id=?',item.id)).status,'candidate');
});
test('summary-only attribution cannot qualify as a verbal promise',async()=>{
 const p=await proposal('summary');await upsertSource({provider:'granola',external_id:'summary-only',title:'Summary',body:p.qualification.commitment_quote,coverage:'summary',occurred_at:stamp()});p.citations[0].source_id='granola:summary-only';
 await assert.rejects(saveResult(await job(),{...empty,proposals:[p]}),/transcript/);
});
test('maintenance runs without new imports and includes full versioned proposals, then waits a day',async()=>{
 await saveResult(await job(),{...empty,proposals:[await proposal('maintenance')]});await run('TRUNCATE review_queue CASCADE');
 const id=await takePendingImportReview();assert.ok(id);assert.equal((await one('SELECT kind FROM jobs WHERE id=?',id)).kind,'backlog_review');
 const context=await callContextTool('read_proposals',{}, {jobId:id});assert.equal(context.records.length,1);assert.ok(context.records[0].version);assert.ok(context.records[0].payload.citations[0].source_version_id);
 await saveResult(id,empty);assert.equal(await takePendingImportReview(),null);
});
test('maintenance scheduling is exclusive, backs off failures, and resumes old suggestions daily',async()=>{
 await saveResult(await job(),{...empty,proposals:[await proposal('daily')]});await run('TRUNCATE review_queue CASCADE');
 const runs=await Promise.all([takePendingImportReview(),takePendingImportReview()]);assert.equal(runs.filter(Boolean).length,1);
 await run("UPDATE jobs SET status='failed' WHERE id=?",runs.find(Boolean));assert.equal(await takePendingImportReview(),null);
 await run("UPDATE jobs SET updated_at=? WHERE id=?",new Date(Date.now()-2*3600000).toISOString(),runs.find(Boolean));await run("UPDATE proposals SET review_attempted_at=now()-interval '2 hours'");
 const next=await takePendingImportReview();assert.ok(next);await saveResult(next,empty);
 await run("UPDATE proposals SET reviewed_at=now()-interval '25 hours',review_attempted_at=now()-interval '25 hours'");assert.ok(await takePendingImportReview());
});
test('fresh proposal versions can be updated; stale acceptance and stale pruning cannot win',async()=>{
 const p=await proposal('versioned');await saveResult(await job(),{...empty,proposals:[p]});const old=await one('SELECT * FROM proposals');
 await saveResult(await job(),{...empty,proposals:[{...p,title:'Updated implementation plan',existing_proposal_id:old.id,proposal_version:old.version}]});
 assert.equal((await one('SELECT version FROM proposals')).version,old.version+1);
 await assert.rejects(saveItem({title:'Stale plan',proposal_id:old.id,proposal_version:old.version}),/changed/);
 await saveResult(await job(),{...empty,proposal_reconciliations:[{proposal_id:old.id,version:old.version,reason:'superseded',explanation:'An old review tried to supersede it.',citations:p.citations}]});
 assert.equal((await one('SELECT status FROM proposals')).status,'pending');
 const {dismissProposal,restoreProposal}=await import('../lib/proposals.ts');await dismissProposal(old.id);const dismissed=await one('SELECT version FROM proposals');
 await restoreProposal(old.id,dismissed.version);assert.equal((await one('SELECT status FROM proposals')).status,'pending');await assert.rejects(restoreProposal(old.id,dismissed.version),/changed/);
});
test('an incomplete review cannot mark unchecked suggestions reviewed or immediately loop on them',async()=>{
 for(let i=0;i<4;i++)await saveResult(await job(),{...empty,proposals:[await proposal('bounded-'+i)]});await run('TRUNCATE review_queue CASCADE');
 const id=await takePendingImportReview();assert.equal((await all('SELECT * FROM proposal_review_batches WHERE job_id=?',id)).length,3);
 await saveResult(id,empty);assert.equal((await one('SELECT count(*) n FROM proposals WHERE reviewed_at IS NOT NULL')).n,0);
 const next=await takePendingImportReview();assert.ok(next);assert.equal((await all('SELECT * FROM proposal_review_batches WHERE job_id=?',next)).length,1);
 await saveResult(next,empty);assert.equal(await takePendingImportReview(),null);
});
test('targeted proposal evidence includes a late transcript promise without reading the whole meeting',async()=>{
 const p=await proposal('late');await upsertSource({provider:'granola',external_id:'meeting-late',title:'Long meeting',occurred_at:stamp(),coverage:'transcript',body:'Transcript\n'+('Earlier unrelated discussion. '.repeat(7000))+p.qualification.commitment_quote+'\nAvery: Please send the customer specification first.'});
 await saveResult(await job(),{...empty,proposals:[p]});const row=await one('SELECT * FROM proposals');
 const evidence=await callContextTool('read_proposal_evidence',{id:row.id});assert.ok(evidence.sources[0].body.includes(p.qualification.commitment_quote));assert.ok(evidence.sources[0].offset>100000);assert.ok(JSON.stringify(evidence).length<12000);
 await run('TRUNCATE review_queue CASCADE');const id=await takePendingImportReview();await saveResult(id,{...empty,proposal_checks:[{proposal_id:row.id,version:row.version,explanation:'The promised output remains open; no newer completion evidence was found in the scoped search.',citations:p.citations}]});
 assert.equal((await one('SELECT count(*) n FROM proposals WHERE reviewed_at IS NOT NULL')).n,1);assert.equal(await takePendingImportReview(),null);
});
