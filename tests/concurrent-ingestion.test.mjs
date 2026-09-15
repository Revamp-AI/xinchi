import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const privateDir=mkdtempSync(join(tmpdir(),'focus-concurrent-'));
process.env.XIN_DATA_DIR=privateDir;process.env.XIN_AGENT_MODE='cloud';
const {all,one,run,stamp,uid}=await import('../lib/db.mjs');
const {startSync,saveSecrets}=await import('../lib/connectors.mjs');
const {prepareDispatches,advanceDurableUnit,resumeDurable}=await import('../lib/durable-ingestion.mjs');
const {createManualUpload}=await import('../lib/manual-ingestion.mjs');
await saveSecrets({gmail_tokens:{refresh_token:'fictional'},fireflies_key:'fictional',granola_key:'fictional'});
test.beforeEach(async()=>{await run('DELETE FROM import_records');await run('DELETE FROM import_uploads');await run('DELETE FROM durable_runs');await run('DELETE FROM sync_runs');});
test.after(()=>rmSync(privateDir,{recursive:true,force:true}));
test('different providers start together while duplicate starts for one provider remain blocked',async()=>{
 const results=await Promise.allSettled(['gmail','fireflies','granola'].map(startSync));
 assert.deepEqual(results.map(r=>r.status),['fulfilled','fulfilled','fulfilled']);
 for(const provider of ['gmail','fireflies','granola'])await assert.rejects(startSync(provider),/already running/);
 await assert.rejects(run("INSERT INTO sync_runs(id,provider,state,started_at,updated_at) VALUES(?,'gmail','queued',?,?)",uid(),stamp(),stamp()),e=>e.code==='23505');
 assert.equal((await all("SELECT id FROM sync_runs WHERE state='queued'")).length,3);
});
test('a waiting Gmail request does not prevent the other provider workflows from saving progress',async()=>{
 const runs=await Promise.all(['gmail','fireflies','granola'].map(startSync)),dispatches=await prepareDispatches();
 let release,started;const pause=new Promise(r=>{release=r;}),ready=new Promise(r=>{started=r;});
 const unit=(index,advance)=>{const dispatch=dispatches.find(d=>d.id===runs[index].id);return advanceDurableUnit('sync',dispatch.id,dispatch.token,'wf-'+dispatch.id,0,{initial:async()=>({page:0}),advance});};
 const slow=unit(0,async()=>{started();await pause;return{cursor:{page:1},records:[],complete:false};});await ready;
 try{
  const result=await Promise.all([1,2].map(i=>unit(i,async()=>({cursor:{page:1},records:[],complete:false}))));
  assert.ok(result.every(r=>r.revision===1&&!r.done));
  assert.equal((await one('SELECT revision FROM durable_runs WHERE run_id=?',runs[0].id)).revision,0);
 }finally{release();await slow;}
});
test('manual uploads use their own slot while provider imports run',async()=>{
 await startSync('gmail');
 const upload=await createManualUpload({format:'text',title:'Fictional.txt',bytes:4});
 await assert.rejects(createManualUpload({format:'text',title:'Second.txt',bytes:4}),/already active/);
 await startSync('fireflies');
 assert.equal((await one('SELECT state FROM sync_runs WHERE id=?',upload.id)).state,'uploading');
});
test('failed provider retries keep their cursor and only conflict with the same provider',async()=>{
 const gmail=await startSync('gmail'),d=(await prepareDispatches()).find(d=>d.id===gmail.id);
 await advanceDurableUnit('sync',gmail.id,d.token,'wf-gmail',0,{initial:async()=>({page:7}),advance:async(_p,cursor)=>({cursor,records:[],complete:false})});
 await run("UPDATE sync_runs SET state='failed' WHERE id=?",gmail.id);
 await startSync('fireflies');await resumeDurable('sync',gmail.id,'gmail');
 assert.deepEqual((await one('SELECT cursor FROM durable_runs WHERE run_id=?',gmail.id)).cursor,{page:7});
 await run("UPDATE sync_runs SET state='failed' WHERE id=?",gmail.id);await startSync('gmail');
 await assert.rejects(resumeDurable('sync',gmail.id,'gmail'),/already running/);
});
