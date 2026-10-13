import {pathToFileURL} from 'node:url';
import {and,eq,gt,sql} from 'drizzle-orm';
import {stamp,transaction} from '../lib/db.ts';
import {projectSource} from '../lib/contact-extraction.ts';
import {claimLease,heartbeatLease,requireLease} from '../lib/leases.ts';
import {closeDatabase,db} from '../lib/postgres.ts';
import {contact_queue,contact_runs} from '../lib/schema/index.ts';
import {checkJobBudget} from '../lib/job-budget.mjs';
export async function runContactWorker(id:string){
 const claim=await claimLease('contact_runs',id);if(!claim)return;const {token}=claim;let total=claim.row.imported||0,checking=false;
 const beat=setInterval(async()=>{if(checking)return;checking=true;try{await heartbeatLease('contact_runs',id,token);}catch{}finally{checking=false;}},10000),guard=()=>requireLease('contact_runs',id,token);
 const running=and(eq(contact_runs.id,id),eq(contact_runs.state,'running'),eq(contact_runs.lease_owner,token));
 try{for(;;){checkJobBudget();await transaction(guard);const [q]=await db.select().from(contact_queue).where(eq(contact_queue.state,'pending')).orderBy(contact_queue.updated_at,contact_queue.source_id).limit(1);if(!q)break;
 try{await projectSource(q.source_id,guard);}catch(e){await transaction(async()=>{await guard();await db.update(contact_queue).set({state:'failed',attempts:sql`${contact_queue.attempts}+1`,error:'Extraction failed; inspect the source and retry',updated_at:sql`now()`}).where(and(eq(contact_queue.source_id,q.source_id),eq(contact_queue.content_hash,q.content_hash)));});}
 total++;await db.update(contact_runs).set({imported:total,updated_at:stamp()}).where(running);
 }
 await transaction(async()=>{await guard();const failed=await db.$count(contact_queue,eq(contact_queue.state,'failed'));await db.update(contact_runs).set({state:failed?'partial':'complete',finished_at:stamp(),message:failed?`${failed} sources need a retry`:'Contacts are up to date'}).where(eq(contact_runs.id,id));});
 }catch(error){if((error as {yieldJob?:boolean}).yieldJob)await db.update(contact_runs).set({state:'queued',lease_owner:'',lease_until:null,pid:null,updated_at:stamp(),message:'Continuing extraction in the next cloud invocation'}).where(and(running,gt(contact_runs.lease_until,sql`now()`)));else await db.update(contact_runs).set({state:'failed',finished_at:stamp(),message:'Extraction interrupted; retry to continue'}).where(running);}finally{clearInterval(beat);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{await runContactWorker(process.argv[2]||'');}finally{await closeDatabase();}}
