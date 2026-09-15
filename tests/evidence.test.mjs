import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const temp=mkdtempSync(join(tmpdir(),'xin-evidence-test-'));process.env.XIN_DATA_DIR=temp;
const m=await import('../lib/db.mjs');
const marks=await import('../lib/marks.mjs');
const agent=await import('../lib/agent.mjs');
const sparseBody='Alex opened with the roadmap and the hiring plan. Later Morgan mentioned the pricing checklist once, then the conversation moved on to onboarding, the support rotation, and the office move.';
const sparse=(await m.upsertSource({provider:'manual',external_id:'sparse',title:'Weekly sync',occurred_at:'2026-09-12',coverage:'transcript',body:sparseBody})).id;
const dense=(await m.upsertSource({provider:'fireflies',external_id:'dense',title:'Pricing review',occurred_at:'2026-09-10',coverage:'transcript',body:'Morgan: The checklist is not done. Alex: Which checklist? Morgan: The pricing checklist for the launch.'})).id;
test('search excerpts mark the matched term and rank the denser match first',async()=>{
 const {total,records}=(await m.searchSources('checklist'));
 assert.equal(total,2);assert.equal(records[0].id,dense);assert.equal(records[1].id,sparse);
 for(const r of records)assert.ok(r.excerpt.includes(marks.MARK_START+'checklist'+marks.MARK_END));
 for(const r of records)assert.ok((await m.one('SELECT body FROM sources WHERE id=?',r.id)).body.includes(marks.stripMarks(r.excerpt)));
 assert.ok(!records[1].excerpt.startsWith('Alex opened'));assert.ok(records[1].excerpt.length<sparseBody.length);
 assert.deepEqual(Object.keys(records[0]),['id','provider','title','occurred_at','coverage','excerpt']);
 await assert.doesNotReject(async ()=>(await m.searchSources('checklist" OR * ?')));assert.equal((await m.searchSources('checklist','fireflies')).total,1);
});
test('search without a query keeps the leading excerpt and newest-first order',async()=>{
 const {total,records}=(await m.searchSources(''));
 assert.equal(total,2);assert.equal(records[0].id,sparse);assert.equal(records[0].excerpt,sparseBody.slice(0,250));
 assert.ok(records.every(r=>!r.excerpt.includes(marks.MARK_START)));
 assert.deepEqual(Object.keys(records[0]),['id','provider','title','occurred_at','coverage','excerpt']);
});
test('search excerpts keep real guillemets and the strip helper removes only the private-use markers',async()=>{
 const body='Bonjour Alex, Morgan a dit « la checklist des prix est prête » avant la réunion.';
 (await m.upsertSource({provider:'gmail',external_id:'french',title:'Relance sur les prix',occurred_at:'2026-09-11',coverage:'email body',body}));
 const [r]=(await m.searchSources('prix','gmail')).records;
 assert.ok(r.excerpt.includes('« la checklist des '+marks.MARK_START+'prix'+marks.MARK_END+' est prête »'));
 assert.equal(marks.stripMarks(r.excerpt),body);
 assert.equal(marks.stripMarks('…'+marks.MARK_START+'a'+marks.MARK_END+' « b » c…'),'a « b » c');
});
const quote='Morgan: The checklist is not done.';
const review={brief:'The pricing launch is waiting on the checklist.',findings:[{text:'The checklist is unfinished.',citations:[{source_id:dense,quote}]}],proposals:[{title:'Finish the pricing checklist',kind:'action',rationale:'The launch depends on it.',done_when:'Every row is checked',next_action:'List the open rows',existing_item_id:'',uncertainty:'',confidence:'high',citations:[{source_id:dense,quote},{source_id:sparse,quote:'Morgan mentioned the pricing checklist once'}]}],questions:[],coverage_note:'Two fixture meetings.'};
test('validateResult names every citation and still rejects fabricated quotes and unknown items',async()=>{
 const enriched=(await agent.validateResult(review));
 for(const c of [...enriched.findings,...enriched.proposals].flatMap(i=>i.citations)){assert.ok(c.title);assert.ok(c.provider);assert.ok(c.occurred_at);}
 assert.deepEqual(enriched.findings[0].citations[0],{source_id:dense,source_version_id:(await m.one('SELECT id FROM source_versions WHERE source_id=?',dense)).id,quote,title:'Pricing review',provider:'fireflies',occurred_at:'2026-09-10T00:00:00.000Z'});
 assert.equal(enriched.proposals[0].citations[1].title,'Weekly sync');assert.equal(enriched.proposals[0].citations[1].provider,'manual');
 assert.equal(review.findings[0].citations[0].title,undefined);
 const fake=structuredClone(review);fake.proposals[0].citations[0].quote='Something nobody said in the meeting';await assert.rejects(async ()=>(await agent.validateResult(fake)),/unverified/);
 const unknown=structuredClone(review);unknown.proposals[0].existing_item_id='missing-item';await assert.rejects(async ()=>(await agent.validateResult(unknown)),/unknown commitment/);
});
test('saved results store the enriched citations in the job and its proposals',async()=>{
 const id=(await agent.createJob('Check the pricing checklist'));(await agent.saveResult(id,review));
 const stored=JSON.parse((await m.one('SELECT result_json FROM jobs WHERE id=?',id)).result_json);assert.equal(stored.findings[0].citations[0].title,'Pricing review');
 const payload=JSON.parse((await m.one('SELECT payload FROM proposals WHERE job_id=?',id)).payload);assert.equal(payload.citations[1].title,'Weekly sync');assert.equal(payload.citations[0].occurred_at,'2026-09-10T00:00:00.000Z');
});
test('saved citations survive later source edits and cannot borrow another source snapshot',async()=>{
 const old=await agent.validateResult(review),citation=old.findings[0].citations[0];
 await m.upsertSource({provider:'fireflies',external_id:'dense',title:'Updated meeting',body:'The source has now been corrected.',coverage:'transcript'});
 const historical=structuredClone(review);historical.findings[0].citations[0].source_version_id=citation.source_version_id;historical.proposals[0].citations[0].source_version_id=citation.source_version_id;
 assert.equal((await agent.validateResult(historical)).findings[0].citations[0].quote,quote);
 const item=await m.saveItem({title:'Snapshot-backed item',source_id:dense,source_version_id:citation.source_version_id,source_quote:quote});assert.equal(item.source_version_id,citation.source_version_id);
 historical.findings[0].citations[0].source_id=sparse;await assert.rejects(agent.validateResult(historical),/unverified/);
});
 test.after(async ()=>{(await m.db.close());rmSync(temp,{recursive:true,force:true});});
