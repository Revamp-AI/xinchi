import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const temp=mkdtempSync(join(tmpdir(),'xin-schema-test-'));process.env.XIN_DATA_DIR=temp;
const m=await import('../lib/db.mjs');
const upgrades=[['sync_runs','pid'],['sync_runs','updated_at'],['sync_runs','changed'],['items','last_action'],['items','fallback']];
const columns=(db,table)=>db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name);
const lib=JSON.stringify(new URL('../lib/db.mjs',import.meta.url).href);
const open=()=>new Promise(resolve=>{let err='';const child=spawn(process.execPath,['-e',`import(${lib}).then(()=>process.exit(0),e=>{console.error(e.message);process.exit(1);})`],{env:{...process.env,XIN_DATA_DIR:temp},stdio:['ignore','ignore','pipe']});child.stderr.on('data',d=>err+=d);child.on('exit',code=>resolve({code,err:err.trim().split('\n')[0]||''}));});
test('several processes can open an older database at once without tripping over the column upgrades',async()=>{
 // next build collects page data with several workers that all import lib/db.mjs against the same file.
 for(const [table,column] of upgrades)m.db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
 for(const [table,column] of upgrades)assert.ok(!columns(m.db,table).includes(column),table+'.'+column);
 m.db.close();
 const results=await Promise.all(Array.from({length:8},open));
 assert.deepEqual(results.filter(r=>r.code!==0).map(r=>r.err),[]);
 const db=new DatabaseSync(join(temp,'xin.sqlite3'));
 for(const [table,column] of upgrades)assert.ok(columns(db,table).includes(column),table+'.'+column);
 db.close();
});
test.after(()=>rmSync(temp,{recursive:true,force:true}));
