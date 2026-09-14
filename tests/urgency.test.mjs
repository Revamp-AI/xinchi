import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const temp=mkdtempSync(join(tmpdir(),'xin-urgency-test-'));process.env.XIN_DATA_DIR=temp;
const u=await import('../lib/urgency.mjs');
const today='2026-09-14';
const item=(status,checkpoint='',hard_deadline='',extra={})=>({id:status+checkpoint+hard_deadline,title:'Fixture',status,checkpoint,hard_deadline,...extra});
test('a hard deadline outranks every checkpoint rule and reports signed days',()=>{
 assert.deepEqual(u.attention(item('candidate','','2026-09-13'),today),{level:'overdue',label:'Hard deadline passed',days:-1,field:'hard_deadline'});
 assert.deepEqual(u.attention(item('now','2026-09-13','2026-09-17'),today),{level:'due',label:'Hard deadline in 3 days',days:3,field:'hard_deadline'});
 assert.deepEqual(u.attention(item('later','','2026-09-14'),today),{level:'due',label:'Hard deadline today',days:0,field:'hard_deadline'});
 assert.equal(u.attention(item('waiting','','2026-09-15'),today).label,'Hard deadline in 1 day');
 assert.deepEqual(u.attention(item('candidate','','2026-09-21'),today),{level:'due',label:'Hard deadline in 7 days',days:7,field:'hard_deadline'});
 assert.equal(u.attention(item('candidate','','2026-09-22'),today),null);
 assert.equal(u.attention(item('candidate','2026-09-01'),today),null);
});
test('active checkpoints warn two days ahead and flag the day after',()=>{
 assert.deepEqual(u.attention(item('now','2026-09-13'),today),{level:'overdue',label:'Checkpoint passed',days:-1,field:'checkpoint'});
 assert.deepEqual(u.attention(item('now','2026-09-14'),today),{level:'due',label:'Checkpoint today',days:0,field:'checkpoint'});
 assert.equal(u.attention(item('now','2026-09-15'),today).label,'Checkpoint in 1 day');
 assert.deepEqual(u.attention(item('now','2026-09-16'),today),{level:'due',label:'Checkpoint in 2 days',days:2,field:'checkpoint'});
 assert.equal(u.attention(item('now','2026-09-17'),today),null);
 assert.equal(u.attention(item('now'),today),null);
});
test('waiting and later items surface on their check-back or review date',()=>{
 assert.deepEqual(u.attention(item('waiting','2026-09-14'),today),{level:'checkback',label:'Check back due',days:0,field:'checkpoint'});
 assert.equal(u.attention(item('waiting','2026-09-10'),today).days,-4);
 assert.equal(u.attention(item('waiting','2026-09-15'),today),null);
 assert.deepEqual(u.attention(item('later','2026-09-14'),today),{level:'review',label:'Review date reached',days:0,field:'checkpoint'});
 assert.equal(u.attention(item('later','2026-09-01'),today).level,'review');
 assert.equal(u.attention(item('later','2026-09-15'),today),null);
});
test('finished and closed work never asks for attention',()=>{
 assert.equal(u.attention(item('done','2026-09-01','2026-09-01'),today),null);
 assert.equal(u.attention(item('dropped','2026-09-01','2026-09-01'),today),null);
 assert.equal(u.attention(item('now','not-a-date','also-not'),today),null);
});
test('sortByAttention orders by level, then date, and leaves the rest stable',()=>{
 const rest1=item('candidate','','',{id:'rest1'}),rest2=item('done','2026-09-01','',{id:'rest2'});
 const review=item('later','2026-09-13','',{id:'review'}),checkback=item('waiting','2026-09-14','',{id:'checkback'});
 const due2=item('now','2026-09-16','',{id:'due2'}),due1=item('now','2026-09-15','',{id:'due1'});
 const late=item('now','2026-09-13','',{id:'late'}),hard=item('candidate','','2026-09-09',{id:'hard'});
 const sorted=u.sortByAttention([rest1,review,due2,late,rest2,due1,checkback,hard],today);
 assert.deepEqual(sorted.map(x=>x.id),['hard','late','due1','due2','checkback','review','rest1','rest2']);
 assert.deepEqual(u.sortByAttention([],today),[]);
});
test('carryoverCount counts checkpoint moves that keep the item active',()=>{
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
test('localToday uses the local calendar date without a UTC shift',()=>{
 assert.equal(u.localToday(new Date(2026,0,5,23,30)),'2026-01-05');
 assert.equal(u.localToday(new Date(2026,11,31,0,0,1)),'2026-12-31');
 assert.match(u.localToday(new Date()),/^\d{4}-\d{2}-\d{2}$/);
});
test.after(()=>{rmSync(temp,{recursive:true,force:true});});
