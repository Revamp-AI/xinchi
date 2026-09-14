import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {all,one,run,uid,stamp,hash,root,transaction,upsertSource,getSetting,setSetting} from './db.mjs';
const Citation=z.object({source_id:z.string(),quote:z.string().min(8).max(1500)}).strict();
export const AgentResult=z.object({brief:z.string().min(1),findings:z.array(z.object({text:z.string(),citations:z.array(Citation).min(1)}).strict()).max(8),proposals:z.array(z.object({title:z.string(),kind:z.enum(['action','decision']),rationale:z.string(),done_when:z.string(),next_action:z.string(),existing_item_id:z.string(),uncertainty:z.string(),confidence:z.enum(['high','medium','low']),citations:z.array(Citation).min(1)}).strict()).max(5),questions:z.array(z.string()).max(5),coverage_note:z.string()}).strict();
export const schema=z.toJSONSchema(AgentResult);
export function validateResult(value){const result=AgentResult.parse(value);
 for(const item of [...result.findings,...result.proposals])for(const c of item.citations){const s=one('SELECT body FROM sources WHERE id=?',c.source_id);if(!s||!s.body.includes(c.quote))throw Error('The agent returned an unverified source excerpt. Nothing was accepted. Run it again.');}
 for(const p of result.proposals)if(p.existing_item_id&&!one('SELECT id FROM items WHERE id=?',p.existing_item_id))throw Error('The agent referred to an unknown commitment.');
 const meta=new Map();for(const item of [...result.findings,...result.proposals])item.citations=item.citations.map(c=>{if(!meta.has(c.source_id))meta.set(c.source_id,one('SELECT title,provider,occurred_at FROM sources WHERE id=?',c.source_id));return{...c,...meta.get(c.source_id)};});
 return result;
}
export function saveResult(id,value){const result=validateResult(value);transaction(()=>{
 for(const p of result.proposals){const fingerprint=hash({title:p.title.trim().toLowerCase(),source:p.citations[0].source_id,item:p.existing_item_id});run('INSERT OR IGNORE INTO proposals(id,job_id,fingerprint,status,payload,created_at) VALUES(?,?,?,?,?,?)',uid(),id,fingerprint,'pending',JSON.stringify(p),stamp());}
 run("UPDATE jobs SET status='complete',result_json=?,progress='Review ready',updated_at=? WHERE id=?",JSON.stringify(result),stamp(),id);
 });return result;}
export function createJob(prompt,kind='review'){
 if(!String(prompt||'').trim())throw Error('Tell the agent what to look into.');
 const id=transaction(()=>{
 const active=one("SELECT id FROM jobs WHERE status IN ('queued','running')");if(active)throw Error('An agent is already working. Let it finish before starting another review.');
 const id=uid();run('INSERT INTO jobs(id,kind,status,prompt,created_at,updated_at,progress) VALUES(?,?,?,?,?,?,?)',id,kind,'queued',String(prompt).slice(0,6000),stamp(),stamp(),'Starting the context review');return id;
 });
 if(kind==='review')upsertSource({provider:'manual',external_id:'agent-request-'+id,title:'Request to Focus · '+new Date().toISOString().slice(0,10),occurred_at:stamp(),body:String(prompt),coverage:'note'},{origin:'Request entered through the local app',text:String(prompt)});
 return id;
}
export function launchJob(id){const child=spawn(process.execPath,[resolve(root,'scripts/worker.mjs'),id],{cwd:root,detached:true,stdio:'ignore',env:{...process.env,XIN_APP_ROOT:root}});child.unref();child.on('error',()=>run("UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=?",'Could not start the agent process.',stamp(),id));return id;}
export function addProgress(id,label){run('INSERT INTO job_events(job_id,label,created_at) VALUES(?,?,?)',id,label,stamp());run('UPDATE jobs SET progress=?,updated_at=? WHERE id=?',label,stamp(),id);}
export function recoverJobs(){for(const j of all("SELECT * FROM jobs WHERE status IN ('queued','running')")){if(Date.now()-Date.parse(j.updated_at)>10*60*1000)run("UPDATE jobs SET status='failed',error='The previous run was interrupted. Start a new review.',updated_at=? WHERE id=?",stamp(),j.id);}}

export function takePendingImportReview(){return transaction(()=>{
 if(one("SELECT id FROM jobs WHERE status IN ('queued','running')"))return null;
 const prompt=getSetting('pending_import_review');if(!prompt)return null;
 const id=uid();run('INSERT INTO jobs(id,kind,status,prompt,created_at,updated_at,progress) VALUES(?,?,?,?,?,?,?)',id,'import_review','queued',prompt,stamp(),stamp(),'Reviewing imported context');setSetting('pending_import_review',null);return id;
});}
export function queueImportReview(){setSetting('pending_import_review','Review all material added or updated by the recent source imports. Read recent import status and existing commitments first. Reconcile changes, flag missing information, and propose only source-backed next decisions. Do not revive historical obligations without confirmation.');const id=takePendingImportReview();if(id)launchJob(id);return id;}
