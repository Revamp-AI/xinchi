import {savePriorityEnrichment,stackId} from './priorities.mjs';
import {expireLeases,requireLease,cancelLease} from './leases.mjs';
import {REMOTE_WORKERS} from './runtime.mjs';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {z} from 'zod';
import {assignReviewBatch,completeReviewBatch,releaseFailedReviewBatches} from './review-batches.mjs';
import {all,one,run,uid,stamp,hash,root,transaction,lockWorkspace,upsertSource,getSetting,setSetting} from './db.mjs';
const ContactDraft=z.object({contact_id:z.string(),subject:z.string().max(300),body:z.string().min(1).max(12000),citations:z.array(z.object({source_id:z.string(),source_version_id:z.string().default(''),quote:z.string().min(8).max(1500)}).strict()).min(1)}).strict();
const Citation=z.object({source_id:z.string(),source_version_id:z.string().default(''),quote:z.string().min(8).max(1500)}).strict();
const PriorityUpdate=z.object({priority_id:z.string().min(1),summary:z.string().min(1).max(1200),next_decision:z.string().max(1000),suggested_rank:z.number().int().min(1).max(1000).nullable(),reason:z.string().max(1000),citations:z.array(Citation).min(1).max(6)}).strict();
const PrioritySuggestion=z.object({stack_id:stackId,title:z.string().trim().min(1).max(200),summary:z.string().min(1).max(1200),next_decision:z.string().max(1000),citations:z.array(Citation).min(1).max(6)}).strict();
export const AgentResult=z.object({brief:z.string().min(1),findings:z.array(z.object({text:z.string(),citations:z.array(Citation).min(1)}).strict()).max(8),proposals:z.array(z.object({title:z.string(),kind:z.enum(['action','decision']),rationale:z.string(),done_when:z.string(),next_action:z.string(),existing_item_id:z.string(),uncertainty:z.string(),confidence:z.enum(['high','medium','low']),contact_ids:z.array(z.string()).max(20).default([]),citations:z.array(Citation).min(1)}).strict()).max(5),priority_updates:z.array(PriorityUpdate).max(6).default([]),priority_suggestions:z.array(PrioritySuggestion).max(3).default([]),drafts:z.array(ContactDraft).max(3).default([]),questions:z.array(z.string()).max(5),coverage_note:z.string()}).strict();
export const schema=z.toJSONSchema(AgentResult);
export async function validateResult(value){const result=AgentResult.parse(value);
 for(const item of [...result.findings,...result.proposals,...result.drafts,...result.priority_updates,...result.priority_suggestions])for(const c of item.citations){
 const s=await one('SELECT body,content_hash FROM sources WHERE id=?',c.source_id);
 const version=c.source_version_id?await one('SELECT * FROM source_versions WHERE id=? AND source_id=?',c.source_version_id,c.source_id):s?await one('SELECT * FROM source_versions WHERE source_id=? AND content_hash=?',c.source_id,s.content_hash):null;
 const body=version?.normalized_body??(version?.content_hash===s?.content_hash?s?.body:null);
 if(!body||!body.includes(c.quote))throw Error('The agent returned an unverified source excerpt. Nothing was accepted. Run it again.');
 c.source_version_id=version.id;
 }
 for(const p of result.proposals)if(p.existing_item_id&&!(await one('SELECT id FROM items WHERE id=?',p.existing_item_id)))throw Error('The agent referred to an unknown commitment.');
 for(const p of result.proposals)for(const id of p.contact_ids)if(!await one('SELECT id FROM contacts WHERE id=? AND merged_into IS NULL AND archived=false',id))throw Error('The agent referred to an unknown contact.');
 for(const d of result.drafts)if(!await one('SELECT id FROM contacts WHERE id=? AND merged_into IS NULL AND archived=false AND do_not_contact=false',d.contact_id))throw Error('This contact is unavailable for drafting.');
 for(const p of result.priority_updates)if(!await one('SELECT id FROM priorities WHERE id=?',p.priority_id))throw Error('The agent referred to an unknown priority.');
 const meta=new Map();for(const item of [...result.findings,...result.proposals,...result.drafts,...result.priority_updates,...result.priority_suggestions])item.citations=await Promise.all(item.citations.map(async c=>{if(!meta.has(c.source_id))meta.set(c.source_id,(await one('SELECT title,provider,occurred_at FROM sources WHERE id=?',c.source_id)));return{...c,...meta.get(c.source_id)};}));
 return result;
}
export async function saveResult(id,value,leaseToken){let result;await transaction(async()=>{
 await lockWorkspace();
 result=await validateResult(value);
 if(leaseToken)await requireLease('jobs',id,leaseToken);
 else if(!await one("SELECT id FROM jobs WHERE id=? AND status IN ('queued','running') FOR UPDATE",id))throw Error('This review is no longer running.');
 for(const p of result.proposals){const fingerprint=hash({title:p.title.trim().toLowerCase(),source:p.citations[0].source_id,item:p.existing_item_id});(await run('INSERT OR IGNORE INTO proposals(id,job_id,fingerprint,status,payload,created_at) VALUES(?,?,?,?,?,?)',uid(),id,fingerprint,'pending',JSON.stringify(p),stamp()));}
 for(const d of result.drafts)await run('INSERT INTO message_drafts(id,contact_id,job_id,subject,body,citations) VALUES(?,?,?,?,?,?::jsonb)',uid(),d.contact_id,id,d.subject,d.body,JSON.stringify(d.citations));
 (await run("UPDATE jobs SET status='complete',result_json=?,progress='Review ready',updated_at=? WHERE id=?",JSON.stringify(result),stamp(),id));
 await savePriorityEnrichment(id,result.priority_updates,result.priority_suggestions);
 await completeReviewBatch(id);
 });return result;}
