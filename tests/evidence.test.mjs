import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const temp=mkdtempSync(join(tmpdir(),'xin-evidence-test-'));process.env.XIN_DATA_DIR=temp;
const m=await import('../lib/db.mjs');
const agent=await import('../lib/agent.mjs');
const sparseBody='Alex opened with the roadmap and the hiring plan. Later Morgan mentioned the pricing checklist once, then the conversation moved on to onboarding, the support rotation, and the office move.';
const sparse=m.upsertSource({provider:'manual',external_id:'sparse',title:'Weekly sync',occurred_at:'2026-09-12',coverage:'transcript',body:sparseBody}).id;
const dense=m.upsertSource({provider:'fireflies',external_id:'dense',title:'Pricing review',occurred_at:'2026-09-10',coverage:'transcript',body:'Morgan: The checklist is not done. Alex: Which checklist? Morgan: The pricing checklist for the launch.'}).id;
test('search excerpts mark the matched term and rank the denser match first',()=>{
 const {total,records}=m.searchSources('checklist');
 assert.equal(total,2);assert.equal(records[0].id,dense);assert.equal(records[1].id,sparse);
 for(const r of records)assert.match(r.excerpt,/«checklist»/);
 for(const r of records)assert.ok(m.one('SELECT body FROM sources WHERE id=?',r.id).body.includes(r.excerpt.replace(/[«»]/g,'').replace(/^…|…$/g,'')));
 assert.ok(!records[1].excerpt.startsWith('Alex opened'));assert.ok(records[1].excerpt.length<sparseBody.length);
 assert.deepEqual(Object.keys(records[0]),['id','provider','title','occurred_at','coverage','excerpt']);
 assert.doesNotThrow(()=>m.searchSources('checklist" OR * ?'));assert.equal(m.searchSources('checklist','fireflies').total,1);
});
test('search without a query keeps the leading excerpt and newest-first order',()=>{
 const {total,records}=m.searchSources('');
 assert.equal(total,2);assert.equal(records[0].id,sparse);assert.equal(records[0].excerpt,sparseBody.slice(0,250));
 assert.ok(records.every(r=>!r.excerpt.includes('«')));
 assert.deepEqual(Object.keys(records[0]),['id','provider','title','occurred_at','coverage','excerpt']);
});
const quote='Morgan: The checklist is not done.';
const review={brief:'The pricing launch is waiting on the checklist.',findings:[{text:'The checklist is unfinished.',citations:[{source_id:dense,quote}]}],proposals:[{title:'Finish the pricing checklist',kind:'action',rationale:'The launch depends on it.',done_when:'Every row is checked',next_action:'List the open rows',existing_item_id:'',uncertainty:'',confidence:'high',citations:[{source_id:dense,quote},{source_id:sparse,quote:'Morgan mentioned the pricing checklist once'}]}],questions:[],coverage_note:'Two fixture meetings.'};
test('validateResult names every citation and still rejects fabricated quotes and unknown items',()=>{
 const enriched=agent.validateResult(review);
 for(const c of [...enriched.findings,...enriched.proposals].flatMap(i=>i.citations)){assert.ok(c.title);assert.ok(c.provider);assert.ok(c.occurred_at);}
 assert.deepEqual(enriched.findings[0].citations[0],{source_id:dense,quote,title:'Pricing review',provider:'fireflies',occurred_at:'2026-09-10T00:00:00.000Z'});
 assert.equal(enriched.proposals[0].citations[1].title,'Weekly sync');assert.equal(enriched.proposals[0].citations[1].provider,'manual');
 assert.equal(review.findings[0].citations[0].title,undefined);
 const fake=structuredClone(review);fake.proposals[0].citations[0].quote='Something nobody said in the meeting';assert.throws(()=>agent.validateResult(fake),/unverified/);
 const unknown=structuredClone(review);unknown.proposals[0].existing_item_id='missing-item';assert.throws(()=>agent.validateResult(unknown),/unknown commitment/);
});
test('saved results store the enriched citations in the job and its proposals',()=>{
 const id=agent.createJob('Check the pricing checklist');agent.saveResult(id,review);
 const stored=JSON.parse(m.one('SELECT result_json FROM jobs WHERE id=?',id).result_json);assert.equal(stored.findings[0].citations[0].title,'Pricing review');
 const payload=JSON.parse(m.one('SELECT payload FROM proposals WHERE job_id=?',id).payload);assert.equal(payload.citations[1].title,'Weekly sync');assert.equal(payload.citations[0].occurred_at,'2026-09-10T00:00:00.000Z');
});
test.after(()=>{m.db.close();rmSync(temp,{recursive:true,force:true});});
