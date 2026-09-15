import {migrateDatabase} from '../lib/migrations.mjs';
import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {all,transaction,run,one} from '../lib/postgres.mjs';
test('versioned migrations serialize concurrent deploys and are idempotent',async()=>{
 await Promise.all(Array.from({length:6},()=>migrateDatabase()));
 assert.ok((await all('SELECT * FROM focus_schema_migrations')).length>=1);
 assert.ok((await all("SELECT column_name FROM information_schema.columns WHERE table_name='jobs'")).some(r=>r.column_name==='lease_until'));
});
test('async transaction rolls back after awaited work fails',async()=>{
 await assert.rejects(transaction(async()=>{await run("INSERT INTO settings VALUES('rollback','true')");await Promise.resolve();throw Error('stop');}),/stop/);
 assert.equal(await one("SELECT * FROM settings WHERE key='rollback'"),undefined);
});

test('a failed parallel transaction drains queued statements before rollback and releases no stray writes',async()=>{
 await assert.rejects(transaction(()=>Promise.all([run("INSERT INTO settings VALUES('first-parallel','true')"),run('SELECT missing_column FROM settings'),run("INSERT INTO settings VALUES('last-parallel','true')")])));
 assert.equal((await one("SELECT count(*) AS n FROM settings WHERE key IN ('first-parallel','last-parallel')")).n,0);
});
