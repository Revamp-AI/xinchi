import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,utimes,unlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {acquireCompanionLock,authorizeBeeper,authorizeBeeperWithRetry,requestJson,selectChats,chooseChats,syncTick} from '../public/beeper-companion.mjs';

const fictionalChat=id=>({id,accountID:'example-account',type:'single',participants:{items:[]}});
const beeperError=status=>Object.assign(Error('Beeper unavailable'),{service:'beeper',status});
function uploadState(){return{run:{id:'fictional-run',started_at:new Date().toISOString(),cutoff:Date.now()-2*86400000,chatIndex:0,part:7,cursor:null}};}

test('a disappeared conversation returning 500 does not block later conversations and remains selected for retry',async()=>{
 const config={selection:[fictionalChat('missing'),fictionalChat('available')]},state=uploadState(),paths=[];
 const options={requestCloud:async()=>({}),save:async()=>{},requestLocal:async(_config,path)=>{
  paths.push(path);if(path==='/v1/chats/missing')throw beeperError(500);
  if(path==='/v1/chats')return{items:[fictionalChat('available')],hasMore:true,oldestCursor:'next-page'};
  if(path==='/v1/chats?cursor=next-page&direction=before')return{items:[],hasMore:false};
  if(path==='/v1/chats/available')return fictionalChat('available');assert.fail(path);
 }};
 assert.match(await syncTick(config,state,options),/unavailable/);
 assert.equal(state.run.chatIndex,1);assert.equal(state.run.part,7);assert.deepEqual(state.unavailableChats,['missing']);assert.equal(config.selection.length,2);
 assert.ok(paths.includes('/v1/chats?cursor=next-page&direction=before'));
 assert.equal(await syncTick(config,state,options),'Conversation ready');assert.equal(state.run.chat.id,'available');
});

test('a returning conversation retries 90 days and clears its unavailable marker only after its batch is saved',async()=>{
 const chat=fictionalChat('returned'),config={selection:[chat]},state={...uploadState(),unavailableChats:[chat.id]};let saved;
 const message={id:'older-message',timestamp:new Date(Date.now()-14*86400000).toISOString(),text:'Fictional earlier message'};
 const options={requestCloud:async(_config,action,body)=>{if(action==='batch')saved=body;return{};},save:async()=>{},requestLocal:async(_config,path)=>path.endsWith('/messages')?{items:[message],hasMore:false}:chat};
 await syncTick(config,state,options);await syncTick(config,state,options);
 assert.deepEqual(state.unavailableChats,[chat.id]);assert.equal(state.run.pending.batches[0][0].message.id,message.id);
 const restarted=structuredClone(state);await syncTick(config,restarted,options);
 assert.equal(saved.part,7);assert.equal(saved.records[0].message.id,message.id);assert.deepEqual(restarted.unavailableChats,[]);assert.equal(restarted.run.chatIndex,1);
});

test('listed conversations, failed enumeration, and authorization errors cannot be silently skipped',async()=>{
 const chat=fictionalChat('selected'),config={selection:[chat]};
 for(const scenario of ['listed','list-failed','auth']){
  const state=uploadState(),before=structuredClone(state),paths=[];
  await assert.rejects(syncTick(config,state,{requestCloud:async()=>({}),save:()=>assert.fail('Must retain checkpoint'),requestLocal:async(_config,path)=>{
   paths.push(path);if(path!=='/v1/chats')throw beeperError(scenario==='auth'?401:500);
   if(scenario==='list-failed')throw beeperError(500);return{items:[chat],hasMore:false};
  }}),/Beeper unavailable/);
  assert.deepEqual(state,before);if(scenario==='auth')assert.equal(paths.length,1);
 }
});

test('a conversation disappearing during pagination preserves already uploaded batches',async()=>{
 const chat=fictionalChat('missing'),config={selection:[chat]},state=uploadState();state.run.chat=chat;state.run.cursor='saved-cursor';
 await syncTick(config,state,{requestCloud:async()=>({}),save:async()=>{},requestLocal:async(_config,path)=>{
  if(path.startsWith('/v1/chats/missing/messages'))throw beeperError(404);return{items:[],hasMore:false};
 }});
 assert.equal(state.run.part,7);assert.equal(state.run.chatIndex,1);assert.equal(state.run.cursor,null);assert.equal(state.run.chat,null);assert.deepEqual(state.unavailableChats,['missing']);
});

async function lockHome(t){const directory=await mkdtemp(join(tmpdir(),'focus-beeper-lock-'));t.after(()=>rm(directory,{recursive:true,force:true}));return directory;}

