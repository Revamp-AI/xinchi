import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {MockLanguageModelV4} from 'ai/test';
import {run,one,setSetting,upsertSource} from '../lib/db.mjs';
import {saveContact,contactDetail,listContacts} from '../lib/contacts.mjs';
import {logInteraction} from '../lib/contact-extraction.mjs';
import {mergePreview,mergeContacts,undoMerge} from '../lib/contact-identity.mjs';
import {runContactIntelligence,contactEvidence,validateContactInsights,generateContactInsights,configureContactIntelligence,dismissContactInsight} from '../lib/contact-intelligence.mjs';
async function reset(){await run('TRUNCATE contacts CASCADE');await setSetting('contact_intelligence',{});}
const quote='Alex is our customer and we reviewed their paid renewal together.';
async function fixture(name='Alex Customer',extra={}){const c=await saveContact({name,...extra});await logInteraction({contact_id:c.id,kind:'meeting',direction:'mutual',meaningful:true,occurred_at:new Date(Date.now()-45*86400000).toISOString(),body:quote});return c;}
function output(packets){return{contacts:packets.map(p=>({contact_id:p.contact_id,purpose_tags:['Customer'],summary:'Reviewed a customer renewal.',next_action:'Review renewal notes.',confidence:'high',citations:[{source_id:p.sources.find(s=>s.body.includes(quote)).source_id,source_version_id:p.sources.find(s=>s.body.includes(quote)).source_version_id,quote}]}))};}
const generate=async packets=>({output:output(packets),model:'fixture',usage:{totalTokens:10}});
test('agent enriches purpose with exact evidence, preserves manual tags, and skips unchanged profiles',async()=>{
 await reset();const c=await fixture();await runContactIntelligence({generate,force:true});
 const detail=await contactDetail(c.id);assert.deepEqual(detail.tags,[]);assert.deepEqual(detail.insight.result.purpose_tags,['Customer']);
 const results=await listContacts({tag:'Customer'});assert.equal(results.total,1);assert.equal(results.records[0].purpose_origin,'agent');assert.deepEqual(results.purpose_tags,['Customer']);
 let called=false;await runContactIntelligence({generate:async()=>{called=true;throw Error('Unchanged');},force:true});assert.equal(called,false);
 await saveContact({...c,tags:['Partner']});assert.equal((await listContacts({tag:'Customer'})).total,0);assert.equal((await listContacts({tag:'Partner'})).records[0].purpose_origin,'manual');
});
test('address-book-only profiles remain unknown without spending a model call',async()=>{
 await reset();const c=await saveContact({name:'Only Address',organization:'Customer Inc',role:'Investor'});let called=false;
 await runContactIntelligence({generate:async()=>{called=true;},force:true});assert.equal(called,false);assert.deepEqual((await contactDetail(c.id)).insight.result.purpose_tags,[]);
});
test('unrelated, fabricated and missing citations cannot be persisted',async()=>{
 await reset();const a=await fixture('A'),b=await fixture('B'),packets=[await contactEvidence(a),await contactEvidence(b)];
 const unrelated=output(packets);unrelated.contacts[0].citations=unrelated.contacts[1].citations;await assert.rejects(validateContactInsights(unrelated,packets),/unrelated/);
 const fake=output(packets);fake.contacts[0].citations[0].quote='This statement was never recorded.';await assert.rejects(validateContactInsights(fake,packets),/unverified/);
 const missing=output(packets);missing.contacts[0].citations=[];await assert.rejects(validateContactInsights(missing,packets),/needs source/);
 const ids=output(packets);ids.contacts[0].contact_id=b.id;await assert.rejects(validateContactInsights(ids,packets),/mismatched/);
});
test('agent reads additional evidence with tools and records model usage',async()=>{
 await reset();const c=await fixture(),packets=[await contactEvidence(c)];let step=0;
 const usage={inputTokens:{total:10,noCache:10,cacheRead:0,cacheWrite:0},outputTokens:{total:20,text:20,reasoning:0}};
 const model=new MockLanguageModelV4({doGenerate:async()=>({content:step++===0?[{type:'tool-call',toolCallId:'read-fixture',toolName:'read_contact_source',input:JSON.stringify({source_version_id:packets[0].sources[0].source_version_id,offset:0})}]:[{type:'text',text:JSON.stringify(output(packets))}],finishReason:{unified:step===1?'tool-calls':'stop',raw:undefined},usage,warnings:[]})});
 await runContactIntelligence({force:true,generate:p=>generateContactInsights(p,{model})});assert.equal(step,2);assert.equal((await contactDetail(c.id)).insight.result.purpose_tags[0],'Customer');
 assert.equal((await one("SELECT usage FROM contact_analysis_runs WHERE state='complete' ORDER BY started_at DESC LIMIT 1")).usage.totalTokens,60);
});
test('paused and restricted contacts get no follow-up suggestion; dismissals and disabled analysis persist',async()=>{
 await reset();const a=await fixture('Paused',{paused:true}),b=await fixture('Restricted',{do_not_contact:true});await runContactIntelligence({generate,force:true});
 for(const c of [a,b])assert.equal((await contactDetail(c.id)).insight.result.next_action,'');
 await dismissContactInsight(a.id);await saveContact({...a,notes:'Additional fictional context.'});await runContactIntelligence({generate,force:true});assert.equal((await contactDetail(a.id)).insight.dismissed,true);
 await configureContactIntelligence(false);assert.equal((await runContactIntelligence({generate,force:true})).skipped,true);
});
test('concurrent edits and pausing while the model runs fence stale writes',async()=>{
 await reset();const c=await fixture();const changed=await runContactIntelligence({force:true,generate:async p=>{await saveContact({...c,notes:'Changed during analysis.'});return generate(p);}});assert.equal(changed.skipped,1);assert.equal((await contactDetail(c.id)).insight,undefined);
 const paused=await runContactIntelligence({force:true,generate:async p=>{await configureContactIntelligence(false);return generate(p);}});assert.ok(paused.error);assert.equal((await contactDetail(c.id)).insight,undefined);
});
test('merge and undo invalidate derived insights while preserving contact decisions',async()=>{
 await reset();const a=await fixture('Merge A'),b=await fixture('Merge B');await runContactIntelligence({generate,force:true});const preview=await mergePreview(a.id,b.id);const merged=await mergeContacts({target_id:a.id,source_id:b.id,token:preview.token});assert.equal((await contactDetail(a.id)).insight,undefined);
 await runContactIntelligence({generate,force:true});await undoMerge(merged.id);assert.equal((await contactDetail(a.id)).insight,undefined);assert.equal((await contactDetail(b.id)).insight,undefined);
});
test('map samples span the full result rather than the first alphabetical page',async()=>{
 await reset();await saveContact({name:'A directory entry'});const c=await fixture('Z last person');const result=await listContacts({limit:1});assert.equal(result.records.length,1);assert.equal(result.records[0].name,'A directory entry');assert.ok(result.map_records.some(r=>r.id===c.id&&r.state==='Cooling'&&r.basis.estimated));
});
test('old source imports enter extraction without a ninety-day cutoff',async()=>{
 const source=await upsertSource({provider:'fireflies',external_id:'historical-'+Date.now(),title:'Old meeting',body:quote,occurred_at:'2020-01-01T12:00:00Z',coverage:'transcript'});assert.equal((await one('SELECT state FROM contact_queue WHERE source_id=?',source.id)).state,'pending');
});
test('overlapping runs share a lease and bound each model batch to eight profiles',async()=>{
 await reset();for(let n=0;n<9;n++)await fixture('Bounded '+n);
 let release,ready;const wait=new Promise(r=>release=r),started=new Promise(r=>ready=r);let size=0;
 const first=runContactIntelligence({force:true,generate:async p=>{size=p.length;ready();await wait;return generate(p);}});await started;
 assert.equal((await runContactIntelligence({force:true,generate})).skipped,true);release();const result=await first;assert.equal(size,8);assert.equal(result.pending,1);
 assert.equal((await runContactIntelligence({force:true,generate})).reviewed,1);
});
test('failed batches back off and cannot block other profiles indefinitely',async t=>{
 t.mock.method(console,'error',()=>{});await reset();const a=await fixture('Failure');
 const failed=await runContactIntelligence({force:true,generate:async()=>{throw Error('Unavailable');}});assert.ok(failed.error);assert.equal((await runContactIntelligence({generate})).skipped,true);
 const b=await fixture('Next Person');const next=await runContactIntelligence({force:true,generate});assert.equal(next.reviewed,1);assert.equal((await contactDetail(a.id)).insight,undefined);assert.ok((await contactDetail(b.id)).insight);
});
test('priority contacts lead bounded analysis without changing outreach restrictions',async()=>{
 await reset();for(let n=0;n<8;n++)await fixture('Ordinary tracked '+n,{tracked:true});
 const c=await fixture('Priority first',{priority:true,paused:true});let first;
 await runContactIntelligence({force:true,generate:async packets=>{first=packets[0];assert.equal(packets.length,8);return generate(packets);}});
 assert.equal(first.contact_id,c.id);assert.equal(first.priority,true);
 const detail=await contactDetail(c.id);assert.equal(detail.insight.result.next_action,'');assert.equal(detail.priority,true);assert.equal(detail.paused,true);
});
