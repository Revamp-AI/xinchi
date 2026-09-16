import {all,one,run,transaction as dbTransaction,lockWorkspace,stamp,uid,setSetting,upsertSource} from './db.mjs';
import {projectSource} from './contact-extraction.mjs';
import {startContactProjection} from './contact-jobs.mjs';
import {queueImportReview} from './agent.mjs';
const tables={sync:'sync_runs',contacts:'contact_runs'};
const transaction=fn=>dbTransaction(async()=>{await run("SET LOCAL statement_timeout='75s'");await run("SET LOCAL lock_timeout='10s'");return fn();});
function tableFor(kind){if(!tables[kind])throw Error('Unknown ingestion queue.');return tables[kind];}
const summary=row=>({revision:row.revision,done:row.completed,...row.outcome});
export async function prepareDispatches(){
 return transaction(async()=>{
  await lockWorkspace();
  await run("UPDATE sync_runs SET state='failed',message='Upload expired; choose the file again',finished_at=?,updated_at=? WHERE provider='manual' AND state='uploading' AND updated_at::timestamptz<now()-interval '24 hours'",stamp(),stamp());
  await run("DELETE FROM import_uploads WHERE run_id IN (SELECT id FROM sync_runs WHERE state='failed') AND created_at<now()-interval '24 hours'");
  for(const [kind,table] of Object.entries(tables))await run(`INSERT INTO durable_runs(kind,run_id) SELECT ?,id FROM ${table} WHERE state='queued' AND lease_owner='' ON CONFLICT DO NOTHING`,kind);
  const pending=await all("SELECT * FROM durable_runs WHERE completed=false AND workflow_id='' AND (dispatch_until IS NULL OR dispatch_until<now()) ORDER BY updated_at LIMIT 4 FOR UPDATE");
  for(const row of pending){row.dispatch_token ||= uid();await run("UPDATE durable_runs SET dispatch_token=?,dispatch_until=now()+interval '2 minutes' WHERE kind=? AND run_id=?",row.dispatch_token,row.kind,row.run_id);}
  return pending.map(r=>({kind:r.kind,id:r.run_id,token:r.dispatch_token}));
 });
}
export async function acknowledgeDispatch(kind,id,token,workflowId){await run("UPDATE durable_runs SET workflow_id=?,updated_at=now() WHERE kind=? AND run_id=? AND dispatch_token=? AND workflow_id=''",workflowId,kind,id,token);}
export async function releaseDispatch(kind,id,token){await run("UPDATE durable_runs SET dispatch_until=now() WHERE kind=? AND run_id=? AND dispatch_token=? AND workflow_id=''",kind,id,token);}
export async function resumeDurable(kind,id,provider){
 return transaction(async()=>{
  await lockWorkspace();const table=tableFor(kind),parent=await one('SELECT * FROM '+table+' WHERE id=? FOR UPDATE',id),row=await one('SELECT * FROM durable_runs WHERE kind=? AND run_id=? FOR UPDATE',kind,id);
  if(!row)return null;
  if(!parent||parent.state!=='failed'||(provider&&parent.provider!==provider))throw Error('Only a failed import can be resumed.');
  if(await one("SELECT id FROM "+table+" WHERE state IN ('queued','running','uploading')"+(kind==='sync'?' AND provider=?':''),...(kind==='sync'?[parent.provider]:[])))throw Error('An import for this connection is already running.');
  if(kind==='contacts')await run("UPDATE contact_queue SET state='pending',attempts=0,error='' WHERE state='failed'");
  await run("UPDATE durable_runs SET workflow_id='',dispatch_token='',dispatch_until=NULL,unit_token='',unit_until=NULL,attempts=0,completed=false,outcome=?::jsonb,updated_at=now() WHERE kind=? AND run_id=?",JSON.stringify({done:false,revision:row.revision}),kind,id);
  await run("UPDATE "+table+" SET state='queued',finished_at=NULL,lease_owner='',lease_until=NULL,updated_at=?,message='Resuming from saved progress' WHERE id=?",stamp(),id);return{id};
 });
}
async function claimUnit(kind,id,token,workflowId,revision){
 const table=tableFor(kind);
 return transaction(async()=>{
  await lockWorkspace();
  const row=await one('SELECT * FROM durable_runs WHERE kind=? AND run_id=? FOR UPDATE',kind,id);
  if(!row||row.dispatch_token!==token||(row.workflow_id&&row.workflow_id!==workflowId))return{result:{done:true,revision}};
  const parent=await one('SELECT * FROM '+table+' WHERE id=? FOR UPDATE',id);
  if(row.completed)return{result:summary(row)};
  if(!parent||!['queued','running'].includes(parent.state)){
   const outcome={revision:row.revision,done:true,...(!parent||parent.state==='failed'?{failed:true}:{})};
   // A legacy invocation may finish after dispatch but before our first step.
   // Close only its durable companion; preserve the legacy result and counters.
   await run("UPDATE durable_runs SET workflow_id=?,completed=true,outcome=?::jsonb,unit_token='',unit_until=NULL,updated_at=now() WHERE kind=? AND run_id=?",workflowId,JSON.stringify(outcome),kind,id);
   return{result:outcome};
  }
  if(row.revision!==revision)return{result:summary(row)};
  const reservedOwner='workflow:'+workflowId;
  if(parent.lease_owner&&parent.lease_owner!==reservedOwner&&parent.lease_until&&Date.parse(parent.lease_until)>Date.now())return{result:{done:false,revision,waitMs:Math.max(1000,Date.parse(parent.lease_until)-Date.now()+1000)}};
  if(row.unit_until&&Date.parse(row.unit_until)>Date.now())return{result:{done:false,revision,waitMs:Math.max(1000,Date.parse(row.unit_until)-Date.now()+1000)}};
  const unit=uid();await run("UPDATE durable_runs SET workflow_id=?,unit_token=?,unit_until=now()+interval '120 seconds',updated_at=now() WHERE kind=? AND run_id=?",workflowId,unit,kind,id);
  // Old deployed claimLease code requires an empty owner. Keep this reservation
  // between steps and sleeps; the independent unit token fences durable writes.
  await run("UPDATE "+table+" SET state='running',lease_owner=?,lease_until=NULL,pid=NULL,updated_at=?,message='Import continues automatically in the background' WHERE id=?",reservedOwner,stamp(),id);
  return{row,parent,unit};
 });
}
async function requireUnit(kind,id,unit){if(!await one('SELECT run_id FROM durable_runs WHERE kind=? AND run_id=? AND unit_token=? AND unit_until>now() AND completed=false FOR UPDATE',kind,id,unit))throw Object.assign(Error('Ingestion ownership changed.'),{lostUnit:true});}
async function advanceContacts(cursor){
 const q=await one("SELECT * FROM contact_queue WHERE state='pending' ORDER BY updated_at,source_id LIMIT 1");
 if(!q)return{cursor:cursor||{},records:[],complete:true};
 return{cursor:{processed:(cursor?.processed||0)+1},contact:q,records:[],processed:1,complete:false};
}
export async function advanceDurableUnit(kind,id,token,workflowId,revision,adapters={}){
 const claimed=await claimUnit(kind,id,token,workflowId,revision);if(claimed.result)return claimed.result;
 const {row,parent,unit}=claimed;
 try{
  let result;
  if(kind==='contacts')result=await (adapters.contacts||advanceContacts)(row.cursor);
  else if(parent.provider==='manual'){const {advanceManual}=await import('./manual-ingestion.mjs');result=await (adapters.manual||advanceManual)(id,row.cursor);}
  else if(parent.provider==='beeper'){const {advanceBeeper}=await import('./beeper.mjs');result=await advanceBeeper(id,row.cursor);}
  else{const providers=await import('./ingestion-providers.mjs');const cursor=row.cursor??await (adapters.initial||providers.initialProviderCursor)(parent.provider);result=await (adapters.advance||providers.advanceProvider)(parent.provider,cursor);}
  return await transaction(async()=>{
   await lockWorkspace();await requireUnit(kind,id,unit);
   const latest=await one('SELECT * FROM '+tableFor(kind)+' WHERE id=? FOR UPDATE',id);
   if(kind==='contacts'&&result.complete&&await one("SELECT source_id FROM contact_queue WHERE state='pending' LIMIT 1"))result.complete=false;
   if(result.contact){const q=result.contact;await run('SAVEPOINT contact_projection');try{await (adapters.project||projectSource)(q.source_id,()=>requireUnit(kind,id,unit));await run('RELEASE SAVEPOINT contact_projection');}catch(e){await run('ROLLBACK TO SAVEPOINT contact_projection');if(e.lostUnit||e.code)throw e;await run("UPDATE contact_queue SET state='failed',attempts=attempts+1,error='Extraction failed; inspect the source and retry',updated_at=now() WHERE source_id=? AND content_hash=?",q.source_id,q.content_hash);await run('RELEASE SAVEPOINT contact_projection');}}
   let changed=0;for(const {doc,raw} of result.records||[])if((await upsertSource(doc,raw)).changed)changed++;
   for(const [key,value] of Object.entries(result.settings||{}))await setSetting(key,value);
   await requireUnit(kind,id,unit);
   const next=revision+1,outcome={revision:next,done:Boolean(result.complete)};
   await run("UPDATE durable_runs SET cursor=?::jsonb,revision=?,attempts=0,completed=?,outcome=?::jsonb,unit_token='',unit_until=NULL,updated_at=now() WHERE kind=? AND run_id=?",JSON.stringify(result.cursor??null),next,outcome.done,JSON.stringify(outcome),kind,id);
   const state=outcome.done?'complete':'running',processed=result.processed??result.records?.length??0;
   await run('UPDATE '+tableFor(kind)+' SET state=?,imported=imported+?,updated_at=?,message=?,finished_at=?'+(kind==='sync'?',changed=changed+?':'')+' WHERE id=?',state,processed,stamp(),outcome.done?'Import finished':result.message||'Saved progress; continuing automatically',outcome.done?stamp():null,...(kind==='sync'?[changed]:[]),id);
   if(outcome.done){
    if(kind==='sync'){
     if((parent.changed||0)+changed){const contact=await startContactProjection({drain:true});await run('UPDATE contact_runs SET review_requested=true WHERE id=?',contact.id);}
     if(parent.provider==='gmail'){const {clearGmailIssue}=await import('./connectors.mjs');await clearGmailIssue();}
     await run('DELETE FROM import_records WHERE run_id=?',id);await run('DELETE FROM import_uploads WHERE run_id=?',id);
    }else{
     const failures=(await one("SELECT count(*) AS n FROM contact_queue WHERE state='failed'")).n;
     if(failures)await run("UPDATE contact_runs SET state='partial',message=? WHERE id=?",failures+' sources need a retry',id);
     if(latest.review_requested)await queueImportReview();
    }
   }
   return outcome;
  });
 }catch(error){
  if(error.lostUnit)return{revision,done:false,waitMs:2000};
  return transaction(async()=>{
   await lockWorkspace();const current=await one('SELECT * FROM durable_runs WHERE kind=? AND run_id=? FOR UPDATE',kind,id);
   if(!current||current.unit_token!==unit||current.completed)return current?summary(current):{done:true,revision};
   const attempts=current.attempts+1,failed=Boolean(error.permanent)||attempts>=12,next=current.revision+1;
   const waitMs=Math.max(1000,Math.min(86400000,Number(error.retryAfterMs)||Math.min(900000,2000*2**Math.min(attempts,9))));
   const message=failed?(error.permanent&&(error.ingestionProviderError||error.manualImport)?error.message:'Import paused after repeated failures. Retry to resume saved progress.'):'Provider temporarily unavailable; retrying automatically';
   const outcome={revision:next,done:failed,...(!failed?{waitMs}:{failed:true})};
   await run("UPDATE durable_runs SET attempts=?,revision=?,completed=?,outcome=?::jsonb,unit_token='',unit_until=NULL,updated_at=now() WHERE kind=? AND run_id=?",attempts,next,failed,JSON.stringify(outcome),kind,id);
   await run('UPDATE '+tableFor(kind)+' SET state=?,message=?,updated_at=?,finished_at=? WHERE id=?',failed?'failed':'running',message,stamp(),failed?stamp():null,id);
   return outcome;
  });
 }
}
export async function failDurableRun(kind,id,workflowId){
 return transaction(async()=>{await lockWorkspace();const row=await one('SELECT * FROM durable_runs WHERE kind=? AND run_id=? FOR UPDATE',kind,id);if(!row||row.completed||row.workflow_id!==workflowId)return;
  await run('UPDATE durable_runs SET completed=true,outcome=?::jsonb,updated_at=now() WHERE kind=? AND run_id=?',JSON.stringify({done:true,failed:true}),kind,id);
  await run("UPDATE "+tableFor(kind)+" SET state='failed',message='Workflow interrupted after retries; refresh to resume saved progress',updated_at=?,finished_at=? WHERE id=?",stamp(),stamp(),id);
 });
}
