import {pathToFileURL} from 'node:url';
import {run,stamp,transaction} from '../lib/db.mjs';
import {syncProvider,clearGmailIssue,recordGmailIssue} from '../lib/connectors.mjs';
import {startContactProjection} from '../lib/contact-jobs.mjs';
import {queueImportReview} from '../lib/agent.mjs';
import {claimLease,heartbeatLease,requireLease} from '../lib/leases.mjs';
import {closeDatabase} from '../lib/postgres.mjs';
export async function runSyncWorker(id){
 const claim=await claimLease('sync_runs',id);if(!claim)return;
 const {row:s,token}=claim;let checking=false;
 const beat=setInterval(async()=>{if(checking)return;checking=true;try{await heartbeatLease('sync_runs',id,token);}catch{}finally{checking=false;}},10000);
 const guard=()=>requireLease('sync_runs',id,token);
 const progress=(sql,...args)=>transaction(async()=>{await guard();return run(sql,...args);});
 try{
  const result=await syncProvider(s.provider,(total,changed)=>progress('UPDATE sync_runs SET imported=?,changed=?,message=?,updated_at=? WHERE id=?',(s.imported||0)+total,(s.changed||0)+changed,`Read ${(s.imported||0)+total} records`,stamp(),id),message=>progress('UPDATE sync_runs SET message=?,updated_at=? WHERE id=?',message,stamp(),id),guard);
  await progress('UPDATE sync_runs SET state=?,finished_at=?,imported=?,changed=?,message=? WHERE id=?',result.complete?'complete':'partial',stamp(),(s.imported||0)+result.total,(s.changed||0)+result.changed,result.note||'Import finished',id);
  if(s.provider==='gmail')await clearGmailIssue();if((s.changed||0)+result.changed){await startContactProjection({drain:true});await queueImportReview();}
 }catch(e){
  if(e.yieldJob){await run("UPDATE sync_runs SET state='queued',lease_owner='',lease_until=NULL,pid=NULL,updated_at=?,message='Import checkpoint saved; continuing in the next cloud invocation' WHERE id=? AND state='running' AND lease_owner=? AND lease_until>now()",stamp(),id,token);return;}
  const r=await run("UPDATE sync_runs SET state='failed',finished_at=?,message=? WHERE id=? AND state='running' AND lease_owner=? AND lease_until>now()",stamp(),e.code?'Import interrupted. Check the connection and retry.':e.message.slice(0,1200),id,token);
  if(r.changes&&s.provider==='gmail')await recordGmailIssue(e);
 }finally{clearInterval(beat);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{await runSyncWorker(process.argv[2]);}finally{await closeDatabase();}}