test('a PID reused after a restart cannot block the companion or erase its pairing and checkpoint',async t=>{
 const directory=await lockHome(t),path=join(directory,'companion.pid');
 const config='{"token":"fictional-token"}',state='{"run":{"id":"fictional-run","part":33,"chatIndex":36}}';
 await writeFile(join(directory,'config.json'),config);await writeFile(join(directory,'state.json'),state);
 await writeFile(path,String(process.pid));await utimes(path,new Date('2000-01-01'),new Date('2000-01-01'));
 const release=await acquireCompanionLock(directory);t.after(release);
 assert.equal(JSON.parse(await readFile(path,'utf8')).version,2);
 assert.equal(await readFile(join(directory,'config.json'),'utf8'),config);
 assert.equal(await readFile(join(directory,'state.json'),'utf8'),state);
 process.kill(process.pid,0);
});

test('a live legacy companion keeps its lock and failed acquisition releases the socket',async t=>{
 const directory=await lockHome(t),path=join(directory,'companion.pid');await writeFile(path,String(process.pid));
 await assert.rejects(acquireCompanionLock(directory),/already running/);
 assert.equal(await readFile(path,'utf8'),String(process.pid));await unlink(path);
 const release=await acquireCompanionLock(directory);await release();
});

test('only one companion owns a home directory even when callers start concurrently',async t=>{
 const directory=await lockHome(t),results=await Promise.allSettled([acquireCompanionLock(directory),acquireCompanionLock(directory)]);
 const owners=results.filter(r=>r.status==='fulfilled');for(const owner of owners)t.after(owner.value);
 assert.equal(owners.length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/already running/);
 await owners[0].value();const release=await acquireCompanionLock(directory);await release();await release();
});

test('a killed companion releases its lock automatically despite a surviving PID marker',async t=>{
 const directory=await lockHome(t),moduleUrl=new URL('../public/beeper-companion.mjs',import.meta.url).href;
 const child=spawn(process.execPath,['--input-type=module','-e',`const {acquireCompanionLock}=await import(${JSON.stringify(moduleUrl)});await acquireCompanionLock(process.env.FOCUS_BEEPER_HOME);process.send('ready');`],{env:{...process.env,FOCUS_BEEPER_HOME:directory},stdio:['ignore','ignore','pipe','ipc']});
 const exited=once(child,'exit');t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;});
 await Promise.race([once(child,'message'),exited.then(()=>{throw Error('Companion exited before acquiring its lock.');})]);
 await assert.rejects(acquireCompanionLock(directory),/already running/);
 child.kill('SIGKILL');await exited;
 const path=join(directory,'companion.pid'),marker=JSON.parse(await readFile(path,'utf8'));
 marker.pid=process.pid;await writeFile(path,JSON.stringify(marker));
 const release=await acquireCompanionLock(directory);await release();
});

test('setup automatically selects all 1,732 conversations without a selection prompt or printing their titles',async()=>{
 const chats=Array.from({length:1732},(_,i)=>({id:'chat-'+i,accountID:'account-1',title:'Fictional conversation '+i,network:'Example'})),logs=[];
 const selection=await selectChats(chats,{question:()=>assert.fail('Default setup must not ask for conversation numbers'),log:message=>logs.push(message)});
 assert.deepEqual(selection,chats);assert.equal(logs.length,1);assert.match(logs[0],/All 1732 direct conversations selected/);
 assert.ok(!logs[0].includes('Fictional conversation'));
});

test('optional manual selection supports a subset, all, and the empty default without the old 250-chat cap',async()=>{
 const chats=Array.from({length:300},(_,i)=>({id:'chat-'+i,title:'Fictional conversation',network:'Example'}));
 const selection=await selectChats(chats,{choose:true,question:async()=> '1,300,1',log:()=>{}});
 assert.deepEqual(selection,[chats[0],chats[299]]);
 for(const input of ['', ' ALL ',chats.map((_,i)=>i+1).join(',')])assert.deepEqual(chooseChats(input,chats),chats);
 for(const input of ['301','1,,2','invalid'])assert.throws(()=>chooseChats(input,chats),/conversation numbers/);
 assert.throws(()=>chooseChats('',[]),/No direct conversations/);
});

