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
test.after(()=>{m.db.close();rmSync(temp,{recursive:true,force:true});});
