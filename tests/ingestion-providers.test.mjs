import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const privateDir=mkdtempSync(join(tmpdir(),'focus-ingestion-providers-'));process.env.XIN_DATA_DIR=privateDir;
delete process.env.VERCEL;delete process.env.XIN_SECRET_STORAGE;
process.env.XIN_ALLOWED_EMAIL='owner@example.com';
process.env.GOOGLE_CLIENT_ID='fixture-client.apps.googleusercontent.com';process.env.GOOGLE_CLIENT_SECRET='fixture-client-secret';
const {initialProviderCursor:initialWithFreshness,advanceProvider}=await import('../lib/ingestion-providers.mjs');
const {saveSecrets,secrets,updateSecrets}=await import('../lib/secret-store.mjs');
const {getSetting,setSetting,transaction,upsertSource,one}=await import('../lib/db.mjs');
// Core checkpoint tests start after the independently tested recent-mail pass.
async function initialProviderCursor(provider){const cursor=await initialWithFreshness(provider);delete cursor.freshness;cursor.lastFreshAt=new Date().toISOString();return cursor;}
const fixtureTokens={access_token:'fixture-access-secret',refresh_token:'fixture-refresh-secret',expires_at:Date.now()+3600000};
const message=id=>({id,threadId:'thread-'+id,internalDate:'1760000000000',labelIds:['INBOX'],payload:{mimeType:'text/plain',headers:[{name:'Subject',value:'Fictional subject '+id}],body:{data:Buffer.from('Fictional content for '+id).toString('base64url')}}});
test.beforeEach(async()=>{for(const key of ['gmail_query','gmail_page','gmail_history','gmail_email','granola_page','granola_since','fireflies_page','fireflies_sync'])await setSetting(key,null);await setSetting('gmail_query','-in:spam -in:trash');await saveSecrets({gmail_tokens:{...fixtureTokens},granola_key:'fixture-granola-secret',fireflies_key:'fixture-fireflies-secret'});});
async function saveAdvance(provider,cursor){const value=await advanceProvider(provider,cursor);await transaction(async()=>{for(const record of value.records)await upsertSource(record.doc,record.raw);for(const [key,item]of Object.entries(value.settings||{}))await setSetting(key,item);await setSetting('fixture_cursor',value.cursor);});return{...value,cursor:await getSetting('fixture_cursor')};}

test('Gmail checkpoints every message and commits its watermark only with the last record',async t=>{
 const calls=[];t.mock.method(global,'fetch',async url=>{const u=new URL(url);calls.push(u.pathname+u.search);if(u.pathname.endsWith('/profile'))return Response.json({historyId:'100',emailAddress:'owner@example.com'});if(u.pathname.endsWith('/messages'))return Response.json({messages:[{id:'gmail-first'},{id:'gmail-second'}]});return Response.json(message(u.pathname.split('/').at(-1)));});
 let cursor=await initialProviderCursor('gmail');({cursor}=await saveAdvance('gmail',cursor));({cursor}=await saveAdvance('gmail',cursor));const listCursor=structuredClone(cursor);
 const first=await saveAdvance('gmail',cursor);assert.deepEqual(listCursor.pendingIds,['gmail-first','gmail-second']);assert.deepEqual(first.cursor.pendingIds,['gmail-second']);assert.equal(await getSetting('gmail_history'),null);assert.equal(first.records[0].doc.external_id,'gmail-first');
 const next=await saveAdvance('gmail',first.cursor);assert.equal(next.complete,true);assert.equal(next.records[0].doc.external_id,'gmail-second');assert.equal(await getSetting('gmail_history'),'100');assert.equal(await getSetting('gmail_page'),null);
 assert.equal(calls.filter(value=>value.includes('/messages?')).length,1);assert.match(calls.at(-1),/messages\/gmail-second\?format=full$/);
 assert.equal(JSON.stringify(next).includes('fixture-access-secret'),false);assert.equal(JSON.stringify(first).includes('fixture-refresh-secret'),false);
});

