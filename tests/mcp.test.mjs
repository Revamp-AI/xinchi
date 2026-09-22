import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
const temp=mkdtempSync(join(tmpdir(),'focus-mcp-'));
process.env.XIN_DATA_DIR=temp;process.env.XIN_ALLOWED_EMAIL='owner@example.com';process.env.XIN_AGENT_MODE='cloud';
const db=await import('../lib/db.mjs');
const auth=await import('../lib/auth.mjs');
const oauth=await import('../lib/mcp-auth.mjs');
const {handleMcpRequest}=await import('../lib/mcp-server.mjs');
const {mcpTools,executeMcpTool}=await import('../lib/mcp-tools.mjs');
const route=await import('../app/api/mcp/[action]/route.js');
const owner={sub:'mcp-fixture-owner',email:'owner@example.com',name:'Alex'};
await auth.authDb.prepare('INSERT INTO owner VALUES(1,?,?,?)').run(owner.sub,owner.email,owner.name);
const browserToken=oauth.randomToken();
await auth.authDb.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(oauth.tokenHash(browserToken),owner.sub,Date.now(),Date.now()+3600000);
const verifier=randomBytes(48).toString('base64url');
const challenge=createHash('sha256').update(verifier).digest('base64url');
const req=(path,body,headers={})=>new Request(auth.APP_ORIGIN+path,{method:body===undefined?'GET':'POST',headers:{host:'127.0.0.1:3210',...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
const browserHeaders={origin:auth.APP_ORIGIN,'X-Xin-Request':'1',cookie:auth.SESSION_COOKIE+'='+browserToken};
async function authorization(scope='focus:read focus:write'){
 const client=await oauth.registerMcpClient({client_name:'Fictional Codex',redirect_uris:['http://127.0.0.1/callback'],token_endpoint_auth_method:'none'});
 const request={client_id:client.client_id,redirect_uri:'http://127.0.0.1:54321/callback',response_type:'code',state:'fictional-csrf-state',resource:oauth.MCP_URL,code_challenge:challenge,code_challenge_method:'S256',scope};
 const redirect=new URL((await oauth.authorizeMcp(request,owner)).redirect);
 const tokenArgs={grant_type:'authorization_code',client_id:client.client_id,redirect_uri:request.redirect_uri,resource:oauth.MCP_URL,code:redirect.searchParams.get('code'),code_verifier:verifier};
 return{client,request,redirect,tokenArgs};
}
async function grant(scope){const flow=await authorization(scope);const tokens=await oauth.exchangeMcpToken(flow.tokenArgs);const access=await oauth.requireMcpAccess(req('/mcp',undefined,{Authorization:'Bearer '+tokens.access_token}));return{...flow,tokens,access};}
const key=()=>randomUUID();

test('OAuth uses PKCE, issuer-bound redirects, exact paths and variable loopback ports',async()=>{
 const f=await authorization();assert.equal(f.redirect.searchParams.get('iss'),auth.APP_ORIGIN);assert.equal(f.redirect.searchParams.get('state'),f.request.state);
 assert.equal(oauth.redirectMatches(['http://127.0.0.1/callback'],'http://127.0.0.1:56789/callback'),true);
 assert.equal(oauth.redirectMatches(['http://127.0.0.1/callback'],'http://127.0.0.1:56789/other'),false);
 assert.equal(oauth.redirectMatches(['https://client.example/callback'],'https://client.example:444/callback'),false);
 await assert.rejects(oauth.validateAuthorization({...f.request,redirect_uri:'https://attacker.example/callback'}),/Redirect/);
 await assert.rejects(oauth.validateAuthorization({...f.request,resource:'https://other.example/mcp'}),/resource/);
 await assert.rejects(oauth.validateAuthorization({...f.request,code_challenge_method:'plain'}),/PKCE/);
 await assert.rejects(oauth.exchangeMcpToken({...f.tokenArgs,code_verifier:'z'.repeat(64)}),/verifier/);
 const tokens=await oauth.exchangeMcpToken(f.tokenArgs);assert.equal(tokens.token_type,'Bearer');
 await assert.rejects(oauth.exchangeMcpToken(f.tokenArgs),/invalid/);
 const stored=JSON.stringify(await db.all('SELECT * FROM focus_auth.mcp_tokens'));
 assert.ok(!stored.includes(tokens.access_token));assert.ok(!stored.includes(tokens.refresh_token));
 await assert.rejects(oauth.authorizeMcp(f.request,{...owner,email:'other@example.com'}),/Sign in/);
 await assert.rejects(oauth.registerMcpClient({redirect_uris:['http://untrusted.example/callback']}),/HTTPS/);
});
test('OAuth cancellation, scope checks, expiry and refresh reuse fail closed',async()=>{
 const f=await grant('focus:read');
 const denied=new URL((await oauth.authorizeMcp(f.request,owner,false)).redirect);assert.equal(denied.searchParams.get('error'),'access_denied');assert.equal(denied.searchParams.has('code'),false);
 await assert.rejects(oauth.validateAuthorization({...f.request,scope:'focus:admin'}),{oauthCode:'invalid_scope'});
 const refreshed=await oauth.exchangeMcpToken({grant_type:'refresh_token',client_id:f.client.client_id,resource:oauth.MCP_URL,refresh_token:f.tokens.refresh_token});
 assert.equal(refreshed.scope,'focus:read');
 await assert.rejects(oauth.exchangeMcpToken({grant_type:'refresh_token',client_id:f.client.client_id,resource:oauth.MCP_URL,refresh_token:f.tokens.refresh_token}),/already used/);
 await assert.rejects(oauth.requireMcpAccess(req('/mcp',undefined,{Authorization:'Bearer '+refreshed.access_token})),/revoked/);
 const exp=await grant();await db.run("UPDATE focus_auth.mcp_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=?",oauth.tokenHash(exp.tokens.access_token));
 await assert.rejects(oauth.requireMcpAccess(req('/mcp',undefined,{Authorization:'Bearer '+exp.tokens.access_token})),/expired/);
});
test('MCP requires its own bearer token, rejects browser origins, and advertises OAuth discovery',async()=>{
 const noAuth=await handleMcpRequest(req('/mcp'));assert.equal(noAuth.status,401);assert.match(noAuth.headers.get('www-authenticate'),/oauth-protected-resource\/mcp/);
 assert.equal((await handleMcpRequest(req('/mcp',undefined,browserHeaders))).status,401);
 const f=await grant();const headers={Authorization:'Bearer '+f.tokens.access_token};
 assert.equal((await handleMcpRequest(req('/mcp',undefined,{...headers,origin:'https://attacker.example'}))).status,403);
 assert.equal((await handleMcpRequest(req('/mcp',undefined,headers))).status,405);
 const readonly=await grant('focus:read');
 const denied=await handleMcpRequest(req('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'focus_set_weekly_focus',arguments:{idempotency_key:key(),focus:'No',available_hours:1}}},{Authorization:'Bearer '+readonly.tokens.access_token}));
 assert.equal(denied.status,403);assert.match(denied.headers.get('www-authenticate'),/insufficient_scope/);
});
test('access management requires owner session and same-origin CSRF protection',async()=>{
 const f=await grant();
 assert.equal((await route.GET(req('/api/mcp/access'))).status,401);
 assert.equal((await route.POST(req('/api/mcp/disconnect',{id:f.access.id},{...browserHeaders,origin:'https://attacker.example'}))).status,403);
 assert.equal((await route.POST(req('/api/mcp/disconnect',{id:f.access.id},browserHeaders))).status,200);
 await assert.rejects(oauth.requireMcpAccess(req('/mcp',undefined,{Authorization:'Bearer '+f.tokens.access_token})),/revoked/);
 const settings=await (await route.GET(req('/api/mcp/access',undefined,browserHeaders))).json();assert.ok(settings.grants.some(g=>g.id===f.access.id&&g.revoked_at));
 assert.ok(!JSON.stringify(settings).includes(f.tokens.access_token));
 const exported=JSON.stringify(await db.exportData());assert.ok(!exported.includes(f.tokens.access_token));assert.ok(!exported.includes(f.client.client_id));
});

for(const mode of ['legacy','auto'])test('official MCP client negotiates '+mode+' and can read, create, update, and discover resources',async()=>{
 const f=await grant();
 const client=new Client({name:'Focus test client',version:'1'},{versionNegotiation:{mode}});
 const transport=new StreamableHTTPClientTransport(new URL(oauth.MCP_URL),{requestInit:{headers:{Authorization:'Bearer '+f.tokens.access_token}},fetch:(url,init)=>handleMcpRequest(new Request(url,init))});
 await client.connect(transport);
 try{
  const catalog=await client.listTools();assert.equal(catalog.tools.length,mcpTools.length);assert.equal(catalog.tools.find(t=>t.name==='focus_get_workspace').annotations.readOnlyHint,true);assert.equal(catalog.tools.find(t=>t.name==='focus_save_commitment').annotations.readOnlyHint,false);
  assert.ok((await client.listResources()).resources.some(r=>r.uri==='focus://guide'));
  assert.ok((await client.readResource({uri:'focus://guide'})).contents[0].text.includes('idempotency_key'));
  assert.equal((await client.listPrompts()).prompts[0].name,'review_workspace');
  const initial=await client.callTool({name:'focus_get_workspace',arguments:{}});assert.ok(initial.structuredContent.data.coverage);
  const args={idempotency_key:key(),commitment:{title:'Fictional '+mode+' commitment',owner:'Alex'}};
  const created=(await client.callTool({name:'focus_save_commitment',arguments:args})).structuredContent.data;
  assert.ok(created.id);assert.equal(created.status,'candidate');
  const retry=(await client.callTool({name:'focus_save_commitment',arguments:args})).structuredContent.data;assert.equal(retry.id,created.id);
  const changed=(await client.callTool({name:'focus_save_commitment',arguments:{idempotency_key:key(),commitment:{id:created.id,version:created.version,title:created.title+' revised'}}})).structuredContent.data;assert.equal(changed.version,2);
  const stale=await client.callTool({name:'focus_save_commitment',arguments:{idempotency_key:key(),commitment:{id:created.id,version:1,title:'Stale'}}});assert.equal(stale.isError,true);
 }finally{await client.close();}
});
test('actions are atomic, retry-safe and audited without raw arguments',async()=>{
 const f=await grant();const args={idempotency_key:key(),contact:{name:'Taylor Fixture',email:'taylor@example.com',tracked:true}};
 const results=await Promise.all([executeMcpTool('focus_save_contact',args,f.access),executeMcpTool('focus_save_contact',args,f.access)]);assert.equal(results[0].id,results[1].id);
 assert.equal((await db.one("SELECT count(*) AS n FROM contacts WHERE email='taylor@example.com'")).n,1);
 await assert.rejects(executeMcpTool('focus_save_contact',{...args,contact:{name:'Changed intent'}},f.access),/different arguments/);
 const c=results[0];await executeMcpTool('focus_save_contact',{idempotency_key:key(),contact:{id:c.id,version:c.version,paused:true}},f.access);
 const read=await executeMcpTool('focus_read_contact',{id:c.id},f.access);assert.equal(read.paused,true);
 const audit=await db.all('SELECT * FROM focus_auth.mcp_operations WHERE grant_id=?',f.access.id);assert.equal(audit.length,2);assert.ok(audit.every(a=>a.args_hash&&!('arguments' in a)));
 await assert.rejects(executeMcpTool('focus_save_commitment',{idempotency_key:key(),commitment:{title:'Invalid active outcome',status:'now'}},f.access),/Accepting needs/);
 assert.equal((await db.one("SELECT count(*) AS n FROM items WHERE title='Invalid active outcome'")).n,0);
});
test('Codex can submit citation-backed reviews and accept or dismiss proposals',async()=>{
 const f=await grant();const source=await db.upsertSource({provider:'manual',external_id:'mcp-evidence',title:'Fictional workshop',body:'Alex will review the Orchard migration checklist on Friday.',coverage:'document'});
 const review={brief:'The checklist needs review.',findings:[],questions:[],coverage_note:'Fictional evidence.',proposals:[{title:'Review the Orchard checklist',kind:'action',rationale:'Alex agreed to review it.',done_when:'The checklist is reviewed.',next_action:'Read the checklist.',existing_item_id:'',uncertainty:'Confirm whether it is still open.',confidence:'high',citations:[{source_id:source.id,quote:'Alex will review the Orchard migration checklist on Friday.'}]}]};
 const saved=await executeMcpTool('focus_submit_review',{idempotency_key:key(),prompt:'Review fictional context.',review},f.access);
 const proposal=await db.one('SELECT * FROM proposals WHERE job_id=?',saved.id);assert.equal(proposal.status,'pending');
 const accepted=await executeMcpTool('focus_accept_proposal',{idempotency_key:key(),id:proposal.id,changes:{}},f.access);assert.equal(accepted.status,'candidate');assert.ok(accepted.source_version_id);
 const bad=structuredClone(review);bad.proposals[0].citations[0].quote='This statement is not in any source.';
 await assert.rejects(executeMcpTool('focus_submit_review',{idempotency_key:key(),prompt:'Reject fabricated quotes.',review:bad},f.access),/unverified/);
 assert.equal((await db.one("SELECT count(*) AS n FROM jobs WHERE prompt='Reject fabricated quotes.'")).n,0);
});
test('manual imports and cloud reviews queue quickly and dispatch after commit',async()=>{
 const f=await grant();let dispatches=0;const options={schedule(){dispatches++;}};
 const body='Fictional document: review the launch checklist.';
 const upload=await executeMcpTool('focus_start_import',{idempotency_key:key(),format:'text',title:'Fictional upload',bytes:Buffer.byteLength(body)},f.access);
 await executeMcpTool('focus_append_import_chunk',{idempotency_key:key(),id:upload.id,part:0,content:body},f.access);
 await executeMcpTool('focus_finish_import',{idempotency_key:key(),id:upload.id,parts:1},f.access,options);
 assert.equal((await db.one('SELECT state FROM sync_runs WHERE id=?',upload.id)).state,'queued');assert.equal(dispatches,1);
 const job=await executeMcpTool('focus_start_review',{idempotency_key:key(),prompt:'Review the fictional upload.'},f.access,options);assert.equal(job.status,'queued');assert.equal(dispatches,2);
 await executeMcpTool('focus_cancel_review',{idempotency_key:key(),id:job.id},f.access);
 const cancelled=await db.one('SELECT status,progress FROM jobs WHERE id=?',job.id);assert.equal(cancelled.status,'failed');assert.equal(cancelled.progress,'Cancelled');
});
test('contact and source pagination preserve access to the full history',async()=>{
 const f=await grant();
 const first=await executeMcpTool('focus_list_contacts',{query:'',limit:1},f.access);assert.equal(first.records.length,1);
 const contact=first.records[0];
 for(let i=0;i<3;i++)await executeMcpTool('focus_log_interaction',{idempotency_key:key(),contact_id:contact.id,kind:'note',direction:'mutual',occurred_at:new Date(Date.now()-(i+1)*86400000).toISOString(),body:'Fictional timeline entry '+i,meaningful:true},f.access);
 const timeline=await executeMcpTool('focus_list_interactions',{id:contact.id,limit:2},f.access);assert.equal(timeline.records.length,2);assert.equal(timeline.next_offset,2);
 const next=await executeMcpTool('focus_list_interactions',{id:contact.id,limit:2,offset:2},f.access);assert.equal(next.records.length,1);assert.equal(next.next_offset,null);
});
test.after(async()=>{await db.db.close();rmSync(temp,{recursive:true,force:true});});
test('Codex can manage priority stacks and source-backed updates with scope checks and safe retries',async()=>{
 const f=await grant();let dispatched=0;const options={schedule(){dispatched++;}};
 const args={idempotency_key:key(),priority:{title:'MCP priority fixture',stack_id:'product',owner:'Alex'}};
 const created=await executeMcpTool('focus_save_priority',args,f.access,options);
 assert.equal((await executeMcpTool('focus_save_priority',args,f.access,options)).id,created.id);
 const state=await executeMcpTool('focus_list_priorities',{},f.access);assert.ok(state.items.some(p=>p.id===created.id));
 await executeMcpTool('focus_reorder_priorities',{idempotency_key:key(),version:state.order_version,ids:['product','deal-flow','go-to-market']},f.access);
 await executeMcpTool('focus_add_priority_update',{idempotency_key:key(),id:created.id,body:'A fictional release has a new acceptance criterion.'},f.access,options);
 const detail=await executeMcpTool('focus_get_priority',{id:created.id},f.access);assert.equal(detail.updates.length,1);assert.ok(detail.updates[0].citations[0].source_version_id);assert.equal(dispatched,3);
 const readonly=await grant('focus:read');await assert.rejects(executeMcpTool('focus_save_priority',{...args,idempotency_key:key()},readonly.access),/permission/);
});
