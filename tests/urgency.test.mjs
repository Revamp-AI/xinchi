import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const temp=mkdtempSync(join(tmpdir(),'xin-urgency-test-'));process.env.XIN_DATA_DIR=temp;
const u=await import('../lib/urgency.mjs');
const m=await import('../lib/db.mjs');
const today='2026-09-14';
const item=(status,checkpoint='',hard_deadline='',extra={})=>({id:status+checkpoint+hard_deadline,title:'Fixture',status,checkpoint,hard_deadline,...extra});
test('a hard deadline outranks every checkpoint rule and reports signed days',async()=>{
 assert.deepEqual(u.attention(item('candidate','','2026-09-13'),today),{level:'overdue',label:'Hard deadline passed',days:-1,field:'hard_deadline'});
 assert.deepEqual(u.attention(item('now','2026-09-13','2026-09-17'),today),{level:'due',label:'Hard deadline in 3 days',days:3,field:'hard_deadline'});
 assert.deepEqual(u.attention(item('later','','2026-09-14'),today),{level:'due',label:'Hard deadline today',days:0,field:'hard_deadline'});
 assert.equal(u.attention(item('waiting','','2026-09-15'),today).label,'Hard deadline in 1 day');
 assert.deepEqual(u.attention(item('candidate','','2026-09-21'),today),{level:'due',label:'Hard deadline in 7 days',days:7,field:'hard_deadline'});
 assert.equal(u.attention(item('candidate','','2026-09-22'),today),null);
 assert.equal(u.attention(item('candidate','2026-09-01'),today),null);
});
test('active checkpoints warn two days ahead and flag the day after',async()=>{
 assert.deepEqual(u.attention(item('now','2026-09-13'),today),{level:'overdue',label:'Checkpoint passed',days:-1,field:'checkpoint'});
 assert.deepEqual(u.attention(item('now','2026-09-14'),today),{level:'due',label:'Checkpoint today',days:0,field:'checkpoint'});
 assert.equal(u.attention(item('now','2026-09-15'),today).label,'Checkpoint in 1 day');
 assert.deepEqual(u.attention(item('now','2026-09-16'),today),{level:'due',label:'Checkpoint in 2 days',days:2,field:'checkpoint'});
 assert.equal(u.attention(item('now','2026-09-17'),today),null);
 assert.equal(u.attention(item('now'),today),null);
});
test('waiting and later items surface on their check-back or review date',async()=>{
 assert.deepEqual(u.attention(item('waiting','2026-09-14'),today),{level:'checkback',label:'Check back due',days:0,field:'checkpoint'});
 assert.equal(u.attention(item('waiting','2026-09-10'),today).days,-4);
 assert.equal(u.attention(item('waiting','2026-09-15'),today),null);
 assert.deepEqual(u.attention(item('later','2026-09-14'),today),{level:'review',label:'Review date reached',days:0,field:'checkpoint'});
 assert.equal(u.attention(item('later','2026-09-01'),today).level,'review');
 assert.equal(u.attention(item('later','2026-09-15'),today),null);
});
test('finished and closed work never asks for attention',async()=>{
 assert.equal(u.attention(item('done','2026-09-01','2026-09-01'),today),null);
 assert.equal(u.attention(item('dropped','2026-09-01','2026-09-01'),today),null);
 assert.equal(u.attention(item('now','not-a-date','also-not'),today),null);
});
test('sortByAttention orders by level, then date, and leaves the rest stable',async()=>{
 const rest1=item('candidate','','',{id:'rest1'}),rest2=item('done','2026-09-01','',{id:'rest2'});
 const review=item('later','2026-09-13','',{id:'review'}),checkback=item('waiting','2026-09-14','',{id:'checkback'});
 const due2=item('now','2026-09-16','',{id:'due2'}),due1=item('now','2026-09-15','',{id:'due1'});
 const late=item('now','2026-09-13','',{id:'late'}),hard=item('candidate','','2026-09-09',{id:'hard'});
 const sorted=u.sortByAttention([rest1,review,due2,late,rest2,due1,checkback,hard],today);
 assert.deepEqual(sorted.map(x=>x.id),['hard','late','due1','due2','checkback','review','rest1','rest2']);
 assert.deepEqual(u.sortByAttention([],today),[]);
});
test('carryoverCount counts checkpoint moves that keep the item active',async()=>{
 const ev=(action,before,after)=>({action,before_json:before?JSON.stringify(before):null,after_json:JSON.stringify(after)});
 const events=[
  ev('created',null,{status:'now',checkpoint:'2026-09-10'}),
  ev('updated',{status:'now',checkpoint:'2026-09-10'},{status:'now',checkpoint:'2026-09-17'}),
  ev('updated',{status:'candidate',checkpoint:''},{status:'now',checkpoint:'2026-09-17'}),
  ev('updated',{status:'now',checkpoint:'2026-09-17'},{status:'now',checkpoint:'2026-09-17'}),
  ev('updated',{status:'now',checkpoint:'2026-09-17'},{status:'later',checkpoint:'2026-09-30'}),
  ev('displaced',{status:'now',checkpoint:'2026-09-17'},{status:'later',checkpoint:'2026-09-30'}),
  ev('updated',{status:'later',checkpoint:'2026-09-30'},{status:'now',checkpoint:'2026-10-05'}),
 ];
 assert.equal(u.carryoverCount(events),2);
 assert.equal(u.carryoverCount([]),0);
 assert.equal(u.carryoverCount([{action:'updated',before_json:'{broken',after_json:'{}'}]),0);
});
test('localToday uses the local calendar date without a UTC shift',async()=>{
 assert.equal(u.localToday(new Date(2026,0,5,23,30)),'2026-01-05');
 assert.equal(u.localToday(new Date(2026,11,31,0,0,1)),'2026-12-31');
 assert.match(u.localToday(new Date()),/^\d{4}-\d{2}-\d{2}$/);
});
test('saveItem persists the last action and fallback for waiting work',async()=>{
 const w=(await m.saveItem({title:'Wait for legal',status:'waiting',dependency:'Legal review',checkpoint:'2026-09-20',last_action:'Sent the draft on Friday',fallback:'Escalate to Sam'}));
 assert.deepEqual({...(await m.one('SELECT last_action,fallback FROM items WHERE id=?',w.id))},{last_action:'Sent the draft on Friday',fallback:'Escalate to Sam'});
 const plain=(await m.saveItem({title:'No notes',status:'candidate'}));assert.equal(plain.last_action,'');assert.equal(plain.fallback,'');
 await assert.rejects(async ()=>(await m.saveItem({title:'Wait',status:'waiting',last_action:'Pinged',fallback:'Escalate'})),/check-back/);
 assert.ok((await m.all("SELECT column_name AS name FROM information_schema.columns WHERE table_name='items'")).some(c=>c.name==='fallback'));
});
test('dashboard carryovers count checkpoint moves on active work only',async()=>{
 const input={status:'now',done_when:'A signed brief',next_action:'Draft it',owner:'Alex',checkpoint:'2026-09-20'};
 const a=(await m.saveItem({...input,title:'Brief'}));
 assert.deepEqual((await m.dashboard()).carryovers.map(r=>({...r})),[]);
 const a2=(await m.saveItem({...a,checkpoint:'2026-09-27',reason:'Waiting on numbers'}));
 assert.deepEqual((await m.dashboard()).carryovers.map(r=>({...r})),[{item_id:a.id,n:1}]);
 (await m.saveItem({...a2,checkpoint:'2026-10-04',reason:'Slipped again'}));
 assert.deepEqual((await m.dashboard()).carryovers.map(r=>({...r})),[{item_id:a.id,n:2}]);
 const l=(await m.saveItem({title:'Defer',status:'later',reason:'No capacity',checkpoint:'2026-10-01'}));
 (await m.saveItem({...l,checkpoint:'2026-10-08',reason:'Still no capacity'}));
 assert.deepEqual((await m.dashboard()).carryovers.map(r=>({...r})),[{item_id:a.id,n:2}]);
});
test.after(async ()=>{(await m.db.close());rmSync(temp,{recursive:true,force:true});});
