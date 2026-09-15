import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
process.env.XIN_SECRET_STORAGE='postgres';process.env.XIN_SECRETS_KEY=randomBytes(32).toString('base64url');
const store=await import('../lib/secret-store.mjs');
const settings=await import('../lib/review-settings.mjs');
const {one,exportData,upsertSource}=await import('../lib/db.mjs');
const {createJob}=await import('../lib/agent.mjs');
const {runCloudAgent}=await import('../lib/cloud-agent.mjs');
const jwt=(extra={})=>'fixture.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600,email:'fixture@example.com','https://api.openai.com/auth':{chatgpt_account_id:'fictional-account',chatgpt_plan_type:'pro'},...extra})).toString('base64url')+'.signature';
const tokens=(extra={})=>({access_token:jwt(extra),refresh_token:'fictional-refresh-secret'});
const json=(data,status=200)=>Response.json(data,{status});
const sse=output=>new Response('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output,usage:{input_tokens:10,output_tokens:20}}})+'\n\n');
async function seedConnection(){await store.saveSecrets({review_provider:{active:'gateway',model:'gpt-6-astra',connection:{id:'connection-one',accessToken:jwt(),refreshToken:'fictional-refresh-secret',accountId:'fictional-account',expiresAt:Date.now()+3600000}}});}
test('fresh device login survives pending polls, exchanges credentials, and returns only display fields',async t=>{
 await store.saveSecrets({fireflies_key:'fictional-other-secret'});let stage=0;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  assert.equal(options.redirect,'error');
  if(url.endsWith('/usercode'))return json({user_code:'ABCD-EFGH',device_auth_id:'private-device-id',interval:'3'});
  if(url.endsWith('/deviceauth/token'))return stage++===0?json({},403):json({authorization_code:'private-code',code_verifier:'private-verifier'});
  assert.equal(new URLSearchParams(options.body).get('grant_type'),'authorization_code');return json(tokens());
 });
 const login=await settings.startChatGPTLogin();assert.equal(login.login.userCode,'ABCD-EFGH');assert.ok(!JSON.stringify(login).includes('private-device-id'));
 await assert.rejects(settings.startChatGPTLogin,/just started/);
 assert.ok((await settings.pollChatGPTLogin(login.login.id)).login);
 await store.updateSecrets(s=>{s.review_provider.login.nextPollAt=0;});
 const connected=await settings.pollChatGPTLogin(login.login.id);assert.equal(connected.login,null);assert.equal(connected.chatgpt.connected,true);assert.equal(connected.chatgpt.email,'fixture@example.com');assert.equal(connected.provider,'gateway');
 assert.ok(!JSON.stringify(connected).includes('fictional-refresh-secret'));assert.equal((await store.secrets()).fireflies_key,'fictional-other-secret');
 assert.ok(!JSON.stringify((await one('SELECT payload FROM focus_auth.provider_secrets')).payload).includes('fictional-refresh-secret'));assert.ok(!JSON.stringify(await exportData()).includes('fictional-refresh-secret'));
 await assert.rejects(settings.saveReviewProvider({provider:'chatgpt',model:'gpt-6-astra'}),/successfully test/);
});
test('concurrent refreshes rotate a token once and preserve unrelated credentials',async t=>{
 await seedConnection();await store.updateSecrets(s=>{s.review_provider.connection.expiresAt=0;s.granola_key='other-fixture';});let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;await new Promise(r=>setTimeout(r,20));return json({...tokens(),refresh_token:'rotated-fixture'});});
 const results=await Promise.all([settings.codexSession(),settings.codexSession(),store.updateSecrets(s=>{s.fireflies_key='another-fixture';})]);
 assert.equal(calls,1);assert.equal(results[0].accessToken,results[1].accessToken);const saved=await store.secrets();assert.equal(saved.review_provider.connection.refreshToken,'rotated-fixture');assert.equal(saved.granola_key,'other-fixture');assert.equal(saved.fireflies_key,'another-fixture');
});
test('quota errors preserve the connection; revoked refresh credentials require sign-in',async t=>{
 await seedConnection();await store.updateSecrets(s=>{s.review_provider.connection.expiresAt=0;});let status=429;
 t.mock.method(globalThis,'fetch',async()=>json({error:'private-provider-detail'},status));
 await assert.rejects(settings.codexSession(),error=>error.reason==='rate_limited');assert.equal((await settings.reviewSettings()).chatgpt.needsLogin,false);
 status=400;await assert.rejects(settings.codexSession(),error=>error.reason==='authentication');assert.equal((await settings.reviewSettings()).chatgpt.needsLogin,true);
});
test('tested subscription is selected for a complete tool-based, citation-verified cloud review',async t=>{
 await seedConnection();let step=0;
 const quote='The fictional proposal needs a review.';
 const answer={brief:'Review complete.',findings:[{text:'A next step.',citations:[{source_id:'manual:subscription-fixture',source_version_id:'',quote}]}],proposals:[],drafts:[],questions:[],coverage_note:'One fictional source.'};
 const requests=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  assert.equal(url,'https://chatgpt.com/backend-api/codex/responses');const body=JSON.parse(options.body);requests.push(body);
  if(step++===1)return sse([{type:'function_call',call_id:'read-fixture',name:'read_source',arguments:JSON.stringify({id:'manual:subscription-fixture'})}]);
  return sse([{type:'message',content:[{type:'output_text',text:step===1?'OK':JSON.stringify(answer)}]}]);
 });
 const tested=await settings.testChatGPTConnection('gpt-6-astra');assert.equal(tested.test.ok,true,tested.test.message);
 await assert.rejects(settings.saveReviewProvider({provider:'chatgpt',model:'different-model'}),/test/);
 assert.equal((await settings.saveReviewProvider({provider:'chatgpt',model:'gpt-6-astra'})).provider,'chatgpt');
 await upsertSource({provider:'manual',external_id:'subscription-fixture',title:'Fictional source',body:quote});
 const id=await createJob('Review the fictional proposal.');await runCloudAgent(id);
 const job=await one('SELECT * FROM jobs WHERE id=?',id);assert.equal(job.status,'complete',job.error);assert.equal(JSON.parse(job.usage_json).totalTokens,60);assert.ok(JSON.parse(job.result_json).findings[0].citations[0].source_version_id);
 assert.ok(requests[2].input.some(item=>item.type==='function_call_output'));
 const disconnected=await settings.disconnectChatGPT();assert.equal(disconnected.provider,'chatgpt');assert.equal(disconnected.chatgpt.connected,false);assert.equal(disconnected.test,null);
 await assert.rejects(settings.codexSession(),error=>error.reason==='not_connected');
 await settings.saveReviewProvider({provider:'gateway',model:'gpt-6-astra'});assert.equal(typeof await settings.selectedReviewModel(),'string');
});
test('expired or cancelled login cannot overwrite a connection',async()=>{
 await seedConnection();await store.updateSecrets(s=>{s.review_provider.login={id:'expired',expiresAt:0};});
 await assert.rejects(settings.pollChatGPTLogin('expired'),error=>error.reason==='login_expired');
 await settings.cancelChatGPTLogin('expired');assert.equal((await settings.reviewSettings()).login,null);assert.equal((await settings.reviewSettings()).chatgpt.connected,true);
});
