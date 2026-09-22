import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {upsertSource,one,all,run} from '../lib/db.mjs';
import {createJob} from '../lib/agent.mjs';
import {claimLease,cancelLease} from '../lib/leases.mjs';
import {callContextTool} from '../lib/context-tools.mjs';

test('parallel source reads record progress without upgrading conflicting shared locks',async()=>{
 const source=await upsertSource({provider:'manual',external_id:'parallel-progress-fixture',title:'Parallel evidence fixture',body:'A fictional buyer needs a verified pilot success criterion.'});
 const id=await createJob('Read the fixture in parallel.');const {token}=await claimLease('jobs',id);
 // Widen the overlap at the event insert to reproduce concurrent progress writers.
 await run("CREATE FUNCTION slow_context_progress_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.05); RETURN NEW; END $$");
 await run('CREATE TRIGGER slow_context_progress BEFORE INSERT ON job_events FOR EACH ROW EXECUTE FUNCTION slow_context_progress_fixture()');
 try{
  const reads=await Promise.allSettled(Array.from({length:6},()=>callContextTool('read_source',{id:source.id},{jobId:id,leaseToken:token})));
  assert.deepEqual(reads.map(r=>r.status),Array(6).fill('fulfilled'),reads.filter(r=>r.status==='rejected').map(r=>r.reason.message).join('; '));
  const events=await all('SELECT * FROM job_events WHERE job_id=?',id);assert.equal(events.length,6);
  const job=await one('SELECT progress FROM jobs WHERE id=?',id);assert.equal(job.progress,'Reading: Parallel evidence fixture');
  await cancelLease('jobs',id);
  await assert.rejects(callContextTool('read_source',{id:source.id},{jobId:id,leaseToken:token}),/no longer owns/);
  assert.equal((await all('SELECT * FROM job_events WHERE job_id=?',id)).length,6);
 }finally{await run('DROP TRIGGER slow_context_progress ON job_events');await run('DROP FUNCTION slow_context_progress_fixture()');}
});

test('source pages provide the exact snapshot ID for citation validation',async()=>{
 const doc={provider:'manual',external_id:'snapshot-page-fixture',title:'Snapshot fixture',body:'The fictional original buyer statement.'};const source=await upsertSource(doc);
 const first=await callContextTool('read_source',{id:source.id});
 assert.ok(first.source_version_id);assert.equal((await one('SELECT normalized_body FROM source_versions WHERE id=?',first.source_version_id)).normalized_body,first.body);
 await upsertSource({...doc,body:'The fictional revised buyer statement.'});
 const second=await callContextTool('read_source',{id:source.id});assert.notEqual(first.source_version_id,second.source_version_id);assert.equal((await one('SELECT normalized_body FROM source_versions WHERE id=?',second.source_version_id)).normalized_body,second.body);
});
