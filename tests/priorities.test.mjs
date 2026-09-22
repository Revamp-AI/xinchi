import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {MockLanguageModelV4} from 'ai/test';
process.env.XIN_AGENT_MODE='cloud';
const {all,one,run,upsertSource,stamp}=await import('../lib/db.mjs');
const {prioritiesState,savePriority,priorityDetail,reorderPriorities,addPriorityUpdate,queuePriorityContext,decidePrioritySuggestion,readPriorities}=await import('../lib/priorities.mjs');
const {takePendingImportReview,saveResult,validateResult}=await import('../lib/agent.mjs');
const {readReviewBatch}=await import('../lib/review-batches.mjs');
const {runCloudAgent}=await import('../lib/cloud-agent.mjs');
const empty={brief:'Reviewed the assigned meeting.',findings:[],proposals:[],drafts:[],questions:[],coverage_note:'Only cited source pages.'};
const meeting=async(id='atlas',body='Atlas needs a pricing decision before the pilot.',occurred_at=stamp())=>{const {id:sourceId}=await upsertSource({provider:'granola',external_id:id,title:'Atlas pilot discussion',body,occurred_at,coverage:'summary'});return one('SELECT * FROM sources WHERE id=?',sourceId);};
async function evidence(source){const version=await one('SELECT id FROM source_versions WHERE source_id=? AND content_hash=?',source.id,source.content_hash);return{source_id:source.id,source_version_id:version.id,quote:source.body};}
const update=(p,c,extra={})=>({priority_id:p.id,summary:'The team discussed pricing for Atlas.',next_decision:'Approve pilot pricing',suggested_rank:null,reason:'The meeting identified an unresolved pricing decision.',citations:[c],...extra});
test.beforeEach(async()=>{await run('TRUNCATE priority_updates,priority_suggestions,priorities,review_queue,review_batches,jobs,sources,items CASCADE');await run("UPDATE priority_stacks SET position=CASE id WHEN 'deal-flow' THEN 0 WHEN 'product' THEN 1 ELSE 2 END");});
test('manual edits and reorders require current versions and exact membership, including stack ordering',async()=>{
 const a=await savePriority({title:'Atlas',financials:'$48,000 ARR'}),b=await savePriority({title:'Birch'});
 let state=await prioritiesState();await assert.rejects(reorderPriorities({stack_id:'deal-flow',version:state.order_version,ids:[a.id,a.id]}),/exactly once/);
 state=await reorderPriorities({stack_id:'deal-flow',version:state.order_version,ids:[b.id,a.id]});assert.deepEqual(state.items.map(p=>p.id),[b.id,a.id]);
 await assert.rejects(savePriority({id:a.id,version:a.version,title:'Stale'}),/changed/);
 await assert.rejects(reorderPriorities({version:state.order_version-1,ids:state.stacks.map(s=>s.id)}),/order changed/);
 state=await reorderPriorities({version:state.order_version,ids:['product','go-to-market','deal-flow']});assert.equal(state.stacks[0].id,'product');
 const current=await priorityDetail(a.id);const done=await savePriority({id:a.id,version:current.version,status:'done'});assert.equal(done.financials,'$48,000 ARR');
 await assert.rejects(savePriority({title:'Broken link',commitment_id:'missing'}),/Commitment not found/);
});
test('enrichment verifies immutable citations and never overrides manual order, owner, financials or next decision',async()=>{
 const p=await savePriority({title:'Atlas',owner:'Alex',financials:'$48,000 ARR',next_decision:'Confirm scope'}),s=await meeting(),c=await evidence(s),job=await takePendingImportReview();
 await saveResult(job,{...empty,priority_updates:[update(p,c,{suggested_rank:1})]});
 let detail=await priorityDetail(p.id);assert.equal(detail.updates.length,1);assert.equal(detail.owner,'Alex');assert.equal(detail.financials,'$48,000 ARR');assert.equal(detail.next_decision,'Confirm scope');assert.equal(detail.position,0);assert.equal(detail.version,p.version);assert.equal(detail.suggestions.length,1);assert.equal(detail.updates[0].citations[0].title,s.title);
 await assert.rejects(validateResult({...empty,priority_updates:[update(p,{...c,quote:'This quote does not exist in the source.'})]}),/unverified/);
 await assert.rejects(validateResult({...empty,priority_updates:[update({id:'unknown'},c)]}),/unknown priority/);
 detail=await decidePrioritySuggestion({id:detail.suggestions[0].id,action:'apply',version:detail.version});assert.equal(detail.next_decision,'Approve pilot pricing');assert.equal(detail.suggestions.length,0);
});
test('older context does not replace the latest update; repeated evidence does not duplicate history',async()=>{
 const p=await savePriority({title:'Atlas'}),recent=await meeting('recent'),c=await evidence(recent);
 let job=await takePendingImportReview();await saveResult(job,{...empty,priority_updates:[update(p,c,{summary:'Current pilot pricing review.',next_decision:''})]});
 await queuePriorityContext(p.id);job=await takePendingImportReview();await saveResult(job,{...empty,priority_updates:[update(p,c,{summary:'Same evidence, paraphrased.',next_decision:''})]});
 assert.equal((await priorityDetail(p.id)).updates.length,1);
 const old=await meeting('old','Atlas was only an early exploration.',new Date(Date.now()-7*86400000).toISOString());job=await takePendingImportReview();await saveResult(job,{...empty,priority_updates:[update(p,await evidence(old),{summary:'An older exploration.',next_decision:''})]});
 assert.notEqual((await priorityDetail(p.id)).latest_summary,'An older exploration.');
});
test('new priorities revisit matching sources even when a review is already running',async()=>{
 await meeting();const first=await takePendingImportReview();const p=await savePriority({title:'Atlas'});assert.equal((await one('SELECT revisit FROM review_queue')).revisit,true);
 await saveResult(first,empty);let q=await one('SELECT * FROM review_queue');assert.equal(q.completed,false);assert.equal(q.next_offset,0);assert.equal(q.revisit,false);
 const second=await takePendingImportReview();assert.equal((await readReviewBatch(second)).sources.length,1);await saveResult(second,empty);q=await one('SELECT * FROM review_queue');assert.equal(q.completed,true);
 assert.equal((await queuePriorityContext(p.id)).queued,1);
});
test('suggestions stay pending, become stale after manual edits, and new priorities need explicit application',async()=>{
 const p=await savePriority({title:'Atlas'}),s=await meeting(),c=await evidence(s);let job=await takePendingImportReview();
 await saveResult(job,{...empty,priority_updates:[update(p,c)],priority_suggestions:[{stack_id:'product',title:'Pilot onboarding',summary:'Prepare onboarding for the pilot.',next_decision:'Confirm the onboarding scope.',citations:[c]}]});
 let state=await prioritiesState();assert.equal(state.items.length,1);const suggestion=state.suggestions.find(s=>s.priority_id===p.id),newSuggestion=state.suggestions.find(s=>!s.priority_id);
 const changed=await savePriority({id:p.id,version:p.version,next_decision:'My own decision'});await assert.rejects(decidePrioritySuggestion({id:suggestion.id,action:'apply',version:changed.version}),/changed since/);
 await decidePrioritySuggestion({id:suggestion.id,action:'dismiss'});const added=await decidePrioritySuggestion({id:newSuggestion.id,action:'apply'});assert.equal(added.stack_id,'product');assert.equal(added.updates.length,1);
 await assert.rejects(decidePrioritySuggestion({id:newSuggestion.id,action:'apply'}),/resolved/);
});
test('manual updates are citable sources and reactivating priorities queues context',async()=>{
 const p=await savePriority({title:'Atlas'});const d=await addPriorityUpdate({id:p.id,body:'Atlas pricing was approved in our internal discussion.'});assert.equal(d.updates[0].origin,'user');assert.equal(d.latest_summary,d.updates[0].body);assert.equal((await one('SELECT body FROM sources WHERE id=?',d.updates[0].citations[0].source_id)).body,d.latest_summary);
 const done=await savePriority({id:p.id,version:p.version,status:'done'});await run('UPDATE review_queue SET completed=true');await savePriority({id:p.id,version:done.version,status:'active'});assert.equal((await one('SELECT completed FROM review_queue')).completed,false);
});
test('cloud review automatically enriches a priority from its assigned meeting without tools or a manual request',async()=>{
 const p=await savePriority({title:'Atlas',next_decision:'Manual decision'}),s=await meeting(),c=await evidence(s),job=await takePendingImportReview();let sawInventory=false;
 const model=new MockLanguageModelV4({doGenerate:async({prompt})=>{sawInventory=JSON.stringify(prompt).includes(p.id)&&JSON.stringify(prompt).includes(s.body);return{content:[{type:'text',text:JSON.stringify({...empty,priority_updates:[update(p,c)]})}],finishReason:{unified:'stop',raw:undefined},usage:{inputTokens:{total:10,noCache:10,cacheRead:0,cacheWrite:0},outputTokens:{total:20,text:20,reasoning:0}},warnings:[]};}});
 await runCloudAgent(job,{model});assert.equal((await one('SELECT status FROM jobs WHERE id=?',job)).status,'complete');assert.equal(sawInventory,true);const detail=await priorityDetail(p.id);assert.equal(detail.updates.length,1);assert.equal(detail.next_decision,'Manual decision');assert.equal(detail.suggestions.length,1);
});
test('priority inventory is bounded and pageable for large workspaces',async()=>{
 for(let n=0;n<25;n++)await savePriority({title:'Initiative '+n,notes:'a'.repeat(4000),next_decision:'b'.repeat(1000),keywords:'c'.repeat(500)});
 let offset=0,count=0;do{const result=await readPriorities({offset});assert.ok(JSON.stringify(result).length<34000);count+=result.items.length;offset=result.next_offset;}while(offset!==null);assert.equal(count,25);
});

test('new priority suggestions are bounded across repeated background batches',async()=>{
 const s=await meeting(),c=await evidence(s),p=await savePriority({title:'Atlas'});
 for(let batch=0;batch<3;batch++){
  await queuePriorityContext(p.id);const id=await takePendingImportReview();
  await saveResult(id,{...empty,priority_suggestions:[0,1,2].map(n=>({stack_id:'product',title:'Initiative '+(batch*3+n),summary:'A supported ongoing initiative.',next_decision:'Review scope.',citations:[c]}))});
 }
 const pending=(await prioritiesState()).suggestions;assert.equal(pending.filter(s=>!s.priority_id).length,6);assert.equal((await readPriorities()).pending_suggestions.length,6);
});
