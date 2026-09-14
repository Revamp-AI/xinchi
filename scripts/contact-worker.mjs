import {pathToFileURL} from 'node:url';
import {one,run,stamp,transaction} from '../lib/db.mjs';
import {projectSource} from '../lib/contact-extraction.mjs';
import {claimLease,heartbeatLease,requireLease} from '../lib/leases.mjs';
import {closeDatabase} from '../lib/postgres.mjs';
export async function runContactWorker(id){
 const claim=await claimLease('contact_runs',id);if(!claim)return;const {token}=claim;let total=0,checking=false;
 const beat=setInterval(async()=>{if(checking)return;checking=true;try{await heartbeatLease('contact_runs',id,token);}catch{}finally{checking=false;}},10000),guard=()=>requireLease('contact_runs',id,token);
 try{for(;;){await transaction(guard);const q=await one("SELECT * FROM contact_queue WHERE state='pending' ORDER BY updated_at,source_id LIMIT 1");if(!q)break;
 try{await projectSource(q.source_id,guard);}catch(e){await transaction(async()=>{await guard();await run("UPDATE contact_queue SET state='failed',attempts=attempts+1,error='Extraction failed; inspect the source and retry',updated_at=now() WHERE source_id=? AND content_hash=?",q.source_id,q.content_hash);});}
 total++;await run("UPDATE contact_runs SET imported=?,updated_at=? WHERE id=? AND state='running' AND lease_owner=?",total,stamp(),id,token);
 }
 await transaction(async()=>{await guard();const failed=(await one("SELECT count(*) AS n FROM contact_queue WHERE state='failed'")).n;await run('UPDATE contact_runs SET state=?,finished_at=?,message=? WHERE id=?',failed?'partial':'complete',stamp(),failed?`${failed} sources need a retry`:'Contacts are up to date',id);});
 }catch{await run("UPDATE contact_runs SET state='failed',finished_at=?,message='Extraction interrupted; retry to continue' WHERE id=? AND state='running' AND lease_owner=?",stamp(),id,token);}finally{clearInterval(beat);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{await runContactWorker(process.argv[2]);}finally{await closeDatabase();}}
