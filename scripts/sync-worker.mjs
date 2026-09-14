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
  const result=await syncProvider(s.provider,total=>progress('UPDATE sync_runs SET imported=?,message=?,updated_at=? WHERE id=?',total,`Read ${total} records`,stamp(),id),message=>progress('UPDATE sync_runs SET message=?,updated_at=? WHERE id=?',message,stamp(),id),guard);
  await progress('UPDATE sync_runs SET state=?,finished_at=?,imported=?,changed=?,message=? WHERE id=?',result.complete?'complete':'partial',stamp(),result.total,result.changed,result.note||'Import finished',id);
  if(s.provider==='gmail')clearGmailIssue();if(result.changed){await startContactProjection({drain:true});await queueImportReview();}
 }catch(e){
  const r=await run("UPDATE sync_runs SET state='failed',finished_at=?,message=? WHERE id=? AND state='running' AND lease_owner=? AND lease_until>now()",stamp(),e.code?'Import interrupted. Check the connection and retry.':e.message.slice(0,1200),id,token);
  if(r.changes&&s.provider==='gmail')recordGmailIssue(e);
 }finally{clearInterval(beat);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{await runSyncWorker(process.argv[2]);}finally{await closeDatabase();}}
