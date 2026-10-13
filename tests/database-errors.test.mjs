import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sql,DrizzleQueryError} from 'drizzle-orm';
import {db,run,databaseErrorCode} from '../lib/postgres.ts';

async function rejection(promise){try{await promise;}catch(e){return e;}throw Error('Expected the query to fail.');}

test('databaseErrorCode reports the Postgres code for raw and Drizzle query failures',async()=>{
 assert.equal(databaseErrorCode(await rejection(run('SELECT missing_column FROM settings'))),'42703');
 const wrapped=await rejection(db.execute(sql`SELECT missing_column FROM settings`));
 // Drizzle's message carries the SQL and parameters, so callers must show a fixed message instead.
 assert.match(wrapped.message,/missing_column/);
 assert.equal(databaseErrorCode(wrapped),'42703');
});

test('databaseErrorCode flags Drizzle failures without a Postgres code and ignores application errors',()=>{
 assert.equal(databaseErrorCode(new DrizzleQueryError('select 1',[],Error('Database integer exceeds safe precision.'))),'query');
 assert.equal(databaseErrorCode(Object.assign(Error('connect ECONNREFUSED'),{code:'ECONNREFUSED'})),'ECONNREFUSED');
 assert.equal(databaseErrorCode(Error('Choose a valid date.')),undefined);
 assert.equal(databaseErrorCode(undefined),undefined);
});

test('the import script reports a Drizzle failure by code without printing source contents',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'focus-import-error-')),file=join(dir,'sources.json');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 writeFileSync(file,JSON.stringify([{provider:'manual',external_id:'import-error',title:'Fictional import title',body:'FICTIONAL PRIVATE IMPORT BODY'}]));
 await run("CREATE FUNCTION fail_source_insert() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Fictional serialization failure' USING ERRCODE='40001';END$$");
 await run('CREATE TRIGGER fail_source_insert BEFORE INSERT ON sources FOR EACH ROW EXECUTE FUNCTION fail_source_insert()');
 t.after(async()=>{await run('DROP TRIGGER fail_source_insert ON sources');await run('DROP FUNCTION fail_source_insert()');});
 const child=spawnSync(process.execPath,['scripts/import.mjs',file],{env:{...process.env,XIN_DATA_DIR:dir},encoding:'utf8'});
 assert.equal(child.status,1);assert.equal(child.stderr.trim(),'Import failed (40001).');assert.doesNotMatch(child.stdout+child.stderr,/FICTIONAL PRIVATE IMPORT BODY|Fictional import title/);
});