export async function createJob(prompt,kind='review',options={}){
 const answers=(Array.isArray(options.answers)?options.answers:[]).map(a=>({question:String(a?.question||'').trim(),answer:String(a?.answer||'').trim()})).filter(a=>a.answer);
 if(Array.isArray(options.answers)&&options.answers.length&&!answers.length)throw Error('Answer at least one question.');
 let text=String(prompt||'');
 if(answers.length){const parent=(await one('SELECT prompt FROM jobs WHERE id=?',String(options.parent_id||'')));if(!parent)throw Error('The review you are answering is no longer available.');text=['Follow-up to review '+options.parent_id+'.','','My answers to your questions:',...answers.map(a=>'- Q: '+a.question+'\n  A: '+a.answer),'','Original request: '+parent.prompt,'','Continue that review using these answers as verified facts from me. Re-check the sources, update the findings and proposals, and ask only new questions.'].join('\n');}
 if(!text.trim())throw Error('Tell the agent what to look into.');
 const id=(await transaction(async ()=>{
 await lockWorkspace();
 const active=(await one("SELECT id FROM jobs WHERE status IN ('queued','running')"));if(active)throw Error('An agent is already working. Let it finish before starting another review.');
 const id=uid();(await run('INSERT INTO jobs(id,kind,status,prompt,created_at,updated_at,progress) VALUES(?,?,?,?,?,?,?)',id,kind,'queued',text.slice(0,6000),stamp(),stamp(),'Starting the context review'));return id;
 }));
 if(kind==='review')(await upsertSource({provider:'manual',external_id:'agent-request-'+id,title:'Request to Focus · '+new Date().toISOString().slice(0,10),occurred_at:stamp(),body:text,coverage:'note'},{origin:'Request entered through the local app',text}));
 return id;
}
export async function cancelJob(id){
 await cancelLease('jobs',String(id||''),'Review cancelled.');
 await run("UPDATE jobs SET progress='Cancelled' WHERE id=?",id);
 const next=await takePendingImportReview();if(next)launchJob(next);
 return {cancelled:true};
}
export function launchJob(id){if(REMOTE_WORKERS)return id;const child=spawn(process.execPath,[resolve(root,'scripts/worker.mjs'),id],{cwd:root,detached:true,stdio:'ignore',env:{...process.env,XIN_APP_ROOT:root}});child.unref();child.on('error',()=>run("UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=? AND status='queued'",'Could not start the agent process.',stamp(),id).catch(()=>{}));return id;}
export async function addProgress(id,label){(await run('INSERT INTO job_events(job_id,label,created_at) VALUES(?,?,?)',id,label,stamp()));(await run("UPDATE jobs SET progress=?,updated_at=? WHERE id=? AND status IN ('queued','running','complete')",label,stamp(),id));}
export async function recoverJobs(){return expireLeases('jobs');}

export async function takePendingImportReview(){return (await transaction(async ()=>{
 await lockWorkspace();
 if((await one("SELECT id FROM jobs WHERE status IN ('queued','running')")))return null;
 await releaseFailedReviewBatches();
 const pending=await one('SELECT source_id FROM review_queue WHERE completed=false AND job_id IS NULL AND attempts<3 AND (retry_after IS NULL OR retry_after<=now()) LIMIT 1');
 const legacy=await getSetting('pending_import_review');if(!pending&&!legacy)return null;
 const prompt=pending?'Review the source pages assigned by read_import_batch, reconcile them against read_commitments, read_priorities and pending proposals; enrich matching priorities with dated, cited context, and suggest new priorities only for substantive ongoing initiatives, and propose only useful, source-backed decisions. Every assigned page is provided in the cloud prompt or available through read_import_batch. Be explicit about partial transcripts and remaining coverage; do not claim to have reviewed the whole archive. Older obligations require current evidence. Do not ask the user to retrieve IDs or records available through your tools.':legacy;
 const id=uid();await run('INSERT INTO jobs(id,kind,status,prompt,created_at,updated_at,progress) VALUES(?,?,?,?,?,?,?)',id,'import_review','queued',prompt,stamp(),stamp(),'Reviewing imported context');
 await assignReviewBatch(id);await setSetting('pending_import_review',null);return id;
}));}
export async function queueImportReview(){const id=await takePendingImportReview();if(id)await launchJob(id);return id;}
