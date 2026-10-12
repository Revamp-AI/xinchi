import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {eq,inArray} from 'drizzle-orm';
import {db,transaction,run,one,closeDatabase} from '../lib/postgres.ts';
import {settings,auth_events,beeper_pairings} from '../lib/schema/index.ts';

test('drizzle writes inside transaction() roll back with it',async()=>{
 await assert.rejects(transaction(async()=>{await db.insert(settings).values({key:'orm-rollback',value:'true'});throw Error('stop');}),/stop/);
 assert.equal(await one("SELECT * FROM settings WHERE key='orm-rollback'"),undefined);
});

test('parallel drizzle and raw statements in a failing transaction drain before rollback',async()=>{
 await assert.rejects(transaction(()=>Promise.all([db.insert(settings).values({key:'orm-first',value:'1'}),run('SELECT missing_column FROM settings'),db.insert(settings).values({key:'orm-last',value:'1'})])));
 assert.equal((await one("SELECT count(*) AS n FROM settings WHERE key IN ('orm-first','orm-last')")).n,0);
});

test('drizzle reads see uncommitted raw writes on the same transaction connection',async()=>{
 await assert.rejects(transaction(async()=>{
  await run("INSERT INTO settings VALUES('orm-visible','1')");
  assert.deepEqual(await db.select().from(settings).where(eq(settings.key,'orm-visible')),[{key:'orm-visible',value:'1'}]);
  throw Error('stop');
 }),/stop/);
 assert.equal(await one("SELECT * FROM settings WHERE key='orm-visible'"),undefined);
});

test('db.transaction commits on its own and joins an enclosing transaction instead of a savepoint',async()=>{
 await db.transaction(async tx=>{await tx.insert(settings).values({key:'orm-committed',value:'1'});});
 assert.equal((await one("SELECT value FROM settings WHERE key='orm-committed'")).value,'1');
 await assert.rejects(transaction(async()=>{
  await db.transaction(async tx=>{await tx.insert(settings).values({key:'orm-nested',value:'1'});});
  throw Error('stop');
 }),/stop/);
 assert.equal(await one("SELECT * FROM settings WHERE key='orm-nested'"),undefined);
});

test('timestamptz columns come back as the same ISO strings as the raw helpers',async()=>{
 await run("INSERT INTO focus_auth.beeper_pairings VALUES('orm-pairing','owner@example.com','2026-01-02 03:04:05.678+00')");
 const raw=await one("SELECT expires_at FROM focus_auth.beeper_pairings WHERE token_hash='orm-pairing'");
 const [row]=await db.select({expires_at:beeper_pairings.expires_at}).from(beeper_pairings).where(eq(beeper_pairings.token_hash,'orm-pairing'));
 assert.equal(raw.expires_at,'2026-01-02T03:04:05.678Z');
 assert.equal(row.expires_at,raw.expires_at);
});

test('int8 columns are numbers and unsafe values are refused',async()=>{
 const [{id}]=await db.insert(auth_events).values({created_at:'2026-01-01T00:00:00.000Z',stage:'test',outcome:'ok',code:'orm'}).returning({id:auth_events.id});
 assert.equal(typeof id,'number');
 assert.equal((await one('SELECT id FROM focus_auth.auth_events WHERE id=?',id)).id,id);
 await run("SELECT setval(pg_get_serial_sequence('focus_auth.auth_events','id'),9007199254740993)::text");
 await run("INSERT INTO focus_auth.auth_events(created_at,stage,outcome,code) VALUES('2026-01-01T00:00:00.000Z','test','ok','orm-unsafe')");
 await assert.rejects(db.select().from(auth_events).where(eq(auth_events.code,'orm-unsafe')),e=>/safe precision/.test(e.cause?.message));
 await run("DELETE FROM focus_auth.auth_events WHERE code IN ('orm','orm-unsafe')");
});

test('db reconnects after closeDatabase',async()=>{
 await closeDatabase();
 assert.deepEqual(await db.select().from(settings).where(inArray(settings.key,['orm-committed'])),[{key:'orm-committed',value:'1'}]);
});