test('Gmail continues a full backfill beyond 1,000 messages without manual continuation',async t=>{
 let messageCount=0,listCount=0;t.mock.method(global,'fetch',async url=>{const u=new URL(url);if(u.pathname.endsWith('/profile'))return Response.json({historyId:'bulk-anchor',emailAddress:'owner@example.com'});if(u.pathname.endsWith('/messages')){listCount++;const page=Number(u.searchParams.get('pageToken')||0),start=page*100;return Response.json({messages:Array.from({length:Math.min(100,1001-start)},(_,i)=>({id:'bulk-'+(start+i)})),...(start+100<1001?{nextPageToken:String(page+1)}:{})});}messageCount++;return Response.json(message(u.pathname.split('/').at(-1)));});
 let cursor=await initialProviderCursor('gmail'),result;
 for(let i=0;i<1100;i++){result=await advanceProvider('gmail',cursor);cursor=result.cursor;if(result.complete)break;assert.equal(result.settings.gmail_history,undefined);}
 assert.equal(result.complete,true);assert.equal(messageCount,1001);assert.equal(listCount,11);assert.equal(result.settings.gmail_history,'bulk-anchor');
});

test('Gmail history resumes per message across pages, deduplicates event types, and delays the history watermark',async t=>{
 await setSetting('gmail_history','200');const calls=[];
 t.mock.method(global,'fetch',async url=>{const u=new URL(url);calls.push(u);if(u.pathname.endsWith('/history')){assert.equal(u.searchParams.get('startHistoryId'),'200');return Response.json(u.searchParams.has('pageToken')?{history:[{messagesDeleted:[{message:{id:'history-third'}}]}],historyId:'204'}:{history:[{messages:[{id:'history-first'}],messagesAdded:[{message:{id:'history-first'}},{message:{id:'history-second'}}]}],nextPageToken:'history-page-2',historyId:'203'});}return Response.json(message(u.pathname.split('/').at(-1)));});
 let cursor=await initialProviderCursor('gmail');assert.equal(cursor.mode,'history');({cursor}=await saveAdvance('gmail',cursor));assert.deepEqual(cursor.pendingIds,['history-first','history-second']);
 ({cursor}=await saveAdvance('gmail',cursor));assert.deepEqual(cursor.pendingIds,['history-second']);assert.equal(await getSetting('gmail_history'),'200');
 ({cursor}=await saveAdvance('gmail',cursor));assert.equal(cursor.phase,'list');assert.equal(await getSetting('gmail_history'),'200');
 ({cursor}=await saveAdvance('gmail',cursor));assert.deepEqual(cursor.pendingIds,['history-third']);assert.equal(await getSetting('gmail_history'),'200');
 const final=await saveAdvance('gmail',cursor);assert.equal(final.complete,true);assert.equal(await getSetting('gmail_history'),'204');assert.equal(calls.filter(url=>url.pathname.endsWith('/history')).length,2);
});

test('Gmail expired history falls back durably to a fresh full import',async t=>{
 await setSetting('gmail_history','expired-anchor');let calls=0;
 t.mock.method(global,'fetch',async url=>{calls++;const u=new URL(url);if(u.pathname.endsWith('/history'))return Response.json({error:{message:'do not surface fixture-access-secret'}},{status:404});if(u.pathname.endsWith('/profile'))return Response.json({historyId:'new-anchor',emailAddress:'owner@example.com'});return Response.json({messages:[]});});
 let cursor=await initialProviderCursor('gmail');const expired=await saveAdvance('gmail',cursor);assert.equal(expired.complete,false);assert.equal(expired.cursor.phase,'profile');assert.equal(await getSetting('gmail_history'),null);assert.doesNotMatch(JSON.stringify(expired),/fixture-access-secret/);
 ({cursor}=await saveAdvance('gmail',expired.cursor));const done=await saveAdvance('gmail',cursor);assert.equal(done.complete,true);assert.equal(await getSetting('gmail_history'),'new-anchor');assert.equal(calls,3);
});

test('Gmail adopts an existing backfill checkpoint and tombstones a deleted stored message',async t=>{
 const raw=message('deleted-message');await upsertSource((await import('../lib/connectors.mjs')).normalizeGmail(raw),raw);
 await setSetting('gmail_page',{pageToken:'legacy-page',historyId:'legacy-anchor',query:'-in:spam -in:trash'});
 t.mock.method(global,'fetch',async url=>{const u=new URL(url);if(u.pathname.endsWith('/messages')){assert.equal(u.searchParams.get('pageToken'),'legacy-page');return Response.json({messages:[{id:'deleted-message'},{id:'never-stored'}]});}return Response.json({error:{}},{status:404});});
 let cursor=await initialProviderCursor('gmail');assert.equal(cursor.phase,'list');({cursor}=await saveAdvance('gmail',cursor));({cursor}=await saveAdvance('gmail',cursor));assert.equal((await one('SELECT coverage FROM sources WHERE id=?','gmail:deleted-message')).coverage,'deleted upstream');
 const done=await saveAdvance('gmail',cursor);assert.equal(done.records.length,0);assert.equal(done.complete,true);assert.equal(await getSetting('gmail_history'),'legacy-anchor');
});

