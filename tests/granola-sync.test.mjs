import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
process.env.XIN_ALLOWED_EMAIL='owner@example.com';process.env.XIN_AGENT_MODE='cloud';process.env.XIN_SECRET_STORAGE='postgres';process.env.XIN_SECRETS_KEY=randomBytes(32).toString('base64url');
const {initialProviderCursor,advanceProvider}=await import('../lib/ingestion-providers.mjs');
const {granolaCompletedSettings}=await import('../lib/granola-sync.mjs');
const {startSync,syncProvider}=await import('../lib/connectors.mjs');
const {saveSecrets}=await import('../lib/secret-store.mjs');
const {setSetting,getSetting,one,run,transaction,upsertSource}=await import('../lib/db.mjs');
const {prepareDispatches,advanceDurableUnit,resumeDurable}=await import('../lib/durable-ingestion.mjs');
const note=id=>({id,title:'Fictional shared meeting '+id,updated_at:'2025-01-01T00:00:00Z',created_at:'2025-01-01T00:00:00Z',summary_text:'Fictional summary'});
test.beforeEach(async()=>{await run('TRUNCATE durable_runs,sync_runs,contact_runs,sources CASCADE');for(const key of ['granola_page','granola_since'])await setSetting(key,null);await saveSecrets({granola_key:'fictional-granola-key'});});
async function advance(cursor){const value=await advanceProvider('granola',cursor);await transaction(async()=>{for(const r of value.records)await upsertSource(r.doc,r.raw);for(const [k,v]of Object.entries(value.settings))await setSetting(k,v);});return value;}
async function complete(){let cursor=await initialProviderCursor('granola');for(let i=0;i<30;i++){const result=await advance(cursor);if(result.complete)return result;cursor=result.cursor;}assert.fail('Import did not finish');}
function provider(t,rows){const calls=[];t.mock.method(global,'fetch',async url=>{const u=new URL(url);calls.push(u);if(u.pathname==='/v1/notes'){assert.equal(u.searchParams.has('updated_after'),false);return Response.json({notes:rows(),hasMore:false});}if(u.pathname.endsWith('/transcript'))return Response.json({transcript:[{text:'A fictional complete transcript.'}],hasMore:false});return Response.json(note(u.pathname.split('/').at(-1)));});return calls;}
test('a later refresh discovers an old shared note that was unavailable at the previous watermark',async t=>{
 await setSetting('granola_since',new Date().toISOString());let ready=false;const calls=provider(t,()=>ready?[note('shared-old')]:[]);
 await complete();assert.equal(await one("SELECT id FROM sources WHERE id='granola:shared-old'"),undefined);
 ready=true;await complete();assert.equal((await one("SELECT coverage FROM sources WHERE id='granola:shared-old'")).coverage,'transcript');
 calls.length=0;await complete();assert.equal(calls.length,1,'unchanged transcript only needs a metadata listing');
});
test('every list page is inspected even when the first page contains only unchanged notes',async t=>{
 provider(t,()=>[note('known')]);await complete();
 const calls=[];t.mock.method(global,'fetch',async url=>{const u=new URL(url);calls.push(u);if(u.pathname==='/v1/notes')return Response.json(u.searchParams.has('cursor')?{notes:[note('newly-shared')],hasMore:false}:{notes:[note('known')],hasMore:true,cursor:'older-page'});if(u.pathname.endsWith('/transcript'))return Response.json({transcript:[{text:'Older shared context.'}],hasMore:false});return Response.json(note('newly-shared'));});
 await complete();assert.equal(calls.filter(u=>u.pathname==='/v1/notes').length,2);assert.ok(await one("SELECT id FROM sources WHERE id='granola:newly-shared'"));
});
test('history rescan re-fetches unchanged bodies and cannot replace an active import',async t=>{
 const calls=provider(t,()=>[note('known')]);await complete();calls.length=0;
 await startSync('granola',{rescan:true});assert.equal((await getSetting('granola_page')).rescan,true);
 await assert.rejects(startSync('granola',{rescan:true}),/already running/);
 await complete();assert.equal(calls.length,3);
});
test('missing metadata and incomplete coverage are retried by the local importer too',async t=>{
 await upsertSource({provider:'granola',external_id:'incomplete',title:note('incomplete').title,body:'Summary only',coverage:'summary'},note('incomplete'));
 const calls=provider(t,()=>[note('incomplete'),{id:'no-date',title:note('no-date').title}]);
 assert.equal((await syncProvider('granola')).total,2);calls.length=0;assert.equal((await syncProvider('granola')).total,1);assert.equal(calls.length,3);
});
test('disappearing or processing notes do not block later notes or save partial transcripts',async t=>{
 t.mock.method(global,'fetch',async url=>{const u=new URL(url);if(u.pathname==='/v1/notes')return Response.json({notes:[note('gone'),note('processing'),note('ready')],hasMore:false});if(u.pathname.endsWith('/gone')||u.pathname.endsWith('/processing/transcript'))return Response.json({}, {status:404});if(u.pathname.endsWith('/transcript'))return Response.json({transcript:[{text:'Complete context'}],hasMore:false});return Response.json(note(u.pathname.split('/').at(-1)));});
 await complete();assert.equal(await one("SELECT id FROM sources WHERE id='granola:gone'"),undefined);assert.equal(await one("SELECT id FROM sources WHERE id='granola:processing'"),undefined);assert.ok(await one("SELECT id FROM sources WHERE id='granola:ready'"));
});
test('durable retry preserves the exact page and phase, and old completion cannot rewind progress',async t=>{
 await setSetting('granola_page',{cursor:'saved-page',since:'2025-01-01T00:00:00Z',started:'2025-02-01T00:00:00Z'});const watermark='2026-09-01T00:00:00Z';await setSetting('granola_since',watermark);
 let failed=false;const calls=[];t.mock.method(global,'fetch',async url=>{const u=new URL(url);calls.push(u);if(u.pathname==='/v1/notes'){assert.equal(u.searchParams.get('cursor'),'saved-page');assert.equal(u.searchParams.get('updated_after'),'2025-01-01T00:00:00Z');return Response.json({notes:[note('resumed')],hasMore:false});}if(failed)return Response.json({}, {status:401});if(u.pathname.endsWith('/transcript'))return Response.json({transcript:[{text:'Resumed context'}],hasMore:false});return Response.json(note('resumed'));});
 const {id}=await startSync('granola');let dispatch=(await prepareDispatches()).find(r=>r.id===id);let result=await advanceDurableUnit('sync',id,dispatch.token,'first',0);failed=true;result=await advanceDurableUnit('sync',id,dispatch.token,'first',result.revision);assert.equal(result.failed,true);
 await resumeDurable('sync',id,'granola');dispatch=(await prepareDispatches()).find(r=>r.id===id);failed=false;
 for(let i=0;i<2;i++)result=await advanceDurableUnit('sync',id,dispatch.token,'retry',result.revision);
 assert.equal(result.done,true);assert.equal(calls.filter(u=>u.pathname==='/v1/notes').length,1);assert.equal(await getSetting('granola_since'),watermark);assert.equal((await granolaCompletedSettings({started:'2024-01-01'})).granola_since,watermark);
});
