import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const privateDir=mkdtempSync(join(tmpdir(),'focus-cloud-resume-'));process.env.XIN_DATA_DIR=privateDir;
const {one,run,uid,stamp,getSetting}=await import('../lib/db.mjs');
import {withJobBudget} from '../lib/job-budget.mjs';
const {saveSecrets,syncProvider}=await import('../lib/connectors.mjs');
const {runSyncWorker}=await import('../scripts/sync-worker.mjs');
const {runContactWorker}=await import('../scripts/contact-worker.mjs');
import {localToday} from '../lib/urgency.mjs';
test('workers checkpoint instead of losing queued work when a cloud invocation runs out of time',async()=>{
 await saveSecrets({fireflies_key:'fixture-key'});process.env.XIN_ALLOWED_EMAIL='owner@example.com';
 const sync=uid(),contact=uid();await run("INSERT INTO sync_runs(id,provider,state,started_at,updated_at) VALUES(?,'fireflies','queued',?,?)",sync,stamp(),stamp());
 await run("INSERT INTO contact_runs(id,state,started_at,updated_at) VALUES(?,'queued',?,?)",contact,stamp(),stamp());
 await withJobBudget(1,()=>runSyncWorker(sync));await withJobBudget(1,()=>runContactWorker(contact));
 for(const [table,id] of [['sync_runs',sync],['contact_runs',contact]]){const row=await one('SELECT state,lease_owner,lease_until FROM '+table+' WHERE id=?',id);assert.equal(row.state,'queued');assert.equal(row.lease_owner,'');assert.equal(row.lease_until,null);}
});
test('Fireflies saves its fixed snapshot boundary and resumes from the last stored record',async()=>{
 const before=global.fetch;let boundary;
 global.fetch=async(_url,options)=>{const args=JSON.parse(options.body).variables;if(args.skip===0){boundary=args.until;return Response.json({data:{transcripts:Array.from({length:50},(_,i)=>({id:'fixture-'+i,title:'Fictional meeting '+i,sentences:[]}))}});}throw Object.assign(Error('Yield fixture'),{yieldJob:true});};
 try{await assert.rejects(syncProvider('fireflies'),e=>e.yieldJob);const cursor=await getSetting('fireflies_page');assert.equal(cursor.skip,50);assert.equal(cursor.boundary,boundary);
 global.fetch=async(_url,options)=>{const args=JSON.parse(options.body).variables;assert.equal(args.skip,50);assert.equal(args.until,boundary);return Response.json({data:{transcripts:[]}});};
 assert.equal((await syncProvider('fireflies')).complete,true);assert.equal(await getSetting('fireflies_page'),null);
 }finally{global.fetch=before;}
});
test('hosted calendar dates use the configured owner timezone at UTC day boundaries',()=>{
 const date=new Date('2026-09-14T20:00:00Z');assert.equal(localToday(date,'Asia/Singapore'),'2026-09-15');assert.equal(localToday(date,'America/Los_Angeles'),'2026-09-14');
});

test.after(()=>rmSync(privateDir,{recursive:true,force:true}));
