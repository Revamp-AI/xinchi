import {z} from 'zod';
import {all,one,run,transaction,lockWorkspace,uid,hash,stamp,upsertSource} from './db.mjs';
export const stackId=z.enum(['deal-flow','product','go-to-market']);
export const priorityFields={stack_id:stackId,title:z.string().trim().min(1).max(200),owner:z.string().trim().min(1).max(200),financials:z.string().max(500),notes:z.string().max(4000),keywords:z.string().max(500),next_decision:z.string().max(1000),commitment_id:z.string().min(1).nullable(),status:z.enum(['active','done'])};
export const priorityInput=z.object({id:z.string().min(1).optional(),version:z.number().int().positive().optional(),...Object.fromEntries(Object.entries(priorityFields).map(([k,v])=>[k,v.optional()]))}).strict();
export async function prioritiesState(){
 const [stacks,items,suggestions,order]=await Promise.all([all('SELECT * FROM priority_stacks ORDER BY position,id'),all("SELECT p.*,COALESCE((SELECT count(*) FROM priority_suggestions s WHERE s.priority_id=p.id AND s.status='pending'),0) suggestion_count FROM priorities p ORDER BY p.position,p.id"),all("SELECT * FROM priority_suggestions WHERE status='pending' ORDER BY created_at DESC LIMIT 100"),one('SELECT version FROM priority_order WHERE id=1')]);
 return{stacks,items,suggestions,order_version:order.version};
}
export async function readPriorities({offset=0}={}){
 const stacks=await all('SELECT * FROM priority_stacks ORDER BY position,id');
 offset=Math.max(0,Number(offset)||0);
 const rows=await all("SELECT p.* FROM priorities p JOIN priority_stacks s ON s.id=p.stack_id WHERE p.status='active' ORDER BY s.position,p.position,p.id LIMIT 21 OFFSET ?",offset);
 const items=[];let size=0;
 for(const row of rows.slice(0,20)){const p={...row,notes:row.notes.slice(0,800),latest_summary:row.latest_summary.slice(0,800)};const n=JSON.stringify(p).length;if(items.length&&size+n>30000)break;items.push(p);size+=n;}
 const pending_suggestions=await all("SELECT priority_id,left(payload->>'title',200) title,left(payload->>'next_decision',500) next_decision,payload->>'suggested_rank' suggested_rank FROM priority_suggestions WHERE status='pending' ORDER BY created_at DESC LIMIT 20");
 return{stacks,items,pending_suggestions,offset,next_offset:rows.length>items.length?offset+items.length:null,rules:'Manual order, owner, financials and next_decision belong to the user. Match real subjects, not generic vocabulary. Enrich relevant priorities with exact source citations. Propose changes separately; do not invent priorities from routine mail.'};
}
export async function priorityDetail(id){
 const item=await one('SELECT * FROM priorities WHERE id=?',id);if(!item)throw Error('Priority not found.');
 return{...item,updates:await all('SELECT * FROM priority_updates WHERE priority_id=? ORDER BY occurred_at DESC,created_at DESC LIMIT 40',id),suggestions:await all("SELECT * FROM priority_suggestions WHERE priority_id=? AND status='pending' ORDER BY created_at DESC",id),commitment:item.commitment_id?await one('SELECT * FROM items WHERE id=?',item.commitment_id):null};
}
export async function queuePriorityContext(id){
 const p=await one('SELECT * FROM priorities WHERE id=?',id);if(!p)throw Error('Priority not found.');if(p.status!=='active')return{queued:0};
 const words=[...new Set((p.title+' '+p.keywords).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)||[])].filter(w=>!['the','and','for','with','priority','update','meeting','review'].includes(w)).slice(0,16);
 const rows=await all(`SELECT s.id,v.id version_id FROM sources s JOIN source_versions v ON v.source_id=s.id AND v.content_hash=s.content_hash WHERE s.body<>'' AND s.external_id NOT LIKE 'agent-request-%' AND s.external_id NOT LIKE 'contact-profile-%' AND s.external_id NOT LIKE 'linkedin-connection-%' AND s.external_id NOT LIKE 'apple-contact-%' AND (s.id=(SELECT source_id FROM items WHERE id=?) OR (s.occurred_at>=? AND s.provider IN ('granola','fireflies','gmail','beeper','manual') AND to_tsvector('simple',s.title||' '||s.body) @@ to_tsquery('simple',?))) ORDER BY s.occurred_at DESC LIMIT 12`,p.commitment_id,new Date(Date.now()-30*86400000).toISOString(),words.length?words.join(' | '):'focusunlikelyemptyquery');
 for(const s of rows)await run(`INSERT INTO review_queue(source_id,source_version_id) VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET source_version_id=CASE WHEN review_queue.job_id IS NULL THEN excluded.source_version_id ELSE review_queue.source_version_id END,revisit=review_queue.job_id IS NOT NULL,updated_at=now(),completed=false,next_offset=CASE WHEN review_queue.job_id IS NULL THEN 0 ELSE review_queue.next_offset END,attempts=CASE WHEN review_queue.job_id IS NULL THEN 0 ELSE review_queue.attempts END,retry_after=NULL`,s.id,s.version_id);
 return{queued:rows.length};
}
export async function savePriority(value){const input=priorityInput.parse(value);return transaction(async()=>{
 await lockWorkspace();const old=input.id?await one('SELECT * FROM priorities WHERE id=? FOR UPDATE',input.id):null;
 if(input.id&&!old)throw Error('Priority not found.');if(old&&old.version!==input.version)throw Error('This priority changed. Reopen it before saving.');
 const p={id:uid(),stack_id:'deal-flow',title:'',owner:'You',financials:'',notes:'',keywords:'',next_decision:'',commitment_id:null,status:'active',...old,...input};
 if(!p.title)throw Error('Give this priority a title.');if(p.commitment_id&&!await one('SELECT id FROM items WHERE id=?',p.commitment_id))throw Error('Commitment not found.');
 const position=old&&old.stack_id===p.stack_id&&!(old.status==='done'&&p.status==='active')?old.position:(await one('SELECT COALESCE(max(position),-1)+1 n FROM priorities WHERE stack_id=?',p.stack_id)).n;
 if(old)await run('UPDATE priorities SET stack_id=?,title=?,owner=?,financials=?,notes=?,keywords=?,next_decision=?,commitment_id=?,status=?,position=?,version=version+1,updated_at=now() WHERE id=?',p.stack_id,p.title,p.owner,p.financials,p.notes,p.keywords,p.next_decision,p.commitment_id,p.status,position,p.id);
 else await run('INSERT INTO priorities(id,stack_id,title,owner,financials,notes,keywords,next_decision,commitment_id,status,position) VALUES(?,?,?,?,?,?,?,?,?,?,?)',p.id,p.stack_id,p.title,p.owner,p.financials,p.notes,p.keywords,p.next_decision,p.commitment_id,p.status,position);
 if(!old||old.stack_id!==p.stack_id||old.status!==p.status)await run('UPDATE priority_order SET version=version+1 WHERE id=1');
 if(!old||old.title!==p.title||old.keywords!==p.keywords||old.commitment_id!==p.commitment_id||old.status!==p.status)await queuePriorityContext(p.id);
 return priorityDetail(p.id);
});}
export async function reorderPriorities(value){const input=z.object({version:z.number().int().positive(),stack_id:stackId.optional(),ids:z.array(z.string()).max(1000)}).parse(value);return transaction(async()=>{
 await lockWorkspace();if((await one('SELECT version FROM priority_order WHERE id=1 FOR UPDATE')).version!==input.version)throw Error('The order changed. Refresh and try again.');
 const current=input.stack_id?await all("SELECT id FROM priorities WHERE stack_id=? AND status='active'",input.stack_id):await all('SELECT id FROM priority_stacks');
 if(new Set(input.ids).size!==current.length||input.ids.length!==current.length||current.some(p=>!input.ids.includes(p.id)))throw Error('Include every current item exactly once.');
 for(const [position,id]of input.ids.entries())await run(input.stack_id?'UPDATE priorities SET position=?,version=version+1,updated_at=now() WHERE id=?':'UPDATE priority_stacks SET position=? WHERE id=?',position,id);
 await run('UPDATE priority_order SET version=version+1 WHERE id=1');return prioritiesState();
});}
export async function addPriorityUpdate({id,body}){body=z.string().trim().min(1).max(4000).parse(body);return transaction(async()=>{
 await lockWorkspace();await priorityDetail(id);const updateId=uid(),time=stamp();
 const source=await upsertSource({provider:'manual',external_id:'priority-update-'+updateId,title:'Priority update: '+(await one('SELECT title FROM priorities WHERE id=?',id)).title,body,occurred_at:time,coverage:'note'},{priority_id:id,origin:'User update',body});
 const version=await one('SELECT id FROM source_versions WHERE source_id=? ORDER BY fetched_at DESC LIMIT 1',source.id);
 const citations=[{source_id:source.id,source_version_id:version.id,quote:body.slice(0,1000)}];
 await run("INSERT INTO priority_updates(id,priority_id,body,origin,citations,fingerprint,occurred_at) VALUES(?,?,?,'user',?::jsonb,?,?)",updateId,id,body,JSON.stringify(citations),updateId,time);
 await run('UPDATE priorities SET latest_summary=?,last_context_at=?,updated_at=now() WHERE id=?',body,time,id);return priorityDetail(id);
});}
export async function savePriorityEnrichment(jobId,updates=[],suggestions=[]){
 for(const update of updates){
  const p=await one("SELECT * FROM priorities WHERE id=? AND status='active'",update.priority_id);if(!p)continue;
  const dated=await all('SELECT occurred_at FROM sources WHERE id=ANY(?::text[])',update.citations.map(c=>c.source_id));
  const time=dated.map(d=>d.occurred_at).filter(d=>Number.isFinite(Date.parse(d))).map(d=>new Date(d).toISOString()).sort().at(-1)||'';
  const fingerprint=hash({priority:p.id,versions:[...new Set(update.citations.map(c=>c.source_version_id))].sort(),quotes:update.citations.map(c=>c.quote).sort()});
  const inserted=await run("INSERT INTO priority_updates(id,priority_id,body,origin,citations,fingerprint,job_id,occurred_at) VALUES(?,?,?,'context',?::jsonb,?,?,?) ON CONFLICT(fingerprint) DO NOTHING",uid(),p.id,update.summary,JSON.stringify(update.citations),fingerprint,jobId,time);
  if(inserted.changes)await run('UPDATE priorities SET updated_at=now() WHERE id=?',p.id);
  if(inserted.changes&&(!p.latest_summary||(time&&(!p.last_context_at||Date.parse(time)>=Date.parse(p.last_context_at)))))await run('UPDATE priorities SET latest_summary=?,last_context_at=?,updated_at=now() WHERE id=?',update.summary,time,p.id);
  if(update.next_decision&&update.next_decision!==p.next_decision||update.suggested_rank!==null){const payload={...update,base_version:p.version};await run('INSERT INTO priority_suggestions(id,priority_id,job_id,payload,fingerprint) VALUES(?,?,?,?::jsonb,?) ON CONFLICT(fingerprint) DO NOTHING',uid(),p.id,jobId,JSON.stringify(payload),hash({priority:p.id,decision:update.next_decision,rank:update.suggested_rank,version:p.version}));await run('UPDATE priorities SET updated_at=now() WHERE id=?',p.id);}
 }
 for(const suggestion of suggestions){if((await one("SELECT count(*) n FROM priority_suggestions WHERE priority_id IS NULL AND status='pending'")).n>=6)break;if(await one("SELECT id FROM priorities WHERE lower(title)=lower(?) AND status='active'",suggestion.title))continue;await run('INSERT INTO priority_suggestions(id,job_id,payload,fingerprint) VALUES(?,?,?::jsonb,?) ON CONFLICT(fingerprint) DO NOTHING',uid(),jobId,JSON.stringify(suggestion),hash({stack:suggestion.stack_id,title:suggestion.title.toLowerCase()}));}
}
export async function decidePrioritySuggestion({id,action,version}){return transaction(async()=>{
 await lockWorkspace();const s=await one("SELECT * FROM priority_suggestions WHERE id=? AND status='pending' FOR UPDATE",id);if(!s)throw Error('This suggestion was already resolved.');
 if(action==='dismiss'){await run("UPDATE priority_suggestions SET status='dismissed' WHERE id=?",id);if(s.priority_id)await run('UPDATE priorities SET updated_at=now() WHERE id=?',s.priority_id);return{saved:true};}if(action!=='apply')throw Error('Choose apply or dismiss.');
 let p;
 if(s.priority_id){p=await one('SELECT * FROM priorities WHERE id=?',s.priority_id);if(p.status!=='active'||p.version!==version||p.version!==s.payload.base_version)throw Error('This priority changed since the suggestion. Dismiss it or review its context again.');
  if(s.payload.next_decision)p=await savePriority({id:p.id,version:p.version,next_decision:s.payload.next_decision});
  if(s.payload.suggested_rank!==null){const rows=await all("SELECT id FROM priorities WHERE stack_id=? AND status='active' ORDER BY position,id",p.stack_id);const ids=rows.map(r=>r.id).filter(id=>id!==p.id);ids.splice(Math.min(ids.length,Math.max(0,s.payload.suggested_rank-1)),0,p.id);await reorderPriorities({version:(await one('SELECT version FROM priority_order WHERE id=1')).version,stack_id:p.stack_id,ids});}
 }else{if(await one("SELECT id FROM priorities WHERE lower(title)=lower(?) AND status='active'",s.payload.title))throw Error('This priority already exists. Dismiss the suggestion.');p=await savePriority({stack_id:s.payload.stack_id,title:s.payload.title,next_decision:s.payload.next_decision,notes:s.payload.summary});await savePriorityEnrichment(s.job_id,[{priority_id:p.id,summary:s.payload.summary,next_decision:'',suggested_rank:null,citations:s.payload.citations}]);}
 await run("UPDATE priority_suggestions SET status='applied' WHERE id=?",id);return priorityDetail(p.id);
});}
