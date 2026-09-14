import {CONTACT_TABLES} from './contact-tables.mjs';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {MARK_START,MARK_END} from './marks.mjs';
import {all,one,run,transaction,lockWorkspace,db} from './postgres.mjs';
export {all,one,run,transaction,lockWorkspace,db} from './postgres.mjs';
export const root=resolve(/* turbopackIgnore: true */ process.env.XIN_APP_ROOT || process.cwd());
export const dataDir=resolve(/* turbopackIgnore: true */ process.env.XIN_DATA_DIR || resolve(root,'data'));
mkdirSync(dataDir,{recursive:true,mode:0o700});
export const stamp=()=>new Date().toISOString();
export const uid=()=>randomUUID();
export const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
export async function getSetting(k,d=null){const r=await one('SELECT value FROM settings WHERE key=?',k);return r?JSON.parse(r.value):d;}
export async function setSetting(k,v){return (await run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',k,JSON.stringify(v)));}
export async function upsertSource(doc,raw=doc){return (await transaction(async()=>{
 const provider=String(doc.provider||'manual'),external_id=String(doc.external_id||'').trim();
 if(!['fireflies','granola','gmail','manual'].includes(provider)||!external_id||!doc.title)throw Error('A source needs a provider, ID, and title.');
 await one('SELECT pg_advisory_xact_lock(hashtext(?))','source:'+provider+':'+external_id);
 const byUrl=provider==='granola'&&doc.url?await one('SELECT * FROM sources WHERE provider=? AND (url=? OR external_id=?)',provider,doc.url,doc.url.split('/').pop()):null;
 const id=byUrl?.id||provider+':'+external_id, old=await one('SELECT * FROM sources WHERE id=?',id);
 const values={title:String(doc.title),occurred_at:String(doc.occurred_at||''),body:String(doc.body||''),url:/^https?:\/\//.test(doc.url||'')?doc.url:'',coverage:doc.coverage||'metadata'};
 if(values.occurred_at&&!isNaN(Date.parse(values.occurred_at)))values.occurred_at=new Date(values.occurred_at).toISOString();
 const rank={metadata:0,empty:0,summary:1,document:2,'email body':2,transcript:3,'deleted upstream':4};
 if(old&&values.coverage!=='empty'&&(rank[values.coverage]??1)<(rank[old.coverage]??1)){values.body=old.body;values.coverage=old.coverage;}
 const content_hash=hash({values,raw}),date=stamp();
 if(old?.content_hash===content_hash)return{id,changed:false};
 await transaction(async()=>{
 await run(`INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,occurred_at=excluded.occurred_at,body=excluded.body,url=excluded.url,coverage=excluded.coverage,content_hash=excluded.content_hash,updated_at=excluded.updated_at`,id,provider,external_id,values.title,values.occurred_at,values.body,values.url,values.coverage,content_hash,date,date);
 await run('INSERT OR IGNORE INTO source_versions(id,source_id,content_hash,raw_json,fetched_at,normalized_body) VALUES(?,?,?,?,?,?)',uid(),id,content_hash,JSON.stringify(raw),date,values.body);

 if(provider==='manual'||Date.parse(values.occurred_at)>=Date.now()-90*86400000||await one('SELECT id FROM interactions WHERE source_id=?',id))await run("INSERT INTO contact_queue(source_id,content_hash) VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET content_hash=excluded.content_hash,state='pending',attempts=0,error='',updated_at=now()",id,content_hash);
 });return{id,changed:true};
}));}
export async function searchSources(q='',provider='',offset=0){
 const tokens=String(q).match(/[\p{L}\p{N}_]+/gu)||[],args=[],where=[];
 if(provider){where.push('s.provider=?');args.push(provider);}
 const query=tokens.join(' ');
 if(tokens.length){where.push("to_tsvector('simple',s.title || ' ' || s.body) @@ plainto_tsquery('simple',?)");args.push(query);}
 const clause=where.length?' WHERE '+where.join(' AND '):'';
 const total=(await one('SELECT count(*) AS n FROM sources s'+clause,...args)).n;
 const order=tokens.length?"ts_rank(to_tsvector('simple',s.title || ' ' || s.body),plainto_tsquery('simple',?)) DESC,s.occurred_at DESC,s.id":'s.occurred_at DESC,s.id';
 const rows=await all('SELECT s.id,s.provider,s.title,s.occurred_at,s.coverage,s.body FROM sources s'+clause+' ORDER BY '+order+' LIMIT 40 OFFSET ?',...args,...(tokens.length?[query]:[]),Math.max(0,Number(offset)||0));
 return{total,records:rows.map(({body,...row})=>({...row,excerpt:sourceExcerpt(body,tokens)}))};
}
// Contiguous excerpts retain source characters exactly; only explicit display markers are added.
export function sourceExcerpt(body,tokens){
 if(!tokens.length)return body.slice(0,250);
 const escaped=tokens.map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
 const expression=new RegExp('(?<![\\p{L}\\p{N}_])('+escaped.join('|')+')(?![\\p{L}\\p{N}_])','giu');
 const matches=[...body.matchAll(expression)];if(!matches.length)return body.slice(0,250);
 const start=body.length<=180?0:Math.max(0,body.lastIndexOf(' ',Math.max(0,matches[0].index-45))+1);
 const end=body.length<=180?body.length:Math.min(body.length,start+180);
 return(start?'…':'')+body.slice(start,end).replace(expression,MARK_START+'$1'+MARK_END)+(end<body.length?'…':'');
}
export async function readSource(id,offset=0,limit=14000){
 const s=await one('SELECT * FROM sources WHERE id=?',id);if(!s)throw Error('Source not found.');
 return{...s,body:s.body.slice(offset,offset+limit),total_characters:s.body.length,offset,next_offset:offset+limit<s.body.length?offset+limit:null};
}
export async function readSourceVersion(id){const v=await one('SELECT v.*,s.provider,s.title,s.occurred_at,s.coverage,s.url FROM source_versions v JOIN sources s ON s.id=v.source_id WHERE v.id=?',id);if(!v)throw Error('Source snapshot not found.');return{id:v.source_id,source_version_id:v.id,provider:v.provider,title:v.title+' · archived snapshot',occurred_at:v.occurred_at,coverage:v.coverage,url:v.url,body:v.normalized_body??v.raw_json,total_characters:(v.normalized_body??v.raw_json).length,offset:0,next_offset:null};}
const fields=['title','kind','status','done_when','next_action','owner','checkpoint','hard_deadline','dependency','last_action','fallback','evidence','reason','source_id','source_version_id','source_quote','shared'];
export function dateOK(v){return /^\d{4}-\d{2}-\d{2}$/.test(v)&&!isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;}
async function event(id,action,before,after,reason=''){(await run('INSERT INTO events VALUES(?,?,?,?,?,?,?)',uid(),id,action,before?JSON.stringify(before):null,JSON.stringify(after),reason,stamp()));}
export async function saveItem(input){return (await transaction(async()=>{
 await lockWorkspace();
 if(input.proposal_id&&!(await one("SELECT id FROM proposals WHERE id=? AND status='pending'",input.proposal_id)))throw Error('This proposal was already resolved.');
 const before=input.id?(await one('SELECT * FROM items WHERE id=?',input.id)):null;
 if(input.id&&!before)throw Error('Item not found.');
 if(before&&before.version!==input.version)throw Error('This item changed. Reopen it before saving.');
 const row=before?{...before}:{id:uid(),title:'',kind:'action',status:'candidate',done_when:'',next_action:'',owner:'You',checkpoint:'',hard_deadline:'',original_checkpoint:'',dependency:'',last_action:'',fallback:'',evidence:'',reason:'',source_id:null,source_version_id:null,source_quote:'',shared:0,created_at:stamp(),updated_at:stamp(),version:0};
 for(const k of fields)if(k in input)row[k]=k==='shared'?Number(Boolean(input[k])):['source_id','source_version_id'].includes(k)?(input[k]||null):String(input[k]||'').trim();
 if(!row.title)throw Error('Name the output or decision.');
 if(!['action','decision'].includes(row.kind)||!['candidate','now','waiting','later','done','dropped'].includes(row.status))throw Error('Choose a valid kind and status.');
 for(const k of ['checkpoint','hard_deadline'])if(row[k]&&!dateOK(row[k]))throw Error('Choose a valid date.');
 if(row.source_id){const s=await one('SELECT body,content_hash FROM sources WHERE id=?',row.source_id);if(!s)throw Error('Source not found.');const v=row.source_version_id?await one('SELECT * FROM source_versions WHERE id=? AND source_id=?',row.source_version_id,row.source_id):await one('SELECT * FROM source_versions WHERE source_id=? AND content_hash=?',row.source_id,s.content_hash);const body=v?.normalized_body??(v?.content_hash===s.content_hash?s.body:null);if(row.source_quote&&(!body||!body.includes(row.source_quote)))throw Error('The excerpt must match the source text.');if(row.source_quote)row.source_version_id=v.id;}else row.source_version_id=null;
 if(row.status==='now'){
  for(const k of ['done_when','next_action','owner','checkpoint'])if(!row[k])throw Error('Accepting needs a defined output, next action, owner, and checkpoint.');
  if((await one("SELECT count(*) AS n FROM items WHERE status='now' AND id<>?",row.id)).n>=3){
   const r=(await one("SELECT * FROM items WHERE id=? AND status='now' AND id<>?",input.replace_id||'',row.id));
   if(!r||!input.tradeoff_reason||!dateOK(input.replace_checkpoint||''))throw Error('Three outcomes are active. Choose what this replaces, why, and when to reconsider it.');
   const a={...r,status:'later',reason:input.tradeoff_reason,checkpoint:input.replace_checkpoint,updated_at:stamp(),version:r.version+1};
   (await run('UPDATE items SET status=?,reason=?,checkpoint=?,updated_at=?,version=? WHERE id=?',a.status,a.reason,a.checkpoint,a.updated_at,a.version,r.id));(await event(r.id,'displaced',r,a,a.reason));
  }
  if(!row.original_checkpoint)row.original_checkpoint=row.checkpoint;
 }
 if(row.status==='waiting'&&(!row.dependency||!row.checkpoint))throw Error('Waiting needs a person or dependency and a check-back date.');
 if(row.status==='later'&&(!row.reason||!row.checkpoint))throw Error('Later needs a reason and a review date.');
 if(row.status==='dropped'&&!row.reason)throw Error('Record why you are closing this.');
 if(row.status==='done'&&!row.evidence)throw Error('Add the finished output or decision as evidence.');
 if(before?.original_checkpoint&&(row.checkpoint!==before.checkpoint||row.status!==before.status&&!['now','done'].includes(row.status))&&!row.reason)throw Error('Record why this commitment changed.');
 row.updated_at=stamp();row.version++;
 const cols=Object.keys(row);(await run(`INSERT INTO items (${cols}) VALUES (${cols.map(()=>'?')}) ON CONFLICT(id) DO UPDATE SET ${cols.filter(k=>k!=='id').map(k=>`${k}=excluded.${k}`)}`,...cols.map(k=>row[k])));
 if(input.contact_ids!==undefined){if(!Array.isArray(input.contact_ids)||input.contact_ids.length>20)throw Error('Choose up to 20 related contacts.');const ids=[...new Set(input.contact_ids)];for(const id of ids)if(!await one('SELECT id FROM contacts WHERE id=? AND merged_into IS NULL',id))throw Error('Related contact not found.');await run('DELETE FROM item_contacts WHERE item_id=?',row.id);for(const id of ids)await run('INSERT INTO item_contacts VALUES(?,?)',row.id,id);}
 (await event(row.id,before?'updated':'created',before,row,row.reason));
 if(input.proposal_id)(await run("UPDATE proposals SET status='accepted',item_id=? WHERE id=?",row.id,input.proposal_id));
 return row;
 }));}
export async function dashboard(){
 const [items,coverage,jobs,proposals,sync,sync_history,carryovers,focus,available_hours]=await Promise.all([
 (await all('SELECT * FROM items ORDER BY created_at,id')),(await all('SELECT provider,coverage,count(*) AS count FROM sources GROUP BY provider,coverage')),
 (await all('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 15')),(await all("SELECT * FROM proposals WHERE status='pending' ORDER BY created_at DESC")),
 (await all('SELECT * FROM (SELECT DISTINCT ON (provider) * FROM sync_runs ORDER BY provider,started_at DESC,id DESC) latest ORDER BY started_at DESC,id DESC')),(await all('SELECT * FROM sync_runs ORDER BY started_at DESC,id DESC LIMIT 30')),
 (await all("SELECT item_id,count(*) AS n FROM events WHERE action='updated' AND (before_json::jsonb->>'checkpoint')<>'' AND (before_json::jsonb->>'checkpoint')<>(after_json::jsonb->>'checkpoint') AND (after_json::jsonb->>'status')='now' GROUP BY item_id")),(await getSetting('focus','')),(await getSetting('available_hours',0))]);
 return{items,coverage,jobs:jobs.map(x=>({...x,result:x.result_json?JSON.parse(x.result_json):null})),proposals:proposals.map(x=>({...x,payload:JSON.parse(x.payload)})),sync,sync_history,carryovers,focus,available_hours,storage:'postgres'};
}
export const exportTables=['sources','source_versions','items','events','settings','jobs','proposals','job_events','sync_runs',...CONTACT_TABLES];
export async function exportData(){return transaction(async()=>{await run('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');const data={schema_version:3,exported_at:stamp()};for(const t of exportTables)data[t]=await all('SELECT * FROM '+t);return data;});}
