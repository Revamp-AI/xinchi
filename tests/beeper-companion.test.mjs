import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {authorizeBeeper,authorizeBeeperWithRetry,requestJson,selectChats,chooseChats} from '../public/beeper-companion.mjs';

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