test('Granola stages every transcript page privately and resumes at the next note without repeating its list',async t=>{
 const calls=[];t.mock.method(global,'fetch',async url=>{const u=new URL(url);calls.push(u.pathname+u.search);if(u.pathname==='/v1/notes')return Response.json({notes:[{id:'granola-first'},{id:'granola-second'}],hasMore:false,cursor:null});if(u.pathname.endsWith('/transcript'))return Response.json(u.searchParams.has('cursor')?{transcript:[{text:'Final fictional sentence',speaker:{name:'Jo'}}],hasMore:false,cursor:null}:{transcript:[{text:'First fictional sentence',speaker:{name:'Casey'}}],hasMore:true,cursor:'transcript-2'});return Response.json({id:u.pathname.split('/').at(-1),title:'Fictional meeting',summary_text:'Fictional summary',created_at:'2026-01-01T00:00:00.000Z',transcript:[{text:'Partial inline transcript must not be saved'}]});});
 let cursor=await initialProviderCursor('granola');({cursor}=await saveAdvance('granola',cursor));({cursor}=await saveAdvance('granola',cursor));const beforePage=structuredClone(cursor);assert.equal(await one("SELECT id FROM sources WHERE id='granola:granola-first'"),undefined);
 const page=await advanceProvider('granola',cursor),replayed=await advanceProvider('granola',beforePage);assert.deepEqual(replayed,page);assert.equal(page.records.length,0);assert.equal(beforePage.parts.length,0);
 ({cursor}=await saveAdvance('granola',beforePage));assert.equal(cursor.parts.length,1);assert.equal(cursor.transcriptToken,'transcript-2');assert.equal(await one("SELECT id FROM sources WHERE id='granola:granola-first'"),undefined);
 const first=await saveAdvance('granola',cursor);assert.equal(first.records.length,1);assert.match(first.records[0].doc.body,/First fictional sentence[\s\S]*Final fictional sentence/);assert.doesNotMatch(first.records[0].doc.body,/Partial inline/);assert.equal(first.records[0].raw.transcript.length,2);assert.equal(first.cursor.note,undefined);assert.deepEqual(first.cursor.pendingIds,['granola-second']);
 await saveAdvance('granola',first.cursor);assert.match(calls.at(-1),/\/notes\/granola-second$/);assert.equal(calls.filter(path=>path.startsWith('/v1/notes?')).length,1);assert.equal(await getSetting('granola_since'),null);
});

test('Granola records completion only after the final transcript page and preserves legacy page progress',async t=>{
 await setSetting('granola_page',{cursor:'legacy-granola',since:'2026-01-01T00:00:00Z',started:'2026-01-02T00:00:00Z'});
 t.mock.method(global,'fetch',async url=>{const u=new URL(url);if(u.pathname==='/v1/notes'){assert.equal(u.searchParams.get('cursor'),'legacy-granola');return Response.json({notes:[{id:'granola-final'}],hasMore:false,cursor:null});}if(u.pathname.endsWith('/transcript'))return Response.json({transcript:[],hasMore:false,cursor:null});return Response.json({id:'granola-final',summary_text:'A fictional summary.'});});
 let cursor=await initialProviderCursor('granola');for(let step=0;step<2;step++)({cursor}=await saveAdvance('granola',cursor));assert.equal(await getSetting('granola_since'),null);
 const done=await saveAdvance('granola',cursor);assert.equal(done.complete,true);assert.equal(done.records[0].doc.coverage,'summary');assert.equal(await getSetting('granola_since'),'2026-01-01T23:59:00.000Z');assert.equal(await getSetting('granola_page'),null);
});

