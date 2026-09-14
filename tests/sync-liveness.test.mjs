import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {run,one,uid,stamp,transaction} from '../lib/db.mjs';
import {claimLease,heartbeatLease,expireLeases,requireLease,cancelLease} from '../lib/leases.mjs';
import {runSyncWorker} from '../scripts/sync-worker.mjs';
const insert=async()=>{const id=uid();await run("INSERT INTO sync_runs(id,provider,started_at,updated_at,state) VALUES(?,'fireflies',?,?,'queued')",id,stamp(),stamp());return id;};
test('only one worker claims a run; an expired lease cannot write or heartbeat',async()=>{
 const id=await insert(),claims=await Promise.all([claimLease('sync_runs',id),claimLease('sync_runs',id)]),claim=claims.find(Boolean);
 assert.equal(claims.filter(Boolean).length,1);assert.equal(await heartbeatLease('sync_runs',id,claim.token),true);
 await run("UPDATE sync_runs SET lease_until=now()-interval '1 second' WHERE id=?",id);
 assert.equal(await heartbeatLease('sync_runs',id,claim.token),false);
 await assert.rejects(transaction(()=>requireLease('sync_runs',id,claim.token)),/no longer owns/);
 await expireLeases('sync_runs');assert.equal((await one('SELECT state FROM sync_runs WHERE id=?',id)).state,'failed');
});
test('cancellation cannot be overwritten by a late worker',async()=>{
 const id=await insert(),claim=await claimLease('sync_runs',id);
 await cancelLease('sync_runs',id);
 await assert.rejects(transaction(()=>requireLease('sync_runs',id,claim.token)),/no longer owns/);
 await runSyncWorker(id);assert.equal((await one('SELECT message FROM sync_runs WHERE id=?',id)).message,'Cancelled');
});
test('queued jobs without a worker expire independently of machine PIDs',async()=>{
 const id=await insert();await run("UPDATE sync_runs SET pid=?,updated_at=? WHERE id=?",process.pid,new Date(Date.now()-180000).toISOString(),id);
 await expireLeases('sync_runs');assert.equal((await one('SELECT state FROM sync_runs WHERE id=?',id)).state,'failed');
});
