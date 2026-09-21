import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const temp=mkdtempSync(join(tmpdir(),'xin-system-test-'));process.env.XIN_DATA_DIR=temp;
const m=await import('../lib/db.mjs');
const agent=await import('../lib/agent.mjs');
const conn=await import('../lib/connectors.mjs');
const source={provider:'manual',external_id:'meeting',title:'Release decision',body:'Alex: The release needs one more review. Morgan: Prepare the release checklist.',coverage:'transcript',occurred_at:'2026-09-12'};
const sourceId=(await m.upsertSource(source)).id;
test('repeat imports are idempotent; updates keep snapshots and search current text',async()=>{
 assert.equal((await m.upsertSource(source)).changed,false);assert.equal((await m.one('SELECT count(*) AS n FROM source_versions')).n,1);
 assert.equal((await m.searchSources('release')).total,1);
 (await m.upsertSource({...source,body:source.body+' The decision needs customer evidence.'}));
 assert.equal((await m.one('SELECT count(*) AS n FROM source_versions')).n,2);assert.equal((await m.searchSources('customer evidence')).total,1);
 await assert.doesNotReject(async ()=>(await m.searchSources('" OR * ? ()')));assert.equal((await m.one('SELECT count(*) AS n FROM sources')).n,1);
});
test('a partial metadata import cannot erase an available transcript',async()=>{(await m.upsertSource({...source,body:'',coverage:'metadata'}));assert.equal((await m.readSource(sourceId)).coverage,'transcript');assert.match((await m.readSource(sourceId)).body,/customer evidence/);});
test('the active limit makes the displacement atomic and requires its reason',async()=>{
 const input={kind:'decision',status:'now',done_when:'A one-page recommendation',next_action:'List missing facts',checkpoint:'2026-09-21',owner:'Alex',source_id:sourceId};
 const a=(await m.saveItem({...input,title:'One'})),b=(await m.saveItem({...input,title:'Two'})),c=(await m.saveItem({...input,title:'Three'}));
 await assert.rejects(async ()=>(await m.saveItem({...input,title:'Fourth'})),/Three outcomes/);
 assert.equal((await m.one("SELECT count(*) AS n FROM items WHERE status='now'")).n,3);
 const four=(await m.saveItem({...input,title:'Fourth',replace_id:a.id,tradeoff_reason:'More immediate decision',replace_checkpoint:'2026-09-25'}));
 assert.equal((await m.one("SELECT status FROM items WHERE id=?",a.id)).status,'later');assert.equal((await m.one("SELECT count(*) AS n FROM items WHERE status='now'")).n,3);
 assert.equal(four.original_checkpoint,'2026-09-21');assert.equal((await m.one("SELECT count(*) AS n FROM events WHERE action='displaced'")).n,1);
 await assert.rejects(async ()=>(await m.saveItem({...four,status:'done',evidence:''})),/evidence/);
 const done=(await m.saveItem({...four,status:'done',evidence:'Recommendation prepared and saved.'}));
 assert.equal(done.status,'done');await assert.rejects(async ()=>(await m.saveItem({...four,title:'Stale update'})),/changed/);
 await assert.rejects(async ()=>(await m.saveItem({...b,checkpoint:'2026-09-23',reason:''})),/why this commitment changed/);
 await assert.rejects(async ()=>(await m.saveItem({...c,checkpoint:'2026-02-31'})),/valid date/);
});
test('waiting and deferred work need a concrete return checkpoint',async()=>{
 await assert.rejects(async ()=>(await m.saveItem({title:'Wait',status:'waiting'})),/check-back/);
 await assert.rejects(async ()=>(await m.saveItem({title:'Later',status:'later',reason:'No capacity'})),/review date/);
});
test('agent proposals require verified excerpts and never auto-accept work',async()=>{
 const id=(await agent.createJob('Review release'));
 const result={brief:'Decide before making a plan.',findings:[{text:'Release readiness is unresolved.',citations:[{source_id:sourceId,quote:'Alex: The release needs one more review.'}]}],proposals:[{title:'Clarify the release decision',kind:'decision',rationale:'The premise is unresolved.',done_when:'One recommendation',next_action:'Write uncertainties',existing_item_id:'',uncertainty:'Current status needs verification',confidence:'medium',citations:[{source_id:sourceId,quote:'Alex: The release needs one more review.'}]}],questions:['Is the release review complete?'],coverage_note:'One local test meeting only.'};
 const invalid=structuredClone(result);invalid.findings[0].citations[0].quote='A fabricated quote';await assert.rejects(async ()=>(await agent.validateResult(invalid)),/unverified/);
 const before=(await m.one('SELECT count(*) AS n FROM items')).n;(await agent.saveResult(id,result));assert.equal((await m.one('SELECT count(*) AS n FROM items')).n,before);
 const proposal=(await m.one('SELECT * FROM proposals'));
 const accepted=(await m.saveItem({title:'Clarify the release decision',status:'candidate',proposal_id:proposal.id}));assert.equal((await m.one('SELECT status FROM proposals WHERE id=?',proposal.id)).status,'accepted');assert.equal(accepted.status,'candidate');
 await assert.rejects(async ()=>(await m.saveItem({title:'Duplicate accept',status:'candidate',proposal_id:proposal.id})),/already resolved/);
});
test('Gmail stores decoded bodies and attachment names, and no credentials in export',async()=>{
 const mail={id:'m1',threadId:'t1',internalDate:'1789401600000',payload:{headers:[{name:'Subject',value:'Decision follow-up'},{name:'From',value:'a@example.com'}],parts:[{mimeType:'text/plain',body:{data:Buffer.from('Please review the decision.').toString('base64url')}},{filename:'brief.pdf',mimeType:'application/pdf',body:{attachmentId:'a1',size:1200}}]}};
 const d=conn.normalizeGmail(mail);assert.match(d.body,/Please review/);assert.match(d.body,/brief.pdf/);assert.equal(d.coverage,'email body');
 (await conn.configure({fireflies_key:'test-key-never-export'}));assert.equal((await conn.connectionState()).fireflies.configured,true);assert.ok(!JSON.stringify((await m.exportData())).includes('test-key-never-export'));
});
test('Granola paginates notes and transcripts and commits its cursor only at completion',async()=>{
 (await conn.configure({granola_key:'fake-test-key'}));const oldFetch=global.fetch;let calls=[];
 global.fetch=async url=>{const u=new URL(url);calls.push(u.href);let body;
 if(u.pathname.endsWith('/transcript'))body=u.searchParams.get('cursor')?{transcript:[{text:'Second page',speaker:{attribution:'them'}}],hasMore:false,cursor:null}:{transcript:[{text:'First page',speaker:{attribution:'me'}}],hasMore:true,cursor:'next'};
 else if(u.pathname==='/v1/notes')body={notes:[{id:'not_example'}],hasMore:false,cursor:null};
 else body={id:'not_example',title:'Paginated meeting',created_at:'2026-09-12T00:00:00Z',summary_text:'Test summary'};
 return new Response(JSON.stringify(body),{status:200});};
 try{const r=await conn.syncProvider('granola');assert.equal(r.total,1);assert.equal(r.complete,true);assert.match((await m.readSource('granola:not_example')).body,/First page[\s\S]*Second page/);assert.ok((await m.getSetting('granola_since')));assert.equal(calls.length,4);}finally{global.fetch=oldFetch;}
});
test('an expired Gmail history cursor falls back to a full sync and records new progress',async()=>{
 writeFileSync(join(temp,'connections.secret.json'),JSON.stringify({gmail_tokens:{refresh_token:'fake',access_token:'fake',expires_at:Date.now()+1000000}}));(await m.setSetting('gmail_history','expired'));const oldFetch=global.fetch;let paths=[];
 global.fetch=async url=>{const u=new URL(url);paths.push(u.pathname);if(u.pathname.endsWith('/history'))return new Response(JSON.stringify({error:{message:'expired'}}),{status:404});if(u.pathname.endsWith('/profile'))return Response.json({historyId:'new-cursor',emailAddress:'owner@example.com'});if(u.pathname.endsWith('/messages'))return Response.json({messages:[{id:'newmail'}]});return Response.json({id:'newmail',threadId:'thread',internalDate:'1789401600000',payload:{headers:[{name:'Subject',value:'Fresh message'}],mimeType:'text/plain',body:{data:Buffer.from('Current context').toString('base64url')}}});};
 try{const r=await conn.syncProvider('gmail');assert.equal(r.complete,true);assert.equal((await m.getSetting('gmail_history')),'new-cursor');assert.equal((await m.readSource('gmail:newmail')).coverage,'email body');assert.ok(paths.some(p=>p.endsWith('/history')));}finally{global.fetch=oldFetch;}
});
test('Google Gmail grants refuse to mix mailboxes',async()=>{
 const oldFetch=global.fetch;global.fetch=async()=>Response.json({emailAddress:'different@example.com'});
 try{await assert.rejects(()=>conn.saveGoogleGrant({access_token:'different-access',refresh_token:'different-refresh',expires_in:3600,scope:'https://www.googleapis.com/auth/gmail.readonly'},{email:'owner@example.com'}),/do not match/);assert.equal((await m.getSetting('gmail_email')),'owner@example.com');assert.notEqual((await conn.secrets()).gmail_tokens.access_token,'different-access');}finally{global.fetch=oldFetch;}
});
test('imports arriving during a review become one durable follow-up',async()=>{
 const active=(await agent.createJob('Current review','test'));
 await m.upsertSource({provider:'granola',external_id:'pending-review-fixture',title:'Recent fictional meeting',body:'A current fictional decision to review.',occurred_at:m.stamp()});
 (await agent.queueImportReview());(await agent.queueImportReview());
 assert.equal((await m.one("SELECT count(*) AS n FROM jobs WHERE status IN ('queued','running')")).n,1);
 assert.ok(await m.one("SELECT source_id FROM review_queue WHERE completed=false AND job_id IS NULL"));
 (await m.run("UPDATE jobs SET status='complete' WHERE id=?",active));
 const next=(await agent.takePendingImportReview());assert.ok(next);assert.equal((await m.one('SELECT kind FROM jobs WHERE id=?',next)).kind,'import_review');
 assert.equal((await m.getSetting('pending_import_review')),null);assert.equal((await agent.takePendingImportReview()),null);
 (await m.run("UPDATE jobs SET status='complete' WHERE id=?",next));
});
test('research imports retain supplied text without creating historical task seeds',async()=>{
 const {importResearchArchive}=await import('../lib/imports.mjs');const before=(await m.one('SELECT count(*) AS n FROM items')).n;
 const text='Alex: Review the release checklist with the team.';
 const first=(await importResearchArchive({},text)),second=(await importResearchArchive({},text));
 assert.equal(first.changed,1);assert.equal(second.changed,0);
 const row=(await m.one('SELECT * FROM sources WHERE body=?',text));assert.equal(row.title,'Imported transcript');assert.equal(row.occurred_at,'');
 assert.equal((await m.one('SELECT count(*) AS n FROM items')).n,before);
});
test('Fireflies uses the configured participant and refuses an unscoped import',async()=>{
 (await conn.configure({fireflies_key:'fixture-fireflies-key'}));
 const owner=process.env.XIN_ALLOWED_EMAIL,participant=process.env.XIN_FIREFLIES_PARTICIPANT_EMAIL,originalFetch=global.fetch;
 delete process.env.XIN_ALLOWED_EMAIL;delete process.env.XIN_FIREFLIES_PARTICIPANT_EMAIL;
 try{
  await assert.rejects(()=>conn.syncProvider('fireflies'),/Configure the workspace owner/);
  process.env.XIN_ALLOWED_EMAIL='owner@example.com';let variables;
  global.fetch=async(url,options)=>{variables=JSON.parse(options.body).variables;return Response.json({data:{transcripts:[]}});};
  assert.equal((await conn.syncProvider('fireflies')).complete,true);assert.deepEqual(variables.participants,['owner@example.com']);
  process.env.XIN_FIREFLIES_PARTICIPANT_EMAIL='participant@example.com';await conn.syncProvider('fireflies');assert.deepEqual(variables.participants,['participant@example.com']);
 }finally{global.fetch=originalFetch;if(owner===undefined)delete process.env.XIN_ALLOWED_EMAIL;else process.env.XIN_ALLOWED_EMAIL=owner;if(participant===undefined)delete process.env.XIN_FIREFLIES_PARTICIPANT_EMAIL;else process.env.XIN_FIREFLIES_PARTICIPANT_EMAIL=participant;}
});
test.after(async ()=>{(await m.db.close());rmSync(temp,{recursive:true,force:true});});
