import {one,run,transaction,stamp,uid} from './db.mjs';
import {REMOTE_WORKERS} from './runtime.mjs';
const columns={jobs:'status',sync_runs:'state',contact_runs:'state'};
function stateColumn(table){if(!columns[table])throw Error('Unknown worker queue.');return columns[table];}
export async function claimLease(table,id){
 const state=stateColumn(table),token=uid();
 const row=await one(`UPDATE ${table} SET ${state}='running',lease_owner=?,lease_until=now()+interval '45 seconds',pid=?,updated_at=? WHERE id=? AND ${state} IN ('queued','running') AND lease_owner='' RETURNING *`,token,process.pid,stamp(),id);
 return row?{row,token}:null;
}
export async function heartbeatLease(table,id,token){
 const state=stateColumn(table);
 return !!(await one(`UPDATE ${table} SET lease_until=now()+interval '45 seconds',updated_at=? WHERE id=? AND lease_owner=? AND ${state}='running' AND lease_until>now() RETURNING id`,stamp(),id,token));
}
export async function requireLease(table,id,token){
 const state=stateColumn(table);
 if(!await one(`SELECT id FROM ${table} WHERE id=? AND lease_owner=? AND ${state}='running' AND lease_until>now() FOR SHARE`,id,token))throw Error('This worker no longer owns the run.');
}
export async function expireLeases(table){
 const state=stateColumn(table),message=table==='jobs'?"error='The previous run was interrupted. Start a new review.'":"finished_at=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),message='Interrupted; retry the import'";
 return run(`UPDATE ${table} SET ${state}='failed',${message},updated_at=? WHERE ${state} IN ('queued','running') AND ((lease_until IS NOT NULL AND lease_until<now()) OR (lease_until IS NULL ${REMOTE_WORKERS?`AND ${state}='running'`:''} AND updated_at::timestamptz<now()-interval '2 minutes'))`,stamp());
}
export async function cancelLease(table,id,message='Cancelled'){
 const state=stateColumn(table);
 return transaction(async()=>{
  const row=await one(`SELECT id FROM ${table} WHERE id=? AND ${state} IN ('queued','running') FOR UPDATE`,id);
  if(!row)throw Error('This run is not running.');
  await run(`UPDATE ${table} SET ${state}='failed',${table==='jobs'?'error':'message'}=?,updated_at=? WHERE id=?`,message,stamp(),id);
  return {cancelled:true};
 });
}
