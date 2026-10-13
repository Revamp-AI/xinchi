import {calendarGranted} from './calendar.ts';
import {secrets} from './secret-store.ts';
import {all,one,run,uid,hash,stamp,dateOK,getSetting,transaction,lockWorkspace} from './db.mjs';
export const SHORTLIST_LIMIT=10;
const open="('pending','deferred')";
const due="(reviewed_at IS NULL OR reviewed_at<now()-interval '1 day') AND (review_attempted_at IS NULL OR review_attempted_at<now()-interval '1 hour')";
export function proposalScore(p,now=Date.now()){
 const q=p.qualification;if(!q)return 0;
 const base={verbal_promise:{customer:700,internal:650,personal:300},written_promise:{customer:600,internal:550,personal:250},direct_request:{customer:500,internal:450,personal:200}};
 const days=q.due_date?(Date.parse(q.due_date)-now)/86400000:Infinity;
 return (base[q.basis]?.[q.area]||0)+(days<=7?40:days<=14?20:0)+(q.deadline_kind==='hard'?10:0);
}
export async function validateQualification(p){
 const q=p.qualification;if(!q)return;
 const c=p.citations.find(c=>c.quote.includes(q.commitment_quote));
 if(!c)throw Error('A commitment needs an exact ownership excerpt in its citations.');
 const source=await one('SELECT s.provider,s.coverage,v.normalized_body body FROM source_versions v JOIN sources s ON s.id=v.source_id WHERE v.id=? AND s.id=?',c.source_version_id,c.source_id);
 if(q.basis==='verbal_promise'){
  const transcript=source?.body?.split(/\n?Transcript\n/).slice(1).join('\nTranscript\n');
  if(!['granola','fireflies'].includes(source?.provider)||!transcript?.includes(q.commitment_quote))throw Error('A verbal promise requires an exact transcript excerpt, not a summary attribution.');
 }
 if(q.basis==='written_promise'&&!['gmail','beeper','manual'].includes(source?.provider))throw Error('A written promise needs a message or owner note.');
 if(q.due_date){
  if(!dateOK(q.due_date)||q.deadline_kind==='none')throw Error('A suggested date needs a valid date and deadline basis.');
  const deadline=p.citations.find(c=>c.source_id===q.deadline_source_id&&c.quote.includes(q.deadline_quote));
  if(q.deadline_quote.length<8||!deadline)throw Error('A suggested deadline needs an exact cited date basis.');
  if(q.deadline_source_id.startsWith('calendar:')){
   const event=await one('SELECT s.content_hash,v.content_hash cited_hash,v.raw_json FROM sources s JOIN source_versions v ON v.source_id=s.id WHERE s.id=? AND v.id=?',q.deadline_source_id,deadline.source_version_id);
   const raw=event?JSON.parse(event.raw_json):null;
   const sync=await getSetting('calendar_last_sync');if(!calendarGranted((await secrets()).calendar_tokens)||!sync?.at||Date.now()-Date.parse(sync.at)>30*60000)throw Error('Calendar checkpoints require a fresh calendar sync.');
   if(!raw||event.content_hash!==event.cited_hash||['cancelled','tentative'].includes(raw.status)||raw.attendees?.some(a=>a.self&&['declined','tentative','needsAction'].includes(a.responseStatus)))throw Error('A calendar checkpoint needs the current, non-cancelled event.');
   const start=raw.start?.dateTime||raw.start?.date;if(!start||q.due_date>start.slice(0,10))throw Error('A preparation checkpoint must precede or match its event date.');
   if(q.deadline_kind!=='checkpoint')throw Error('Calendar attendance alone establishes a preparation checkpoint, not a hard deadline.');
  }
 }else if(q.deadline_kind!=='none'||q.deadline_source_id||q.deadline_quote)throw Error('Deadline evidence requires a date.');
}
export async function proposalEvent(id,action,reason,detail={},jobId=null){await run('INSERT INTO proposal_events(id,proposal_id,job_id,action,reason,detail) VALUES(?,?,?,?,?,?::jsonb)',uid(),id,jobId,action,reason,JSON.stringify(detail));}
export async function rebalanceProposals(){
 const rows=await all(`SELECT * FROM proposals WHERE status IN ${open}`);
 for(const row of rows)row.score=proposalScore(JSON.parse(row.payload));
 rows.sort((a,b)=>b.score-a.score||b.created_at.localeCompare(a.created_at)||a.id.localeCompare(b.id));
 for(const [i,row] of rows.entries()){
  const status=i<SHORTLIST_LIMIT?'pending':'deferred';
  await run('UPDATE proposals SET priority_score=? WHERE id=?',row.score,row.id);
  if(status!==row.status){await run('UPDATE proposals SET status=?,version=version+1 WHERE id=?',status,row.id);await proposalEvent(row.id,status,'shortlist', {from:row.status,to:status});}
 }
}
export async function saveProposals(jobId,proposals,{automatic=false}={}){
 const saved=[];
 for(const p of proposals){
  // Old/manual clients remain compatible; automatic discovery must qualify ownership.
  if(automatic&&!p.qualification)continue;
  const key=p.qualification?.deliverable_key.trim().toLowerCase()||'';
  const fingerprint=hash({title:p.title.trim().toLowerCase(),source:p.citations[0].source_id,item:p.existing_item_id});
  const old=p.existing_proposal_id?await one('SELECT * FROM proposals WHERE id=?',p.existing_proposal_id):await one('SELECT * FROM proposals WHERE fingerprint=? OR (deliverable_key<>? AND deliverable_key=?) OR (?<>\'\' AND payload::jsonb->\'qualification\'->>\'commitment_quote\'=? AND payload::jsonb->\'citations\' @> jsonb_build_array(jsonb_build_object(\'source_id\',?::text))) ORDER BY created_at LIMIT 1',fingerprint,'',key,p.qualification?.commitment_quote||'',p.qualification?.commitment_quote||'',p.citations[0].source_id);
  if(old){
   if(!['pending','deferred'].includes(old.status))continue;
   // Updating an existing suggestion requires the version the reviewer actually read.
   if(p.existing_proposal_id!==old.id||p.proposal_version!==old.version)continue;
   if(key&&await one('SELECT id FROM proposals WHERE deliverable_key=? AND id<>?',key,old.id))continue;
   await run('UPDATE proposals SET payload=?,deliverable_key=?,version=version+1,reviewed_at=now() WHERE id=?',JSON.stringify(p),key||old.deliverable_key,old.id);
   await proposalEvent(old.id,'updated','new_evidence',{before:JSON.parse(old.payload),after:p},jobId);saved.push(p);continue;
  }
  if(p.existing_proposal_id)continue;
  const id=uid();await run('INSERT INTO proposals(id,job_id,fingerprint,status,payload,created_at,deliverable_key,priority_score) VALUES(?,?,?,?,?,?,?,?)',id,jobId,fingerprint,'pending',JSON.stringify(p),stamp(),key,proposalScore(p));
  await proposalEvent(id,'created','source_backed',{qualification:p.qualification},jobId);saved.push(p);
 }
 return saved;
}
export async function reconcileProposals(jobId,reconciliations){
 const applied=[];
 for(const r of reconciliations){
  const before=await one(`SELECT * FROM proposals WHERE id=? AND version=? AND status IN ${open}`,r.proposal_id,r.version);if(!before)continue;
  if(r.reason==='duplicate'&&(!r.related_proposal_id||r.related_proposal_id===r.proposal_id||!await one('SELECT id FROM proposals WHERE id=?',r.related_proposal_id)))throw Error('Duplicate cleanup needs the retained proposal.');
  await run("UPDATE proposals SET status='dismissed',version=version+1,reviewed_at=now() WHERE id=?",r.proposal_id);
  await proposalEvent(r.proposal_id,'dismissed',r.reason,{...r,before:JSON.parse(before.payload)},jobId);applied.push(r);
 }
 return applied;
}
export async function dismissProposal(id){return transaction(async()=>{
 await lockWorkspace();const changed=await run(`UPDATE proposals SET status='dismissed',version=version+1 WHERE id=? AND status IN ${open}`,id);
 if(!changed.changes)throw Error('Proposal not found or already resolved.');
 await proposalEvent(id,'dismissed','user_decision');await rebalanceProposals();return{dismissed:true,id};
});}
export async function restoreProposal(id,version){return transaction(async()=>{
 await lockWorkspace();const changed=await run("UPDATE proposals SET status='pending',version=version+1,reviewed_at=now() WHERE id=? AND version=? AND status='dismissed'",id,version);
 if(!changed.changes)throw Error('This suggestion changed. Reopen it before restoring.');
 await proposalEvent(id,'restored','user_decision');await rebalanceProposals();return{restored:true,id};
});}
export async function readProposals({offset=0,status='open',query=''}={},jobId){
 offset=Math.max(0,Number(offset)||0);const args=[],where=[];
 if(status==='assigned'){where.push('EXISTS(SELECT 1 FROM proposal_review_batches b WHERE b.proposal_id=p.id AND b.job_id=?)');args.push(jobId||'');}
 else if(status==='open')where.push(`p.status IN ${open}`);
 else{where.push('p.status=?');args.push(status);}
 if(query){where.push("to_tsvector('simple',p.payload::jsonb->>'title') @@ plainto_tsquery('simple',?)");args.push(query);}
 const rows=await all('SELECT p.* FROM proposals p WHERE '+where.join(' AND ')+' ORDER BY p.priority_score DESC,p.created_at DESC,p.id LIMIT 11 OFFSET ?',...args,offset);
 return{records:rows.slice(0,10).map(r=>({...r,payload:JSON.parse(r.payload)})),next_offset:rows.length>10?offset+10:null,shortlist_limit:SHORTLIST_LIMIT};
}
export async function assignProposalReview(jobId){
 const rows=await all(`SELECT id,version FROM proposals WHERE status IN ${open} AND ${due} ORDER BY reviewed_at NULLS FIRST,review_attempted_at NULLS FIRST,created_at,id LIMIT 3`);
 for(const row of rows){await run('INSERT INTO proposal_review_batches VALUES(?,?,?)',jobId,row.id,row.version);await run('UPDATE proposals SET review_attempted_at=now() WHERE id=?',row.id);}
 return rows.length;
}
export async function completeProposalReview(jobId,checks=[]){
 for(const check of checks){
  const updated=await run(`UPDATE proposals p SET reviewed_at=now() FROM proposal_review_batches b WHERE b.job_id=? AND b.proposal_id=p.id AND b.version=p.version AND p.id=? AND p.version=? AND p.status IN ${open}`,jobId,check.proposal_id,check.version);
  if(updated.changes)await proposalEvent(check.proposal_id,'reviewed','retained_with_evidence',check,jobId);
 }
}
export async function maintenanceDue(){
 const last=await one("SELECT status,updated_at FROM jobs WHERE kind='backlog_review' ORDER BY created_at DESC LIMIT 1");
 if(last?.status==='failed'&&Date.now()-Date.parse(last.updated_at)<3600000)return false;
 return Boolean(await one(`SELECT id FROM proposals WHERE status IN ${open} AND ${due} LIMIT 1`));
}
export async function readProposalEvidence(id){
 const row=await one('SELECT payload FROM proposals WHERE id=?',id);if(!row)throw Error('Proposal not found.');
 const sources=[];let remaining=18000;
 for(const c of JSON.parse(row.payload).citations.slice(0,6)){
  const s=await one('SELECT s.title,s.provider,s.content_hash current_hash,v.id source_version_id,v.content_hash,v.normalized_body body FROM source_versions v JOIN sources s ON s.id=v.source_id WHERE v.source_id=? AND v.id=?',c.source_id,c.source_version_id);if(!s?.body)continue;
  const index=s.body.indexOf(c.quote);if(index<0)continue;
  const offset=Math.max(0,index-1000),end=Math.min(s.body.length,offset+Math.min(remaining,5000));if(end<=index)break;
  sources.push({source_id:c.source_id,source_version_id:s.source_version_id,title:s.title,provider:s.provider,is_current:s.current_hash===s.content_hash,body:s.body.slice(offset,end),offset,end,total_characters:s.body.length,next_offset:end<s.body.length?end:null});remaining-=end-offset;if(remaining<=0)break;
 }
 return{proposal_id:id,sources,note:'Scoped windows around the cited promise, not the full sources. Search newer evidence and read current snapshots before deciding whether it remains open.'};
}
