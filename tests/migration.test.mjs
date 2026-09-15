import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {migrateSqlite} from '../scripts/migrate-sqlite.mjs';
import {one,exportData,hash} from '../lib/db.mjs';
const dir=mkdtempSync(join(tmpdir(),'focus-migration-'));
test('SQLite cutover preserves exact IDs, source text, raw snapshots and pinned owner, invalidates sessions, and refuses overwrites',async()=>{
 const old=new DatabaseSync(join(dir,'xin.sqlite3'));
 old.exec("CREATE TABLE sources(id TEXT PRIMARY KEY,provider TEXT,external_id TEXT,title TEXT,occurred_at TEXT,body TEXT,url TEXT,coverage TEXT,content_hash TEXT,imported_at TEXT,updated_at TEXT);CREATE TABLE source_versions(id TEXT PRIMARY KEY,source_id TEXT,content_hash TEXT,raw_json TEXT,fetched_at TEXT);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE jobs(id TEXT PRIMARY KEY,kind TEXT,status TEXT,prompt TEXT,created_at TEXT,updated_at TEXT,result_json TEXT,error TEXT,progress TEXT,pid INTEGER);");
 const body='Zoë: Keep these exact words — and\nthis line break. 中文',raw='{ "text" : "Fictional fixture", "ordered": [2, 1] }',date='2026-01-02T10:00:00.000Z';
 old.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('manual:legacy','manual','legacy','Legacy note',date,body,'','document','legacy-hash',date,date);
 old.prepare('INSERT INTO source_versions VALUES(?,?,?,?,?)').run('legacy-version','manual:legacy','legacy-hash',raw,date);
 old.prepare('INSERT INTO settings VALUES(?,?)').run('gmail_page','{"pageToken":"fixture-cursor","historyId":"123"}');
 old.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?)').run('legacy-job','review','running','Fictional request',date,date,null,'','Reading',4321);old.close();
 const auth=new DatabaseSync(join(dir,'auth.secret.sqlite3'));auth.exec('CREATE TABLE owner(id INTEGER PRIMARY KEY,sub TEXT,email TEXT,name TEXT);CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,sub TEXT,created_at INTEGER,expires_at INTEGER)');auth.prepare('INSERT INTO owner VALUES(1,?,?,?)').run('pinned-owner','owner@example.com','Owner');auth.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('old-session','pinned-owner',1,9999999999999);auth.close();
 const dry=await migrateSqlite({sourceDir:dir,backupDir:join(dir,'dry')});assert.equal(dry.applied,false);assert.equal((await one('SELECT count(*) AS n FROM sources')).n,0);
 const result=await migrateSqlite({sourceDir:dir,backupDir:join(dir,'cutover'),apply:true,writersStopped:true});assert.equal(result.applied,true);assert.equal(result.source_digest,hash([['manual:legacy',body,'legacy-hash']]));
 assert.equal((await one('SELECT body FROM sources')).body,body);assert.equal((await one('SELECT raw_json FROM source_versions')).raw_json,raw);assert.equal((await one('SELECT sub FROM focus_auth.owner')).sub,'pinned-owner');assert.equal((await one('SELECT count(*) AS n FROM focus_auth.sessions')).n,0);assert.equal((await one('SELECT status FROM jobs')).status,'failed');
 const exported=await exportData();assert.equal(exported.settings.find(s=>s.key==='gmail_page').value,'{"pageToken":"fixture-cursor","historyId":"123"}');assert.equal(JSON.stringify(exported).includes('pinned-owner'),false);
 await assert.rejects(migrateSqlite({sourceDir:dir,backupDir:join(dir,'again'),apply:true,writersStopped:true}),/Destination must be empty/);
});
test('a custom-format Postgres backup restores exact archive and owner data into a new database',async()=>{
 const url=new URL(process.env.DATABASE_URL),name='focus_restore_'+randomUUID().replaceAll('-','');
 const admin=new pg.Client({connectionString:process.env.DATABASE_URL});await admin.connect();await admin.query('CREATE DATABASE '+name);
 const dbEnv={...process.env,PGHOST:url.hostname,PGPORT:url.port,PGDATABASE:url.pathname.slice(1),...(url.username?{PGUSER:decodeURIComponent(url.username)}:{}),...(url.password?{PGPASSWORD:decodeURIComponent(url.password)}:{})};
 const file=join(dir,'roundtrip.dump');
 try{
  const dump=spawnSync('pg_dump',['--format=custom','--file',file],{env:dbEnv,encoding:'utf8'});assert.equal(dump.status,0,dump.stderr);
  const restore=spawnSync('pg_restore',['--exit-on-error','--dbname',name,file],{env:dbEnv,encoding:'utf8'});assert.equal(restore.status,0,restore.stderr);
  url.pathname='/'+name;const restored=new pg.Client({connectionString:url.href});await restored.connect();
  try{assert.deepEqual((await restored.query('SELECT id,body,content_hash FROM sources ORDER BY id')).rows,(await admin.query('SELECT id,body,content_hash FROM sources ORDER BY id')).rows);assert.deepEqual((await restored.query('SELECT id,raw_json,normalized_body FROM source_versions ORDER BY id')).rows,(await admin.query('SELECT id,raw_json,normalized_body FROM source_versions ORDER BY id')).rows);assert.equal((await restored.query('SELECT sub FROM focus_auth.owner')).rows[0].sub,'pinned-owner');}finally{await restored.end();}
 }finally{await admin.query('DROP DATABASE '+name+' WITH (FORCE)');await admin.end();}
});
test.after(()=>rmSync(dir,{recursive:true,force:true}));
