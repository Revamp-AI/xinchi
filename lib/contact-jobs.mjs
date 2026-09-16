import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {all,one,run,transaction,lockWorkspace,uid,stamp,root,setSetting,getSetting} from './db.mjs';
import {expireLeases} from './leases.mjs';
import {REMOTE_WORKERS} from './runtime.mjs';
export async function startContactProjection({full=false,retry=false,drain=false,aliases}={}){
 if(aliases!==undefined){if(!Array.isArray(aliases)||aliases.some(a=>typeof a!=='string'||!a.includes('@')))throw Error('Provide valid owner aliases.');await setSetting('contact_owner_aliases',aliases.map(a=>a.trim().toLowerCase()));}
 const id=await transaction(async()=>{await lockWorkspace();await expireLeases('contact_runs');const active=await one("SELECT id FROM contact_runs WHERE state IN ('queued','running')");if(active)return active.id;
 if(retry)await run("UPDATE contact_queue SET state='pending',attempts=0,error='' WHERE state='failed'");
 else if(!drain){await run(`INSERT INTO contact_queue(source_id,content_hash) SELECT id,content_hash FROM sources WHERE ${full?"true":"occurred_at>=? OR provider='manual'"} ON CONFLICT(source_id) DO UPDATE SET state='pending',attempts=0,error='',content_hash=excluded.content_hash`,...(full?[]:[new Date(Date.now()-90*86400000).toISOString()]));}
 const id=uid();await run("INSERT INTO contact_runs(id,state,started_at,updated_at) VALUES(?,'queued',?,?)",id,stamp(),stamp());return id;});
 if(REMOTE_WORKERS)return{id};
 const child=spawn(process.execPath,[resolve(root,'scripts/contact-worker.mjs'),id],{cwd:root,env:{...process.env,XIN_APP_ROOT:root},detached:true,stdio:'ignore'});child.unref();child.on('error',()=>run("UPDATE contact_runs SET state='failed',message='Could not start extraction' WHERE id=? AND state='queued'",id).catch(()=>{}));return{id};
}
export async function recoverContactRuns(){await expireLeases('contact_runs');return all("SELECT source_id,error FROM contact_queue WHERE state='failed' LIMIT 10");}

// Discover historical sources once, then always drain new source revisions.
export async function scheduleContactHistory(){
 return transaction(async()=>{await lockWorkspace();
  if(!await getSetting('contact_history_backfill_v1')){
   await run("INSERT INTO contact_queue(source_id,content_hash) SELECT id,content_hash FROM sources WHERE provider IN ('gmail','fireflies','granola','beeper') ON CONFLICT(source_id) DO NOTHING");
   await setSetting('contact_history_backfill_v1',stamp());
  }
  if(!await one("SELECT source_id FROM contact_queue WHERE state='pending' LIMIT 1"))return null;
  return startContactProjection({drain:true});
 });
}
