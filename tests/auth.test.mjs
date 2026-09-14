import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {generateKeyPair,SignJWT,exportJWK} from 'jose';
const temp=mkdtempSync(join(tmpdir(),'xin-auth-test-'));
process.env.XIN_DATA_DIR=temp;process.env.XIN_ALLOWED_EMAIL='owner@example.com';
const db=await import('../lib/db.mjs');
const conn=await import('../lib/connectors.mjs');
const auth=await import('../lib/auth.mjs');
const route=await import('../app/api/[...path]/route.js');
const pair=await generateKeyPair('RS256');
const client={web:{client_id:'fixture.apps.googleusercontent.com',client_secret:'fixture-secret',redirect_uris:[auth.CALLBACK]}};
const origin=auth.APP_ORIGIN;
const digest=s=>createHash('sha256').update(s).digest('hex');
function req(path,{method='GET',token='',body={},originHeader=origin}={}){return new Request(origin+'/api/'+path,{method,headers:{host:'127.0.0.1:3210',...(method==='POST'?{origin:originHeader,'X-Xin-Request':'1','Content-Type':'application/json'}:{}),...(token?{cookie:auth.SESSION_COOKIE+'='+token}:{})},...(method==='POST'?{body:JSON.stringify(body)}:{})});}
async function signed(nonce,overrides={},key=pair.privateKey){return new SignJWT({iss:'https://accounts.google.com',aud:client.web.client_id,sub:'google-owner-1',email:'owner@example.com',email_verified:true,name:'Alex',nonce,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,...overrides}).setProtectedHeader({alg:'RS256'}).sign(key);}
const grant='openid email profile https://www.googleapis.com/auth/gmail.readonly';
async function newFlow(){const f=(await auth.beginGoogle()),u=new URL(f.url);return {url:u,state:u.searchParams.get('state'),nonce:u.searchParams.get('nonce'),browser:f.cookie.split(';')[0].split('=')[1]};}
async function complete(flow,{scope=grant,claims={},profileEmail="owner@example.com",profileError=null,tokenError=null,refreshToken="fixture-refresh-token"}={}){
 const old=global.fetch;let sent;
 global.fetch=async(url,options)=>{if(String(url).includes('/token')){sent=options.body;if(tokenError)return Response.json({error:tokenError,error_description:'private provider detail'},{status:400});return Response.json({id_token:await signed(flow.nonce,claims),access_token:'fixture-access-token',refresh_token:refreshToken,expires_in:3600,scope});}if(profileError)return Response.json({error:{message:'private provider detail',details:[{'@type':'type.googleapis.com/google.rpc.ErrorInfo',reason:profileError}]}},{status:403});return Response.json({emailAddress:profileEmail});};
 try{const result=await auth.finishGoogle('fixture-code',flow.state,flow.browser,pair.publicKey);return {...result,sent};}finally{global.fetch=old;}
}
let session;
test('all private reads and writes reject anonymous callers; setup is same-origin and one-time',async()=>{
 for(const p of ['state','sources','sources/manual:private','export','events/private','jobs/private','update-draft','contacts','contacts/private','contacts/status','contacts/merge-preview'])assert.equal((await route.GET(req(p))).status,401,p);
 for(const p of ['items','settings','jobs','jobs/cancel','proposals/dismiss','connections','sync','import','auth/logout','contacts','contacts/affiliation','contacts/import','contacts/backfill','contacts/interaction','contacts/interaction-review','contacts/coverage','contacts/link','contacts/draft','contacts/merge','contacts/undo-merge','contacts/separate'])assert.equal((await route.POST(req(p,{method:'POST'}))).status,401,p);
 assert.deepEqual(await (await route.GET(req('auth/status'))).json(),{configured:false,user:null});
 assert.equal((await route.POST(req('auth/setup',{method:'POST',originHeader:'https://untrusted.example',body:client}))).status,403);
 assert.equal((await route.POST(req('auth/setup',{method:'POST',body:{installed:client.web}}))).status,400);
 assert.equal((await route.POST(req('auth/setup',{method:'POST',body:client}))).status,200);
 assert.equal((await route.POST(req('auth/setup',{method:'POST',body:client}))).status,409);
});
test('Google login fails closed when no workspace owner is configured',async()=>{
 const original=process.env.XIN_ALLOWED_EMAIL;delete process.env.XIN_ALLOWED_EMAIL;
 try{assert.equal(auth.allowedEmail(),'');await assert.rejects(async ()=>(await auth.beginGoogle()),/Set XIN_ALLOWED_EMAIL/);}finally{process.env.XIN_ALLOWED_EMAIL=original;}
});
test('OAuth requests combine identity and Gmail with PKCE, nonce, and an HttpOnly browser binding',async()=>{
 const response=await route.POST(req('auth/google/start',{method:'POST'}));const u=new URL((await response.json()).url);
 assert.equal(u.searchParams.get('scope'),grant);assert.equal(u.searchParams.get('redirect_uri'),auth.CALLBACK);
 assert.equal(u.searchParams.get('code_challenge_method'),'S256');assert.ok(u.searchParams.get('nonce'));assert.ok(u.searchParams.get('state'));
 assert.match(response.headers.get('set-cookie'),/HttpOnly; SameSite=Lax; Max-Age=600/);
 assert.equal(u.searchParams.get('access_type'),'offline');assert.equal(u.searchParams.get('login_hint'),'owner@example.com');
});
test('JWT verification rejects wrong signature, issuer, audience, nonce, unverified email, and wrong owner',async()=>{
 const nonce='expected';const badKey=await generateKeyPair('RS256');
 await assert.rejects(()=>auth.verifyGoogleIdentity('not.a.valid-token',client.web.client_id,nonce,pair.publicKey));
 for(const claims of [{iss:'https://evil.example'},{aud:'other.apps.googleusercontent.com'},{nonce:'different'},{email_verified:false},{email:'someone@example.com'},{exp:1},{azp:'other-client'}])await assert.rejects(async()=>auth.verifyGoogleIdentity(await signed(nonce,claims),client.web.client_id,nonce,pair.publicKey));
 await assert.rejects(async()=>auth.verifyGoogleIdentity(await signed(nonce,{},badKey.privateKey),client.web.client_id,nonce,pair.publicKey));
 assert.equal((await auth.verifyGoogleIdentity(await signed(nonce),client.web.client_id,nonce,pair.publicKey)).sub,'google-owner-1');
});
test('wrong browser and expired state cannot exchange tokens; callbacks are single-use',async()=>{
 const flow=(await newFlow());await assert.rejects(()=>auth.finishGoogle('code',flow.state,'other-browser',pair.publicKey),/another browser/);
 const expired=(await newFlow());(await auth.authDb.prepare('UPDATE oauth_attempts SET expires_at=0 WHERE state_hash=?').run(digest(expired.state)));
 await assert.rejects(()=>auth.finishGoogle('code',expired.state,expired.browser,pair.publicKey),/expired/);
 const result=await complete(flow,{scope:'openid email profile'});assert.equal(result.gmail,false);assert.ok((await auth.sessionFor(result.token)));(await auth.endSession(result.token));
 await assert.rejects(()=>auth.finishGoogle('code',flow.state,flow.browser,pair.publicKey),/expired/);
});
test('successful Google identity establishes a session and Gmail access together; secrets stay server-side',async()=>{
 const flow=(await newFlow());const result=await complete(flow);session=result.token;
 assert.equal(result.gmail,true);assert.equal((await conn.connectionState()).gmail.configured,true);
 assert.equal(result.sent.get('redirect_uri'),auth.CALLBACK);
 assert.equal(createHash('sha256').update(result.sent.get('code_verifier')).digest('base64url'),flow.url.searchParams.get('code_challenge'));
 assert.equal((await auth.sessionFor(session)).email,'owner@example.com');
 const stored=(await auth.authDb.prepare('SELECT token_hash FROM sessions').all());assert.ok(stored.every(r=>r.token_hash!==session));
 const r=await route.GET(req('state',{token:session}));assert.equal(r.status,200);assert.equal((await r.json()).user.email,'owner@example.com');
 const exported=await (await route.GET(req('export',{token:session}))).text();for(const secret of [session,'fixture-access-token','fixture-refresh-token','fixture-secret','oauth_attempts','sessions'])assert.ok(!exported.includes(secret));
 assert.ok(!readFileSync(join(temp,'connections.secret.json'),'utf8').includes('id_token'));
 const other=await signed('nonce',{sub:'google-owner-2'});await assert.rejects(()=>auth.verifyGoogleIdentity(other,client.web.client_id,'nonce',pair.publicKey),/does not own/);
});
test('authenticated writes still reject cross-origin calls and logout revokes access',async()=>{
 assert.equal((await route.POST(req('settings',{method:'POST',token:session,originHeader:'https://evil.example'}))).status,403);
 const r=await route.POST(req('auth/logout',{method:'POST',token:session}));assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/Max-Age=0/);
 assert.equal((await auth.sessionFor(session)),null);assert.equal((await route.GET(req('export',{token:session}))).status,401);
});
test('the callback route verifies Google keys, creates the cookie, redirects, and retires the browser flow',async()=>{
 const f=(await newFlow()),old=global.fetch;const publicJwk=await exportJWK(pair.publicKey);
 global.fetch=async url=>{
  if(String(url).includes('/certs'))return Response.json({keys:[{...publicJwk,alg:'RS256',use:'sig'}]});
  if(String(url).includes('/token'))return Response.json({id_token:await signed(f.nonce),access_token:'fixture-access-token',refresh_token:'fixture-refresh-token',scope:grant,expires_in:3600});
  return Response.json({emailAddress:'owner@example.com'});
 };
 // Keep the callback from spawning a real provider worker in this isolated fixture.
 (await db.run('INSERT INTO sync_runs(id,provider,started_at,state,pid,updated_at) VALUES(?,?,?,?,?,?)','busy-fixture','gmail',new Date().toISOString(),'running',process.pid,new Date().toISOString()));
 try{
  const request=new Request(auth.CALLBACK+'?code=fixture&state='+f.state,{headers:{host:'127.0.0.1:3210',cookie:auth.FLOW_COOKIE+'='+f.browser}});
  const r=await route.GET(request);assert.equal(r.status,303);assert.equal(r.headers.get('location'),origin+'/?gmail=connected&import=manual');
  const cookies=r.headers.getSetCookie();assert.equal(cookies.length,2);assert.match(cookies[0],/xin_session=.*HttpOnly; SameSite=Lax; Max-Age=43200/);assert.match(cookies[1],/xin_google_flow=;.*Max-Age=0/);
  const token=cookies[0].split(';')[0].split('=')[1];assert.ok((await auth.sessionFor(token)));(await auth.endSession(token));
 }finally{global.fetch=old;(await db.run('DELETE FROM sync_runs WHERE id=?','busy-fixture'));}
});
test('disabled Gmail API preserves verified sign-in and the grant for a later retry',async()=>{
 const result=await complete((await newFlow()),{profileError:'SERVICE_DISABLED'});
 assert.equal(result.gmail,false);assert.equal(result.gmailIssue,'gmail_api_disabled');assert.ok((await auth.sessionFor(result.token)));
 assert.equal((await conn.connectionState()).gmail.configured,true);assert.equal((await conn.connectionState()).gmail.issue.code,'gmail_api_disabled');
 assert.equal(conn.secrets().gmail_tokens.refresh_token,'fixture-refresh-token');
 const warning=(await auth.authDb.prepare("SELECT * FROM auth_events WHERE stage='gmail' AND outcome='warning' ORDER BY id DESC LIMIT 1").get());
 assert.equal(warning.provider_reason,'SERVICE_DISABLED');assert.equal(warning.http_status,403);
 const events=JSON.stringify((await auth.authDb.prepare('SELECT * FROM auth_events').all()));
 for(const secret of ['fixture-access-token','fixture-refresh-token','fixture-secret',result.token,'private provider detail'])assert.ok(!events.includes(secret));
 (await auth.endSession(result.token));
 const recovered=await complete((await newFlow()));assert.equal(recovered.gmail,true);assert.equal((await conn.connectionState()).gmail.issue,null);(await auth.endSession(recovered.token));
});
test('Gmail account mismatches cannot overwrite credentials or create a session',async()=>{
 const before=conn.secrets(),sessions=(await auth.authDb.prepare('SELECT COUNT(*) AS n FROM sessions').get()).n;
 await assert.rejects(async ()=>complete((await newFlow()),{profileEmail:'other@example.com'}),e=>e.authCode==='account');
 assert.deepEqual(conn.secrets(),before);assert.equal((await auth.authDb.prepare('SELECT COUNT(*) AS n FROM sessions').get()).n,sessions);
});
test('missing background Gmail permission still permits verified sign-in',async()=>{
 const before=conn.secrets();const without={...before};delete without.gmail_tokens;conn.saveSecrets(without);
 try{const result=await complete((await newFlow()),{refreshToken:null});assert.equal(result.gmailIssue,'gmail_refresh');assert.ok((await auth.sessionFor(result.token)));assert.equal((await conn.connectionState()).gmail.configured,false);(await auth.endSession(result.token));}finally{conn.saveSecrets(before);}
});
test('rejected OAuth clients produce actionable diagnostics without creating a session',async()=>{
 const sessions=(await auth.authDb.prepare('SELECT COUNT(*) AS n FROM sessions').get()).n;
 await assert.rejects(async ()=>complete((await newFlow()),{tokenError:'invalid_client'}),e=>e.authCode==='client');
 const event=(await auth.authDb.prepare('SELECT * FROM auth_events ORDER BY id DESC LIMIT 1').get());
 assert.equal(event.stage,'token_exchange');assert.equal(event.code,'client');assert.equal(event.provider_reason,'invalid_client');
 assert.equal((await auth.authDb.prepare('SELECT COUNT(*) AS n FROM sessions').get()).n,sessions);
});
test('callback sends verified users into Focus with the Gmail warning and no import',async()=>{
 const f=(await newFlow()),old=global.fetch,runCount=(await db.one('SELECT COUNT(*) AS n FROM sync_runs')).n;
 global.fetch=async url=>String(url).includes('/token')?Response.json({id_token:await signed(f.nonce),access_token:'fixture-access-token',refresh_token:'fixture-refresh-token',scope:grant,expires_in:3600}):Response.json({error:{errors:[{reason:'accessNotConfigured'}]}},{status:403});
 try{
  const r=await route.GET(new Request(auth.CALLBACK+'?code=fixture&state='+f.state,{headers:{host:'127.0.0.1:3210',cookie:auth.FLOW_COOKIE+'='+f.browser}}));
  assert.equal(r.headers.get('location'),origin+'/?gmail=gmail_api_disabled&import=manual');
  const token=r.headers.getSetCookie()[0].split(';')[0].split('=')[1];assert.ok((await auth.sessionFor(token)));(await auth.endSession(token));
  assert.equal((await db.one('SELECT COUNT(*) AS n FROM sync_runs')).n,runCount);
 }finally{global.fetch=old;conn.clearGmailIssue();}
});
test('expired sessions and forged cookies cannot access existing data',async()=>{
 const result=await complete((await newFlow()));(await auth.authDb.prepare('UPDATE sessions SET expires_at=0').run());
 assert.equal((await auth.sessionFor(result.token)),null);assert.equal((await auth.sessionFor('A'.repeat(43))),null);
 const callback=await route.GET(req('auth/google/callback?code=forged&state=forged'));assert.equal(callback.status,303);assert.match(callback.headers.get('location'),/login\?error=flow$/);
});
test.after(async ()=>{(await auth.authDb.close());(await db.db.close());rmSync(temp,{recursive:true,force:true});});
