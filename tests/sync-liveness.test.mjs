import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const temp=mkdtempSync(join(tmpdir(),'xin-sync-liveness-test-'));process.env.XIN_DATA_DIR=temp;process.env.XIN_ALLOWED_EMAIL='owner@example.com';
const realSpawn=cp.spawn;
const spawned=mock.method(cp,'spawn',()=>({pid:4242,unref(){},on(){}}));syncBuiltinESMExports();
const m=await import('../lib/db.mjs');
const conn=await import('../lib/connectors.mjs');
const at=minutesAgo=>new Date(Date.now()-minutesAgo*60*1000).toISOString();
const until=async check=>{for(let i=0;i<100&&!check();i++)await new Promise(r=>setTimeout(r,50));return check();};
const insertRun=(provider,state,started,extra={})=>{const id=m.uid();m.run('INSERT INTO sync_runs(id,provider,started_at,finished_at,state,imported,message) VALUES(?,?,?,?,?,?,?)',id,provider,started,extra.finished_at??null,state,extra.imported??0,extra.message??'');return id;};
test('dashboard reports one latest run per provider and a newest-first history',()=>{
 insertRun('fireflies','complete',at(60),{finished_at:at(59),imported:4});insertRun('granola','complete',at(30),{finished_at:at(29),imported:2});insertRun('granola','failed',at(10),{finished_at:at(9),message:'Provider request failed (500).'});
 const d=m.dashboard();
 assert.deepEqual(d.sync.map(r=>[r.provider,r.state]),[['granola','failed'],['fireflies','complete']]);
 assert.equal(d.sync[1].changed,0);
 assert.deepEqual(d.sync_history.map(r=>[r.provider,r.state]),[['granola','failed'],['granola','complete'],['fireflies','complete']]);
 for(let i=1;i<d.sync_history.length;i++)assert.ok(d.sync_history[i-1].started_at>=d.sync_history[i].started_at);
});
test('isProcessAlive distinguishes a live pid from one that cannot exist',()=>{
 assert.equal(conn.isProcessAlive(process.pid),true);assert.equal(conn.isProcessAlive(1),true);
 assert.equal(conn.isProcessAlive(2**22),false);assert.equal(conn.isProcessAlive(0),false);assert.equal(conn.isProcessAlive(null),false);
});
test('staleRun treats a run as live only while its process exists and its heartbeat is fresh',()=>{
 const now=Date.now();
 assert.equal(conn.staleRun({pid:process.pid,started_at:at(1),updated_at:at(0)},now),false);
 assert.equal(conn.staleRun({pid:process.pid,started_at:at(20),updated_at:at(0)},now),false);
 assert.equal(conn.staleRun({pid:process.pid,started_at:at(1),updated_at:null},now),false);
 assert.equal(conn.staleRun({pid:2**22,started_at:at(1),updated_at:at(0)},now),true);
 assert.equal(conn.staleRun({pid:process.pid,started_at:at(20),updated_at:at(16)},now),true);
 assert.equal(conn.staleRun({pid:null,started_at:at(0),updated_at:at(0)},now),true);
});
test('startSync refuses to start beside a live import and replaces a dead one',()=>{
 conn.configure({fireflies_key:'fictional-fireflies-key'});
 const live=insertRun('fireflies','running',at(1));m.run('UPDATE sync_runs SET pid=?,updated_at=? WHERE id=?',process.pid,at(0),live);
 const before=spawned.mock.callCount();
 assert.throws(()=>conn.startSync('fireflies'),/already running/);assert.equal(spawned.mock.callCount(),before);
 m.run('UPDATE sync_runs SET pid=? WHERE id=?',2**22,live);
 const {id}=conn.startSync('fireflies');assert.equal(spawned.mock.callCount(),before+1);
 const dead=m.one('SELECT * FROM sync_runs WHERE id=?',live);assert.equal(dead.state,'failed');assert.equal(dead.message,'Interrupted; retry the import');
 const fresh=m.one('SELECT * FROM sync_runs WHERE id=?',id);assert.equal(fresh.state,'running');assert.equal(fresh.pid,4242);assert.ok(fresh.updated_at);
 m.run("UPDATE sync_runs SET state='failed',finished_at=?,message='Test cleanup' WHERE id=?",m.stamp(),id);
});
test('a worker finish stores changed separately from imported and a plain finish message',async()=>{
 conn.configure({fireflies_key:'fictional-fireflies-key'});
 const transcript=(id,text)=>({id,title:'Roadmap sync '+id,dateString:'2026-09-10T10:00:00Z',transcript_url:'https://example.com/t/'+id,sentences:[{speaker_name:'Alex',text,start_time:0,end_time:1}],summary:{short_summary:'Checklist agreed'}});
 const rows=[transcript('ff-1','Ship the checklist')];const oldFetch=global.fetch;global.fetch=async()=>Response.json({data:{transcripts:rows}});
 try{
  assert.equal((await conn.syncProvider('fireflies')).changed,1);
  rows.push(transcript('ff-2','Review the launch email'));
  const {id}=conn.startSync('fireflies');const started=m.one('SELECT * FROM sync_runs WHERE id=?',id);assert.equal(started.pid,4242);
  process.argv[2]=id;await import('../scripts/sync-worker.mjs');
  const r=m.one('SELECT * FROM sync_runs WHERE id=?',id);
  assert.equal(r.state,'complete',r.message);assert.equal(r.imported,2);assert.equal(r.changed,1);assert.equal(r.message,'Import finished');assert.ok(r.finished_at);
  assert.equal(r.pid,process.pid);assert.ok(Date.parse(r.updated_at)>=Date.parse(started.updated_at));
 }finally{global.fetch=oldFetch;}
});
test('recoverSyncRuns fails a running row whose worker is gone and leaves a live one alone',()=>{
 const live=insertRun('granola','running',at(0));m.run('UPDATE sync_runs SET pid=?,updated_at=? WHERE id=?',process.pid,at(0),live);
 const dead=insertRun('gmail','running',at(2));m.run('UPDATE sync_runs SET pid=?,updated_at=? WHERE id=?',2**22,at(1),dead);
 conn.recoverSyncRuns();
 assert.equal(m.one('SELECT state FROM sync_runs WHERE id=?',live).state,'running');
 const r=m.one('SELECT * FROM sync_runs WHERE id=?',dead);assert.equal(r.state,'failed');assert.equal(r.message,'Interrupted; retry the import');assert.ok(r.finished_at);
 m.run("UPDATE sync_runs SET state='failed',finished_at=?,message='Test cleanup' WHERE id=?",m.stamp(),live);
});
test('recoverSyncRuns stops a silent worker that is still alive and reaps a silent dead one',async()=>{
 const child=realSpawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 try{
  const silent=insertRun('granola','running',at(20));m.run('UPDATE sync_runs SET pid=?,updated_at=? WHERE id=?',child.pid,at(20),silent);
  const dead=insertRun('gmail','running',at(20));m.run('UPDATE sync_runs SET pid=?,updated_at=? WHERE id=?',2**22,at(20),dead);
  assert.equal(conn.isProcessAlive(child.pid),true);
  conn.recoverSyncRuns();
  assert.equal(await until(()=>!conn.isProcessAlive(child.pid)),true,'worker still alive after reaping');
  for(const id of [silent,dead]){const r=m.one('SELECT * FROM sync_runs WHERE id=?',id);assert.equal(r.state,'failed');assert.equal(r.message,'Interrupted; retry the import');assert.ok(r.finished_at);}
 }finally{child.kill('SIGKILL');}
});
test('a worker finish and its progress updates leave a reaped run failed and unchanged',async()=>{
 conn.configure({fireflies_key:'fictional-fireflies-key'});
 const oldFetch=global.fetch;global.fetch=async()=>Response.json({data:{transcripts:[{id:'ff-1',title:'Roadmap sync ff-1',dateString:'2026-09-10T10:00:00Z',transcript_url:'https://example.com/t/ff-1',sentences:[{speaker_name:'Alex',text:'Ship the checklist',start_time:0,end_time:1}],summary:{short_summary:'Checklist agreed'}}]}});
 try{
  const {id}=conn.startSync('fireflies');m.run("UPDATE sync_runs SET state='failed',finished_at=?,message='Interrupted; retry the import' WHERE id=?",at(1),id);
  const reaped=m.one('SELECT * FROM sync_runs WHERE id=?',id);
  process.argv[2]=id;await import('../scripts/sync-worker.mjs?reaped');
  const r=m.one('SELECT * FROM sync_runs WHERE id=?',id);
  for(const k of ['state','message','finished_at','imported','changed'])assert.equal(r[k],reaped[k],k);
 }finally{global.fetch=oldFetch;}
});
test('a worker told to stop fails its own run and its later finish cannot revive it',async()=>{
 conn.configure({fireflies_key:'fictional-fireflies-key'});
 let release;const gate=new Promise(r=>{release=r;});const oldFetch=global.fetch;global.fetch=()=>gate;const exit=mock.method(process,'exit',()=>{});
 try{
  const {id}=conn.startSync('fireflies');process.argv[2]=id;const worker=import('../scripts/sync-worker.mjs?stop');
  assert.equal(await until(()=>m.one('SELECT pid FROM sync_runs WHERE id=?',id).pid===process.pid),true,'worker never started');
  process.emit('SIGTERM');
  const stopped=m.one('SELECT * FROM sync_runs WHERE id=?',id);assert.equal(stopped.state,'failed');assert.equal(stopped.message,'Stopped after going silent');assert.ok(stopped.finished_at);assert.ok(exit.mock.callCount()>0);
  release(Response.json({data:{transcripts:[]}}));await worker;
  const r=m.one('SELECT * FROM sync_runs WHERE id=?',id);assert.equal(r.state,'failed');assert.equal(r.message,'Stopped after going silent');assert.equal(r.finished_at,stopped.finished_at);
 }finally{release(Response.json({data:{transcripts:[]}}));global.fetch=oldFetch;exit.mock.restore();}
});
