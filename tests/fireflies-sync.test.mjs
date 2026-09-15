import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
process.env.XIN_ALLOWED_EMAIL='owner@example.com';process.env.XIN_AGENT_MODE='cloud';process.env.XIN_SECRET_STORAGE='postgres';process.env.XIN_SECRETS_KEY=randomBytes(32).toString('base64url');
const {firefliesWindow,firefliesCompletedSettings}=await import('../lib/fireflies-sync.mjs');
const {initialProviderCursor,advanceProvider}=await import('../lib/ingestion-providers.mjs');
const {startSync,syncProvider}=await import('../lib/connectors.mjs');
const {saveSecrets}=await import('../lib/secret-store.mjs');
const {setSetting,getSetting,one,run,transaction,upsertSource}=await import('../lib/db.mjs');
const {prepareDispatches,advanceDurableUnit,resumeDurable}=await import('../lib/durable-ingestion.mjs');
const marker={participant:'owner@example.com',through:'2026-09-10T12:00:00Z'};
const row=id=>({id,title:'Fictional transcript '+id,dateString:'2026-09-09T12:00:00Z',sentences:[{text:'A fictional planning discussion.',speaker_name:'Jo',start_time:0}]});
test.beforeEach(async()=>{delete process.env.XIN_FIREFLIES_PARTICIPANT_EMAIL;await run('TRUNCATE durable_runs,sync_runs,contact_runs CASCADE');for(const key of ['fireflies_page','fireflies_sync'])await setSetting(key,null);await saveSecrets({fireflies_key:'fictional-fireflies-key'});});
async function commitAdvance(cursor){const result=await advanceProvider('fireflies',cursor);await transaction(async()=>{for(const record of result.records)await upsertSource(record.doc,record.raw);for(const [key,value]of Object.entries(result.settings))await setSetting(key,value);});return result;}
test('first import covers history; subsequent refresh uses a fixed window with seven days of overlap',async t=>{
 let count=0;const calls=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{const body=JSON.parse(options.body);calls.push(body);return Response.json({data:{transcripts:count++===0?[row('incremental-fixture')]:[]}});});
 const initial=await initialProviderCursor('fireflies');assert.equal(initial.since,null);
 const first=await commitAdvance(initial);assert.equal(await getSetting('fireflies_sync'),null);
 const done=await commitAdvance(first.cursor);assert.equal(done.complete,true);assert.equal((await getSetting('fireflies_sync')).through,initial.boundary);
 const next=await initialProviderCursor('fireflies');assert.equal(next.since,new Date(Date.parse(initial.boundary)-7*86400000).toISOString());assert.equal(next.skip,0);
 await commitAdvance(next);assert.match(calls[2].query,/fromDate:\$since/);assert.equal(calls[2].variables.since,next.since);assert.equal(calls[2].variables.until,next.boundary);
 assert.equal(await getSetting('fireflies_page'),null);
});
test('incremental cursor resumes at the same offset and window after a provider failure',async t=>{
 await setSetting('fireflies_sync',marker);let failed=false;
 t.mock.method(globalThis,'fetch',async(url,options)=>{const {skip}=JSON.parse(options.body).variables;if(skip===0)return Response.json({data:{transcripts:[row('resume-fixture')]}});if(!failed){failed=true;return Response.json({}, {status:503});}return Response.json({data:{transcripts:[]}});});
 const initial=await initialProviderCursor('fireflies'),first=await commitAdvance(initial);
 await assert.rejects(commitAdvance(first.cursor));assert.deepEqual(await getSetting('fireflies_sync'),marker);
 const resumed=await initialProviderCursor('fireflies');assert.equal(resumed.skip,1);assert.equal(resumed.since,'2026-09-03T12:00:00.000Z');assert.equal(resumed.boundary,initial.boundary);
 assert.equal((await commitAdvance(resumed)).complete,true);
});
test('completed legacy durable imports seed incremental sync, while unfinished or different-account runs do not',async()=>{
 await run("INSERT INTO sync_runs(id,provider,state,started_at,updated_at,finished_at) VALUES('old-full','fireflies','complete','2026-09-10','2026-09-10','2026-09-10')");
 await run("INSERT INTO durable_runs(kind,run_id,completed,cursor) VALUES('sync','old-full',true,?::jsonb)",JSON.stringify({phase:'done',participant:marker.participant,boundary:marker.through,skip:400}));
 assert.equal((await firefliesWindow()).since,'2026-09-03T12:00:00.000Z');
 await run("UPDATE sync_runs SET state='failed' WHERE id='old-full'");assert.equal((await firefliesWindow()).since,null);
 await run("UPDATE sync_runs SET state='complete' WHERE id='old-full'");process.env.XIN_FIREFLIES_PARTICIPANT_EMAIL='different@example.com';assert.equal((await firefliesWindow()).since,null);
});
test('explicit history rescan retains the completed marker, cannot replace active work, and is restricted to Fireflies',async()=>{
 await setSetting('fireflies_sync',marker);await setSetting('fireflies_page',{...await firefliesWindow(),skip:12});
 const started=await startSync('fireflies',{rescan:true});const full=await getSetting('fireflies_page');assert.equal(full.skip,0);assert.equal(full.since,null);assert.deepEqual(await getSetting('fireflies_sync'),marker);
 await assert.rejects(startSync('fireflies',{rescan:true}),/already running/);assert.deepEqual(await getSetting('fireflies_page'),full);
 await assert.rejects(startSync('gmail',{rescan:true}),/only for Fireflies/);assert.equal((await one('SELECT state FROM sync_runs WHERE id=?',started.id)).state,'queued');
});
test('legacy local importer also sends the incremental range and commits completion',async t=>{
 await setSetting('fireflies_sync',marker);
 t.mock.method(globalThis,'fetch',async(url,options)=>{const body=JSON.parse(options.body);assert.equal(body.variables.since,'2026-09-03T12:00:00.000Z');assert.match(body.query,/fromDate:\$since/);return Response.json({data:{transcripts:[]}});});
 assert.equal((await syncProvider('fireflies')).complete,true);assert.equal(await getSetting('fireflies_page'),null);assert.notEqual((await getSetting('fireflies_sync')).through,marker.through);
});
test('resuming an older completion cannot move successful coverage backwards',async()=>{
 await setSetting('fireflies_sync',marker);const completed=await firefliesCompletedSettings({participant:marker.participant,boundary:'2026-08-01T00:00:00Z'});assert.equal(completed.fireflies_sync.through,marker.through);
});
test('durable retries keep the incremental cursor and advance the marker only on completion',async t=>{
 await setSetting('fireflies_sync',marker);const {id}=await startSync('fireflies'),dispatch=(await prepareDispatches()).find(r=>r.id===id);let failure=false;
 t.mock.method(globalThis,'fetch',async(url,options)=>{const {skip}=JSON.parse(options.body).variables;return failure?Response.json({}, {status:401}):Response.json({data:{transcripts:skip===0?[row('durable-fixture')]:[]}});});
 const first=await advanceDurableUnit('sync',id,dispatch.token,'first-workflow',0);assert.equal(first.done,false);failure=true;
 const failed=await advanceDurableUnit('sync',id,dispatch.token,'first-workflow',first.revision);assert.equal(failed.failed,true);assert.deepEqual(await getSetting('fireflies_sync'),marker);
 const saved=(await one('SELECT cursor FROM durable_runs WHERE run_id=?',id)).cursor;
 await resumeDurable('sync',id,'fireflies');const resumed=(await prepareDispatches()).find(r=>r.id===id);failure=false;
 const done=await advanceDurableUnit('sync',id,resumed.token,'resumed-workflow',failed.revision);assert.equal(done.done,true);assert.equal((await getSetting('fireflies_sync')).through,saved.boundary);assert.equal((await one('SELECT imported FROM sync_runs WHERE id=?',id)).imported,1);
});
