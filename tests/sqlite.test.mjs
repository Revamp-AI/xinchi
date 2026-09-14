import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const temp=mkdtempSync(join(tmpdir(),'xin-sqlite-test-'));process.env.XIN_DATA_DIR=temp;
const {openDatabase}=await import('../lib/sqlite.mjs');
const locked=()=>Object.assign(new Error('database is locked'),{code:'ERR_SQLITE_ERROR',errcode:5,errstr:'database is locked'});
function fake(failures){const calls=[];return{calls,Database:class{exec(sql){calls.push(sql);if(sql.includes('journal_mode')&&failures-->0)throw locked();}}};}
const modules=['db','auth'].map(name=>JSON.stringify(new URL('../lib/'+name+'.mjs',import.meta.url).href));
const boot=()=>new Promise(resolve=>{let err='';const child=spawn(process.execPath,['--input-type=module','-e',modules.map(m=>'await import('+m+');').join('')],{env:{...process.env,XIN_DATA_DIR:join(temp,'boot'),XIN_ALLOWED_EMAIL:'owner@example.com'},stdio:['ignore','ignore','pipe']});child.stderr.on('data',d=>err+=d);child.on('exit',code=>resolve({code,err:err.trim()}));});
test('a fresh database opens in WAL mode with the busy timeout set',()=>{
 const db=openDatabase(join(temp,'fresh.sqlite3'));
 assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');
 assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout,10000);
 db.close();
});
test('the WAL switch is retried while the database is locked and gives up within the bound',()=>{
 const waits=[],wait=ms=>waits.push(ms);
 const twice=fake(2);
 assert.ok(openDatabase('fixture',{Database:twice.Database,wait}));
 assert.deepEqual(twice.calls,['PRAGMA busy_timeout=10000','PRAGMA journal_mode=WAL','PRAGMA journal_mode=WAL','PRAGMA journal_mode=WAL']);
 assert.deepEqual(waits.map(ms=>ms>=10&&ms<=50),[true,true]);
 waits.length=0;
 assert.throws(()=>openDatabase('fixture',{Database:fake(Infinity).Database,wait}),/database is locked/);
 const total=waits.reduce((sum,ms)=>sum+ms,0);
 assert.ok(total>=4000&&total<=5100,'backed off for '+total+'ms');
 assert.ok(waits.every(ms=>ms>=10&&ms<=50),'every pause stays short');
 waits.length=0;
 assert.throws(()=>openDatabase('fixture',{Database:class{exec(){throw new Error('no such table: fixture');}},wait}),/no such table/);
 assert.deepEqual(waits,[]);
});
test('several processes can bootstrap a fresh database at once without tripping over the WAL switch',async()=>{
 // next build collects page data with several workers that all import lib/db.mjs and lib/auth.mjs against a brand-new data dir.
 const results=await Promise.all(Array.from({length:8},boot));
 assert.deepEqual(results.filter(r=>r.code!==0).map(r=>r.err),[]);
});
test.after(()=>rmSync(temp,{recursive:true,force:true}));