test('Fireflies processes a single recording using the same snapshot boundary after recovery',async t=>{
 await setSetting('fireflies_page',{skip:9,boundary:'2026-02-01T00:00:00Z',participant:'owner@example.com'});let calls=0;
 t.mock.method(global,'fetch',async(_url,options)=>{calls++;const args=JSON.parse(options.body);assert.match(args.query,/transcripts\(limit:1,/);assert.equal(args.variables.until,'2026-02-01T00:00:00Z');assert.deepEqual(args.variables.participants,['owner@example.com']);return Response.json({data:{transcripts:args.variables.skip===9?[{id:'fireflies-one',sentences:[{speaker_name:'Jo',text:'Fictional discussion',start_time:0}]}]:[]}});});
 const initial=await initialProviderCursor('fireflies'),first=await saveAdvance('fireflies',initial);assert.equal(first.cursor.skip,10);assert.equal(first.records.length,1);assert.equal(initial.skip,9);assert.equal((await getSetting('fireflies_page')).skip,10);
 const done=await saveAdvance('fireflies',first.cursor);assert.equal(done.complete,true);assert.equal(await getSetting('fireflies_page'),null);assert.equal(calls,2);
});

test('both Fireflies import paths use the participant type required by its GraphQL schema',async t=>{
 const queries=[];
 t.mock.method(global,'fetch',async(_url,options)=>{queries.push(JSON.parse(options.body).query);return Response.json({data:{transcripts:[]}});});
 await advanceProvider('fireflies',await initialProviderCursor('fireflies'));
 const {syncProvider}=await import('../lib/connectors.mjs');await syncProvider('fireflies');
 assert.equal(queries.length,2);for(const query of queries)assert.match(query,/\$participants\s*:\s*\[String!\]/);
});

test('provider rate limits return retry metadata without sleeping or leaking response text',async t=>{
 let calls=0;t.mock.method(global,'fetch',async()=>{calls++;return Response.json({error:{message:'fixture-refresh-secret',details:[{'@type':'type.googleapis.com/google.rpc.ErrorInfo',reason:'RATE_LIMIT_EXCEEDED'},{'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'12s'}]}},{status:403,headers:{'retry-after':'5'}});});
 const cursor=await initialProviderCursor('gmail');await assert.rejects(advanceProvider('gmail',cursor),error=>{assert.equal(error.permanent,false);assert.equal(error.retryAfterMs,12000);assert.equal(error.providerReason,'RATE_LIMIT_EXCEEDED');assert.equal(error.status,403);assert.doesNotMatch(error.message+JSON.stringify(error),/fixture-refresh-secret/);return true;});assert.equal(calls,1);assert.equal(cursor.phase,'profile');
});

test('Fireflies GraphQL limits respect retryAfter while authentication failures are permanent',async t=>{
 const retryAt=Date.now()+30000;t.mock.method(global,'fetch',async()=>Response.json({errors:[{message:'fixture-fireflies-secret',extensions:{status:429,code:'too_many_requests',metadata:{retryAfter:retryAt}}}]}));
 const cursor=await initialProviderCursor('fireflies');await assert.rejects(advanceProvider('fireflies',cursor),error=>error.permanent===false&&error.retryAfterMs>25000&&!error.message.includes('fixture-fireflies-secret'));
 t.mock.method(global,'fetch',async()=>Response.json({errors:[{message:'fixture-fireflies-secret',extensions:{status:401,code:'auth_failed'}}]}));await assert.rejects(advanceProvider('fireflies',cursor),error=>error.permanent===true&&error.retryAfterMs===0&&error.status===401&&!JSON.stringify(error).includes('fixture-fireflies-secret'));
});

test('Gmail refresh is one bounded advance, preserves concurrent credentials, and never enters a cursor',async t=>{
 await saveSecrets({gmail_tokens:{...fixtureTokens,expires_at:0},granola_key:'fixture-granola-secret'});let calls=0;
 t.mock.method(global,'fetch',async(url,options)=>{calls++;assert.equal(String(url),'https://oauth2.googleapis.com/token');assert.equal(options.body.get('refresh_token'),'fixture-refresh-secret');await updateSecrets(current=>{current.fireflies_key='fixture-new-fireflies-secret';});return Response.json({access_token:'fixture-renewed-access-secret',expires_in:3600});});
 const cursor=await initialProviderCursor('gmail'),refreshed=await advanceProvider('gmail',cursor);assert.deepEqual(refreshed.cursor,cursor);assert.equal(refreshed.records.length,0);assert.equal(calls,1);assert.equal((await secrets()).fireflies_key,'fixture-new-fireflies-secret');assert.equal((await secrets()).gmail_tokens.access_token,'fixture-renewed-access-secret');
 for(const secret of ['fixture-refresh-secret','fixture-renewed-access-secret','fixture-client-secret','fixture-new-fireflies-secret'])assert.equal(JSON.stringify(refreshed).includes(secret),false);
});

test('oversized responses and invalid transcript cursors fail without committing partial coverage',async t=>{
 t.mock.method(global,'fetch',async()=>new Response('{}',{headers:{'content-length':String(8*1024*1024+1)}}));const initial=await initialProviderCursor('granola');await assert.rejects(advanceProvider('granola',initial),error=>error.permanent&&error.code==='oversized');
 const partial={...initial,phase:'transcript',pendingIds:['granola-too-large'],note:{id:'granola-too-large'},parts:[{text:'Saved private fragment'}],transcriptToken:'repeated',transcriptPages:1};
 t.mock.method(global,'fetch',async()=>Response.json({transcript:[{text:'A new fragment'}],hasMore:true,cursor:'repeated'}));await assert.rejects(advanceProvider('granola',partial),error=>error.permanent&&error.code==='cursor');assert.equal(partial.parts.length,1);assert.equal(await one("SELECT id FROM sources WHERE id='granola:granola-too-large'"),undefined);
});

test('network errors and OAuth response details are sanitized before reaching Workflow events',async t=>{
 t.mock.method(global,'fetch',async()=>{throw Error('Network error fixture-client-secret');});await assert.rejects(advanceProvider('gmail',await initialProviderCursor('gmail')),error=>error.permanent===false&&error.code==='network'&&!error.message.includes('fixture-client-secret'));
 await updateSecrets(current=>{current.gmail_tokens.expires_at=0;});t.mock.method(global,'fetch',async()=>Response.json({error:'invalid_grant',error_description:'fixture-client-secret'},{status:400}));await assert.rejects(advanceProvider('gmail',await initialProviderCursor('gmail')),error=>error.permanent&&error.gmailCode==='gmail_refresh'&&error.providerCode==='invalid_grant'&&!JSON.stringify(error).includes('fixture-client-secret'));
});

test.after(()=>rmSync(privateDir,{recursive:true,force:true}));

test('recent Gmail is ingested before the old backlog without moving either saved watermark',async t=>{
 const saved={query:'-in:spam -in:trash',historyId:'old',pageToken:'old-page'};await setSetting('gmail_page',saved);await setSetting('gmail_history','history-old');
 t.mock.method(global,'fetch',async url=>{const u=new URL(url);if(u.pathname.endsWith('/messages')){assert.match(u.searchParams.get('q'),/newer_than:7d/);assert.equal(u.searchParams.get('pageToken'),null);return Response.json({messages:[{id:'fresh-first'}]});}return Response.json(message('fresh-first'));});
 let cursor=await initialWithFreshness('gmail');({cursor}=await saveAdvance('gmail',cursor));
 const fresh=await saveAdvance('gmail',cursor);assert.equal(fresh.records[0].doc.external_id,'fresh-first');assert.equal(fresh.complete,false);assert.equal(fresh.cursor.freshness,undefined);assert.equal(fresh.cursor.pageToken,'old-page');assert.equal(await getSetting('gmail_history'),'history-old');assert.deepEqual(await getSetting('gmail_page'),saved);
});

test('long-running Gmail history periodically checks new arrivals and preserves its current page',async t=>{
 await setSetting('gmail_history','history-anchor');const cursor=await initialProviderCursor('gmail');cursor.lastFreshAt='2020-01-01';cursor.pendingIds=['old-pending'];cursor.phase='message';
 t.mock.method(global,'fetch',async url=>{const u=new URL(url);assert.ok(u.pathname.endsWith('/messages'));assert.match(u.searchParams.get('q'),/newer_than:7d/);return Response.json({messages:[]});});
 const result=await advanceProvider('gmail',cursor);assert.equal(result.complete,false);assert.deepEqual(result.cursor.pendingIds,['old-pending']);assert.equal(result.cursor.historyId,'history-anchor');assert.ok(Date.parse(result.cursor.lastFreshAt)>Date.parse(cursor.lastFreshAt));assert.deepEqual(result.settings,{});
});
