import {pathToFileURL} from 'node:url';
import {databaseErrorCode} from '../lib/postgres.ts';
import {and,eq,gt,sql} from 'drizzle-orm';
import {stamp,transaction} from '../lib/db.ts';
import {syncProvider,clearGmailIssue,recordGmailIssue} from '../lib/connectors.ts';
import {startContactProjection} from '../lib/contact-jobs.ts';
import {queueImportReview} from '../lib/agent.ts';
import {claimLease,heartbeatLease,requireLease} from '../lib/leases.ts';
import {closeDatabase,db} from '../lib/postgres.ts';
import {sync_runs} from '../lib/schema/index.ts';
export async function runSyncWorker(id:string){
 const claim=await claimLease('sync_runs',id);if(!claim)return;
 const {row:s,token}=claim;let checking=false;
 const beat=setInterval(async()=>{if(checking)return;checking=true;try{await heartbeatLease('sync_runs',id,token);}catch{}finally{checking=false;}},10000);
 const guard=()=>requireLease('sync_runs',id,token);
 // Build each write inside the transaction so it runs on the lease-checked connection.
 const progress=(write:()=>Promise<unknown>)=>transaction(async()=>{await guard();return write();});
 const ours=and(eq(sync_runs.id,id),eq(sync_runs.state,'running'),eq(sync_runs.lease_owner,token),gt(sync_runs.lease_until,sql`now()`));
 try{
  const result=await syncProvider(s.provider,(total,changed)=>progress(()=>db.update(sync_runs).set({imported:(s.imported||0)+total,changed:(s.changed||0)+changed,message:`Read ${(s.imported||0)+total} records`,updated_at:stamp()}).where(eq(sync_runs.id,id))),message=>progress(()=>db.update(sync_runs).set({message,updated_at:stamp()}).where(eq(sync_runs.id,id))),guard);
  await progress(()=>db.update(sync_runs).set({state:result.complete?'complete':'partial',finished_at:stamp(),imported:(s.imported||0)+result.total,changed:(s.changed||0)+result.changed,message:result.note||'Import finished'}).where(eq(sync_runs.id,id)));
  if(s.provider==='gmail')await clearGmailIssue();if((s.changed||0)+result.changed){await startContactProjection({drain:true});await queueImportReview();}
 }catch(caught){
  const e=caught as Error&{yieldJob?:boolean};
  if(e.yieldJob){await db.update(sync_runs).set({state:'queued',lease_owner:'',lease_until:null,pid:null,updated_at:stamp(),message:'Import checkpoint saved; continuing in the next cloud invocation'}).where(ours);return;}
  const failed=await db.update(sync_runs).set({state:'failed',finished_at:stamp(),message:databaseErrorCode(e)?'Import interrupted. Check the connection and retry.':e.message.slice(0,1200)}).where(ours).returning({id:sync_runs.id});
  if(failed.length&&s.provider==='gmail')await recordGmailIssue(e);
 }finally{clearInterval(beat);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{await runSyncWorker(process.argv[2]||'');}finally{await closeDatabase();}}
