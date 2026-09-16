import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const privateDir=mkdtempSync(join(tmpdir(),'focus-workflow-recovery-'));process.env.XIN_DATA_DIR=privateDir;process.env.XIN_AGENT_MODE='cloud';
const {one,run,uid,stamp}=await import('../lib/db.mjs');
const {reconcileWorkflows}=await import('../lib/workflow-recovery.mjs');
const {resumeDurable}=await import('../lib/durable-ingestion.mjs');
test.beforeEach(async()=>{await run('DELETE FROM durable_runs');await run("UPDATE sync_runs SET state='complete' WHERE state IN ('queued','running','uploading')");await run("UPDATE contact_runs SET state='complete' WHERE state IN ('queued','running')");});
async function fixture({kind='sync',state='running',completed=false,workflowId,old=false}={}){
 const id=uid(),wf=workflowId??'workflow-'+id,time=old?'2020-01-01T00:00:00Z':stamp();
 if(kind==='sync')await run('INSERT INTO sync_runs(id,provider,state,started_at,updated_at) VALUES(?,?,?,?,?)',id,'gmail',state,time,time);
 else await run('INSERT INTO contact_runs(id,state,started_at,updated_at) VALUES(?,?,?,?)',id,state,time,time);
 await run('INSERT INTO durable_runs(kind,run_id,workflow_id,completed,cursor,revision,updated_at) VALUES(?,?,?,?,?::jsonb,?,?::timestamptz)',kind,id,wf,completed,JSON.stringify({privateCheckpoint:'fictional preserved cursor'}),7,time);
 return{kind,id,wf,table:kind==='sync'?'sync_runs':'contact_runs'};
}
async function saved(row){return{parent:await one('SELECT * FROM '+row.table+' WHERE id=?',row.id),durable:await one('SELECT * FROM durable_runs WHERE kind=? AND run_id=?',row.kind,row.id)};}

for(const status of ['failed','cancelled','completed'])test('confirmed '+status+' workflows become resumable failures without clearing their checkpoint',async()=>{
 const row=await fixture({kind:status==='cancelled'?'contacts':'sync'});let inspections=0;
 assert.equal(await reconcileWorkflows(async id=>{inspections++;assert.equal(id,row.wf);return status;}),1);
 const result=await saved(row);assert.equal(result.parent.state,'failed');assert.equal(result.durable.completed,true);assert.deepEqual(result.durable.cursor,{privateCheckpoint:'fictional preserved cursor'});assert.equal(result.durable.revision,7);assert.equal(result.durable.workflow_id,row.wf);assert.equal(result.durable.outcome.failed,true);assert.equal(inspections,1);
 assert.equal(await reconcileWorkflows(async()=>{throw Error('Completed app rows must not be inspected');}),0);
});

test('pending, running, sleeping and unknown workflow statuses stay active regardless of age',async()=>{
 const row=await fixture({old:true}),before=await saved(row);
 for(const status of ['pending','running','sleeping','workflow_suspended','not_found','unknown',undefined]){assert.equal(await reconcileWorkflows(async()=>status),1);assert.deepEqual(await saved(row),before);}
});

test('lookup failures including not found leave the run and private checkpoint unchanged',async()=>{
 const row=await fixture({old:true}),before=await saved(row);
 for(const error of [Error('Network error with fictional-secret'),Object.assign(Error('Unknown Workflow'),{status:404})]){await reconcileWorkflows(async()=>{throw error;});assert.deepEqual(await saved(row),before);}
 // Synchronous connector failures are isolated too.
 await reconcileWorkflows(()=>{throw Error('Unavailable status connector');});assert.deepEqual(await saved(row),before);
});

test('status lookups cannot fail a run that was resumed under a different workflow owner',async()=>{
 const row=await fixture();await reconcileWorkflows(async()=>{
  await run("UPDATE sync_runs SET state='failed' WHERE id=?",row.id);
  await resumeDurable('sync',row.id,'gmail');
  await run("UPDATE durable_runs SET workflow_id='replacement-workflow' WHERE kind='sync' AND run_id=?",row.id);
  return'failed';
 });
 const result=await saved(row);assert.equal(result.parent.state,'queued');assert.equal(result.durable.completed,false);assert.equal(result.durable.workflow_id,'replacement-workflow');assert.deepEqual(result.durable.cursor,{privateCheckpoint:'fictional preserved cursor'});
});

test('normal completion racing a status lookup is not overwritten as a failure',async()=>{
 const row=await fixture();await reconcileWorkflows(async()=>{await run("UPDATE durable_runs SET completed=true WHERE run_id=?",row.id);await run("UPDATE sync_runs SET state='complete' WHERE id=?",row.id);return'completed';});assert.equal((await saved(row)).parent.state,'complete');
});

test('reconciliation excludes undispatched and finished work and bounds status lookups',async()=>{
 await fixture({state:'failed',workflowId:''});await fixture({state:'complete',completed:true});
 for(let i=0;i<21;i++)await fixture({state:'failed'});
 const calls=[];assert.equal(await reconcileWorkflows(async id=>{calls.push(id);return'pending';}),20);assert.equal(calls.length,20);assert.equal(calls.includes(''),false);assert.equal(new Set(calls).size,20);
});

test.after(()=>rmSync(privateDir,{recursive:true,force:true}));
