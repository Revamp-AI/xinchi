import {getSetting,one,run,transaction,lockWorkspace} from './db.mjs';
import {secrets} from './secret-store.mjs';
import {startSync} from './connectors.mjs';
import {resumeDurable} from './durable-ingestion.mjs';
import {CLOUD_JOBS} from './runtime.mjs';

const FIVE_MINUTES=5*60000,HOUR=60*60000,DAY=24*HOUR;
export async function scheduleProviderSyncs(){
 if(!CLOUD_JOBS)return[];
 const configured=await secrets(),scheduled=[];
 // Each provider gets its own transaction; an active or broken import cannot
 // prevent another provider from being scheduled. No provider HTTP calls here.
 for(const provider of ['granola','fireflies']){
  if(!configured[provider+'_key'])continue;
  try{
   const result=await transaction(async()=>{
    await lockWorkspace();
    if(await one("SELECT id FROM sync_runs WHERE provider=? AND state IN ('queued','running','uploading') LIMIT 1",provider))return;
    const latest=await one("SELECT s.*,d.outcome FROM sync_runs s LEFT JOIN durable_runs d ON d.kind='sync' AND d.run_id=s.id WHERE s.provider=? ORDER BY s.started_at DESC,s.id DESC LIMIT 1",provider);
    const elapsed=latest?Date.now()-Date.parse(latest.finished_at||latest.updated_at||latest.started_at):Infinity;
    if(elapsed<(latest?.state==='failed'?(latest.outcome?.permanent?DAY:HOUR):FIVE_MINUTES))return;
    if(latest?.state==='failed'){
     const resumed=await resumeDurable('sync',latest.id,provider);
     if(resumed)return{provider,...resumed,resumed:true};
    }
    // Regular Granola discovery already covers every accessible ID. Re-read
    // bodies daily as well, including providers that update text without a date.
    const lastFull=await one("SELECT s.finished_at FROM sync_runs s JOIN durable_runs d ON d.kind='sync' AND d.run_id=s.id WHERE s.provider=? AND s.state='complete' AND d.completed=true AND d.cursor->>'phase'='done' AND (CASE WHEN s.provider='granola' THEN d.cursor->>'rescan'='true' ELSE d.cursor->>'since' IS NULL AND d.cursor->>'participant'=? END) ORDER BY s.finished_at DESC LIMIT 1",provider,(process.env.XIN_FIREFLIES_PARTICIPANT_EMAIL||process.env.XIN_ALLOWED_EMAIL||'').trim());
    const rescan=!await getSetting(provider+'_page')&&(!lastFull||Date.now()-Date.parse(lastFull.finished_at)>=DAY);
    const started=await startSync(provider,{rescan});
    await run("UPDATE sync_runs SET message=? WHERE id=?",rescan?'Automatic history check queued':'Automatic sync queued',started.id);
    return{provider,...started,rescan};
   });
   if(result)scheduled.push(result);
  }catch{scheduled.push({provider,error:'Could not schedule this connection; the next cron will retry.'});}
 }
 return scheduled;
}
