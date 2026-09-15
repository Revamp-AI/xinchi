import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const temp=mkdtempSync(join(tmpdir(),'focus-provider-retry-'));process.env.XIN_DATA_DIR=temp;
const db=await import('../lib/db.mjs');
const conn=await import('../lib/connectors.mjs');
const {gmailFailureCode}=await import('../lib/auth-messages.mjs');
const quota=()=>Response.json({error:{details:[{'@type':'type.googleapis.com/google.rpc.ErrorInfo',reason:'RATE_LIMIT_EXCEEDED'},{'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'12s'}]}},{status:403,headers:{'Retry-After':'15'}});
function noWait(t){const delays=[],original=globalThis.setTimeout;t.mock.method(globalThis,'setTimeout',(callback,ms,...args)=>{if(ms<15000)return original(callback,ms,...args);delays.push(ms);queueMicrotask(callback);return 0;});return delays;}
test('Google 403 quota errors honor retry instructions and retry the same request',async t=>{
 const delays=noWait(t),calls=[],notices=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});return calls.length===1?quota():Response.json({ok:true});});
 const result=await conn.request('https://gmail.googleapis.com/test',{headers:{Authorization:'Bearer fixture'},onRetry:n=>notices.push(n)});
 assert.deepEqual(result,{ok:true});assert.equal(delays[0],15000);assert.equal(notices[0].rateLimited,true);
 assert.equal(calls[0].url,calls[1].url);assert.deepEqual(calls[0].options.headers,calls[1].options.headers);assert.equal(calls[1].options.onRetry,undefined);
});
test('disabled APIs and denied permissions fail immediately; quota retries are bounded',async t=>{
 const delays=noWait(t);let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({error:{errors:[{reason:'accessNotConfigured'}]}},{status:403});});
 await assert.rejects(()=>conn.request('https://gmail.googleapis.com/test'),e=>gmailFailureCode(e)==='gmail_api_disabled');assert.equal(calls,1);assert.equal(delays.length,0);
 t.mock.method(globalThis,'fetch',async()=>Response.json({error:{message:'Access denied'}},{status:403}));
 await assert.rejects(()=>conn.request('https://gmail.googleapis.com/test'),e=>gmailFailureCode(e)==='gmail_permission');assert.equal(delays.length,0);
 t.mock.method(globalThis,'fetch',async()=>{calls++;return quota();});const before=calls;
 await assert.rejects(()=>conn.request('https://gmail.googleapis.com/test'),e=>gmailFailureCode(e)==='gmail_rate_limit');assert.equal(calls-before,7);assert.equal(delays.length,6);
});
test('Gmail resumes a rate-limited message without losing pagination or duplicating records',async t=>{
 noWait(t);const notices=[];let secondAttempts=0;
 await conn.saveSecrets({google_client:{client_id:'fixture',client_secret:'fixture'},gmail_tokens:{access_token:'fixture',refresh_token:'fixture',expires_at:Date.now()+3600000}});
 t.mock.method(globalThis,'fetch',async url=>{
  const u=new URL(url);
  if(u.pathname.endsWith('/profile'))return Response.json({emailAddress:'owner@example.com',historyId:'h-start'});
  if(u.pathname.endsWith('/messages'))return Response.json(u.searchParams.get('pageToken')?{messages:[{id:'m2'}]}:{messages:[{id:'m1'}],nextPageToken:'page2'});
  const id=u.pathname.split('/').pop();if(id==='m2'&&secondAttempts++===0)return quota();
  return Response.json({id,threadId:id,internalDate:'1789401600000',payload:{headers:[{name:'Subject',value:'Fictional message '+id}],mimeType:'text/plain',body:{data:Buffer.from('Fictional context').toString('base64url')}}});
 });
 const result=await conn.syncProvider('gmail',()=>{},n=>notices.push(n));
 assert.equal(result.complete,true);assert.equal(result.total,2);assert.equal(secondAttempts,2);assert.match(notices[0],/rate limit.*15 seconds/);
 assert.equal((await db.one("SELECT COUNT(*) AS n FROM sources WHERE provider='gmail'")).n,2);assert.equal((await db.getSetting('gmail_page')),null);assert.equal((await db.getSetting('gmail_history')),'h-start');
});
test.after(async ()=>{(await db.db.close());rmSync(temp,{recursive:true,force:true});});