function oauth({scope='read',revokeFails=false,cancel=false,checkState=false}={}){
 const requests=[];let authorization,callback;
 return{
  requests,
  options:{
   async request(url,options){
    assert.equal(new URL(url).origin,'http://127.0.0.1:23373');
    const path=new URL(url).pathname;requests.push({path,...options});
    if(path==='/oauth/register'){
     assert.equal(options.body.scope,'read');assert.equal(options.body.token_endpoint_auth_method,'none');
     callback=new URL(options.body.redirect_uris[0]);return{client_id:'fictional-client'};
    }
    if(path==='/oauth/token'){
     assert.equal(options.form.code,'fictional-code');assert.equal(options.form.client_id,'fictional-client');
     assert.equal(options.form.redirect_uri,callback.href);
     assert.equal(createHash('sha256').update(options.form.code_verifier).digest('base64url'),authorization.searchParams.get('code_challenge'));
     return{access_token:'fictional-token',scope};
    }
    if(path==='/oauth/revoke'){
     assert.equal(options.method,'POST');assert.deepEqual(options.form,{token:'fictional-token',token_type_hint:'access_token'});
     assert.equal(options.allowEmpty,true);if(revokeFails)throw Error('Beeper unavailable');return{};
    }
    assert.fail('Unexpected request: '+path);
   },
   async open(url){
    authorization=new URL(url);
    assert.equal(authorization.searchParams.get('scope'),'read');assert.equal(authorization.searchParams.get('code_challenge_method'),'S256');
    assert.equal(authorization.searchParams.get('redirect_uri'),callback.href);
    const reply=new URL(callback);reply.searchParams.set('state',authorization.searchParams.get('state'));
    if(checkState){const invalid=new URL(reply);invalid.searchParams.set('state','wrong-state');const response=await fetch(invalid);assert.equal(response.status,400);await response.text();}
    reply.searchParams.set(cancel?'error':'code',cancel?'access_denied':'fictional-code');
    const response=await fetch(reply);assert.equal(response.status,200);await response.text();
   },
  },
 };
}

test('Beeper OAuth requests only read access and checks the callback state and PKCE exchange',async()=>{
 const flow=oauth({checkState:true});
 assert.equal(await authorizeBeeper(flow.options),'fictional-token');
 assert.deepEqual(flow.requests.map(r=>r.path),['/oauth/register','/oauth/token']);
});

test('write access is rejected and the newly issued credential is revoked before retrying',async()=>{
 const flow=oauth({scope:'read\twrite\n'});
 await assert.rejects(authorizeBeeper(flow.options),error=>{
  assert.equal(error.code,'BEEPER_WRITE_ACCESS');assert.match(error.message,/turn OFF "Allow sensitive actions"/i);
  assert.match(error.message,/has been revoked/);assert.ok(!error.message.includes('fictional-token'));return true;
 });
 assert.deepEqual(flow.requests.map(r=>r.path),['/oauth/register','/oauth/token','/oauth/revoke']);
});

test('failed revocation gives the exact Beeper setting for manually removing the rejected connection',async()=>{
 const flow=oauth({scope:'read write',revokeFails:true});
 await assert.rejects(authorizeBeeper(flow.options),error=>{
  assert.equal(error.code,'BEEPER_WRITE_ACCESS');assert.match(error.message,/Approved connections before retrying/);
  assert.ok(!error.message.includes('has been revoked'));return true;
 });
});

test('setup can recover from write access through a fresh read-only authorization without restarting',async()=>{
 const rejected=oauth({scope:'read write'}),accepted=oauth(),flows=[rejected,accepted],logs=[];let prompts=0;
 const token=await authorizeBeeperWithRetry(async prompt=>{
  prompts++;assert.match(prompt,/Allow sensitive actions/);
  assert.equal(rejected.requests.at(-1).path,'/oauth/revoke');return ' yes ';
 },{authorize:()=>authorizeBeeper(flows.shift().options),log:message=>logs.push(message)});
 assert.equal(token,'fictional-token');assert.equal(prompts,1);assert.equal(logs.length,1);
 assert.deepEqual(accepted.requests.map(r=>r.path),['/oauth/register','/oauth/token']);
});

test('declining the retry stops before pairing and unrelated failures do not trigger a retry',async()=>{
 const denied=Object.assign(Error('Read-only access required'),{code:'BEEPER_WRITE_ACCESS'});
 await assert.rejects(authorizeBeeperWithRetry(async()=> 'no',{authorize:async()=>{throw denied;},log:()=>{}}),/cancelled before pairing/);
 const offline=Error('Beeper offline');
 await assert.rejects(authorizeBeeperWithRetry(()=>assert.fail('Must not retry'),{authorize:async()=>{throw offline;}}),error=>error===offline);
});

test('cancelled Beeper authorization never exchanges or revokes a token',async()=>{
 const flow=oauth({cancel:true});
 await assert.rejects(authorizeBeeper(flow.options),/authorization was cancelled/);
 assert.deepEqual(flow.requests.map(r=>r.path),['/oauth/register']);
});

test('revocation accepts an empty successful response while normal JSON requests remain strict',async t=>{
 const fetch=t.mock.method(globalThis,'fetch',async()=>new Response(null,{status:200}));
 assert.equal(await requestJson('http://127.0.0.1:23373/oauth/revoke',{method:'POST',form:{token:'fictional-token'},allowEmpty:true}),null);
 assert.equal(fetch.mock.calls[0].arguments[1].redirect,'error');
 await assert.rejects(requestJson('http://127.0.0.1:23373/v1/chats'),/unreadable response/);
});
