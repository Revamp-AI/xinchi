import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {readdirSync} from 'node:fs';
import {migrateDatabase} from '../lib/migrations.ts';
import {createEmptyDatabase,applyLegacyMigrations,schemaDrift} from './helpers/postgres.mjs';

const local=readdirSync('drizzle').sort(),legacy=readdirSync('migrations').filter(n=>n.endsWith('.sql'));
async function query(url,sql,args=[]){const c=new pg.Client({connectionString:url});await c.connect();try{return (await c.query(sql,args)).rows;}finally{await c.end();}}
const ledger=async url=>(await query(url,'SELECT name FROM drizzle.__drizzle_migrations ORDER BY id')).map(r=>r.name);

test('a fresh database is built from Drizzle migrations with seed rows and no legacy ledger',async t=>{
 const url=await createEmptyDatabase(t);
 await migrateDatabase(url);await migrateDatabase(url);
 assert.deepEqual(await ledger(url),local);
 assert.equal((await query(url,"SELECT to_regclass('public.focus_schema_migrations') AS t"))[0].t,null);
 assert.deepEqual((await query(url,'SELECT id FROM priority_stacks ORDER BY position')).map(r=>r.id),['deal-flow','product','go-to-market']);
 assert.deepEqual(await query(url,'SELECT id,version FROM priority_order'),[{id:1,version:1}]);
 assert.deepEqual(await query(url,'SELECT id FROM workspace_lock'),[{id:1}]);
 assert.deepEqual(await schemaDrift(url),[]);
});

test('a database built by the legacy runner adopts the baseline without running its DDL and keeps its data',async t=>{
 const url=await createEmptyDatabase(t);
 await applyLegacyMigrations(url);
 await query(url,"INSERT INTO settings VALUES('kept','true')");
 await migrateDatabase(url);
 assert.deepEqual(await ledger(url),local);
 assert.equal((await query(url,"SELECT value FROM settings WHERE key='kept'"))[0].value,'true');
 assert.deepEqual(await schemaDrift(url),[]);
});

test('a database behind on legacy migrations finishes them before adopting the baseline',async t=>{
 const url=await createEmptyDatabase(t);
 await applyLegacyMigrations(url,14);
 await migrateDatabase(url);
 assert.deepEqual((await query(url,'SELECT name FROM focus_schema_migrations ORDER BY name')).map(r=>r.name),legacy.sort());
 assert.deepEqual(await ledger(url),local);
 assert.deepEqual(await schemaDrift(url),[]);
});

test('concurrent deploys serialize on fresh and legacy databases',async t=>{
 const fresh=await createEmptyDatabase(t),old=await createEmptyDatabase(t);
 await applyLegacyMigrations(old);
 await Promise.all([fresh,old].flatMap(url=>Array.from({length:6},()=>migrateDatabase(url))));
 assert.deepEqual(await ledger(fresh),local);
 assert.deepEqual(await ledger(old),local);
});

test('a changed applied migration is rejected in either ledger',async t=>{
 const fresh=await createEmptyDatabase(t);
 await migrateDatabase(fresh);
 await query(fresh,"UPDATE drizzle.__drizzle_migrations SET hash='changed'");
 await assert.rejects(migrateDatabase(fresh),/An applied migration was changed: /);
 const old=await createEmptyDatabase(t);
 await applyLegacyMigrations(old);
 await query(old,"UPDATE focus_schema_migrations SET checksum='changed' WHERE name='001_postgres.sql'");
 await assert.rejects(migrateDatabase(old),/An applied migration was changed: 001_postgres\.sql/);
});
