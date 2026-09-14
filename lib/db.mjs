import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
export const root=resolve(/* turbopackIgnore: true */ process.env.XIN_APP_ROOT || process.cwd());
export const dataDir=resolve(/* turbopackIgnore: true */ process.env.XIN_DATA_DIR || resolve(root,'data'));
mkdirSync(dataDir,{recursive:true,mode:0o700});
export const db=new DatabaseSync(resolve(dataDir,'xin.sqlite3'));
db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,provider TEXT NOT NULL,external_id TEXT NOT NULL,title TEXT NOT NULL,occurred_at TEXT NOT NULL DEFAULT '',body TEXT NOT NULL DEFAULT '',url TEXT NOT NULL DEFAULT '',coverage TEXT NOT NULL,content_hash TEXT NOT NULL,imported_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(provider,external_id));
CREATE VIRTUAL TABLE IF NOT EXISTS source_search USING fts5(id UNINDEXED,title,body,tokenize='unicode61');
CREATE TABLE IF NOT EXISTS source_versions(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id),content_hash TEXT NOT NULL,raw_json TEXT NOT NULL,fetched_at TEXT NOT NULL,UNIQUE(source_id,content_hash));
CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY,title TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'action',status TEXT NOT NULL DEFAULT 'candidate',done_when TEXT NOT NULL DEFAULT '',next_action TEXT NOT NULL DEFAULT '',owner TEXT NOT NULL DEFAULT 'You',checkpoint TEXT NOT NULL DEFAULT '',hard_deadline TEXT NOT NULL DEFAULT '',original_checkpoint TEXT NOT NULL DEFAULT '',dependency TEXT NOT NULL DEFAULT '',evidence TEXT NOT NULL DEFAULT '',reason TEXT NOT NULL DEFAULT '',source_id TEXT REFERENCES sources(id),source_quote TEXT NOT NULL DEFAULT '',shared INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES items(id),action TEXT NOT NULL,before_json TEXT,after_json TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,status TEXT NOT NULL,prompt TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,result_json TEXT,error TEXT NOT NULL DEFAULT '',progress TEXT NOT NULL DEFAULT '',pid INTEGER);
CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id),fingerprint TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'pending',payload TEXT NOT NULL,created_at TEXT NOT NULL,item_id TEXT REFERENCES items(id));
CREATE TABLE IF NOT EXISTS job_events(id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL REFERENCES jobs(id),label TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_runs(id TEXT PRIMARY KEY,provider TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,state TEXT NOT NULL,imported INTEGER NOT NULL DEFAULT 0,message TEXT NOT NULL DEFAULT '');`);
chmodSync(resolve(dataDir,'xin.sqlite3'),0o600);
export const stamp=()=>new Date().toISOString();
export const uid=()=>randomUUID();
export const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
export const all=(sql,...args)=>db.prepare(sql).all(...args);
export const one=(sql,...args)=>db.prepare(sql).get(...args);
export const run=(sql,...args)=>db.prepare(sql).run(...args);
export function transaction(fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}
export const getSetting=(k,d=null)=>{const r=one('SELECT value FROM settings WHERE key=?',k);return r?JSON.parse(r.value):d;};
export const setSetting=(k,v)=>run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',k,JSON.stringify(v));
export function upsertSource(doc,raw=doc){
 const provider=String(doc.provider||'manual'),external_id=String(doc.external_id||'').trim();
 if(!['fireflies','granola','gmail','manual'].includes(provider)||!external_id||!doc.title)throw Error('A source needs a provider, ID, and title.');
 const byUrl=provider==='granola'&&doc.url?one('SELECT * FROM sources WHERE provider=? AND (url=? OR external_id=?)',provider,doc.url,doc.url.split('/').pop()):null;
 const id=byUrl?.id||provider+':'+external_id, old=one('SELECT * FROM sources WHERE id=?',id);
 const values={title:String(doc.title),occurred_at:String(doc.occurred_at||''),body:String(doc.body||''),url:/^https?:\/\//.test(doc.url||'')?doc.url:'',coverage:doc.coverage||'metadata'};
 if(values.occurred_at&&!isNaN(Date.parse(values.occurred_at)))values.occurred_at=new Date(values.occurred_at).toISOString();
 const rank={metadata:0,empty:0,summary:1,document:2,'email body':2,transcript:3,'deleted upstream':4};
 if(old&&values.coverage!=='empty'&&(rank[values.coverage]??1)<(rank[old.coverage]??1)){values.body=old.body;values.coverage=old.coverage;}
 const content_hash=hash({values,raw}),date=stamp();
 if(old?.content_hash===content_hash)return{id,changed:false};
 transaction(()=>{
 run(`INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,occurred_at=excluded.occurred_at,body=excluded.body,url=excluded.url,coverage=excluded.coverage,content_hash=excluded.content_hash,updated_at=excluded.updated_at`,id,provider,external_id,values.title,values.occurred_at,values.body,values.url,values.coverage,content_hash,date,date);
 run('INSERT OR IGNORE INTO source_versions VALUES(?,?,?,?,?)',uid(),id,content_hash,JSON.stringify(raw),date);
 run('DELETE FROM source_search WHERE id=?',id);run('INSERT INTO source_search(id,title,body) VALUES(?,?,?)',id,values.title,values.body);
 });return{id,changed:true};
}
export function searchSources(q='',provider='',offset=0){
 const tokens=q.match(/[\p{L}\p{N}_]+/gu)||[],args=[],where=[];
 if(provider){where.push('s.provider=?');args.push(provider);}
 const join=tokens.length?' JOIN source_search f ON f.id=s.id':'';
 if(tokens.length){where.push('source_search MATCH ?');args.push(tokens.map(t=>'"'+t+'"').join(' AND '));}
 const clause=where.length?' WHERE '+where.join(' AND '):'';
 const excerpt=tokens.length?"snippet(source_search,2,'«','»','…',24)":'substr(s.body,1,250)',order=tokens.length?'bm25(source_search)':'s.occurred_at DESC';
 return{total:one('SELECT count(*) AS n FROM sources s'+join+clause,...args).n,records:all('SELECT s.id,s.provider,s.title,s.occurred_at,s.coverage,'+excerpt+' AS excerpt FROM sources s'+join+clause+' ORDER BY '+order+' LIMIT 40 OFFSET ?',...args,Math.max(0,Number(offset)||0))};
}
export function readSource(id,offset=0,limit=14000){
 const s=one('SELECT * FROM sources WHERE id=?',id);if(!s)throw Error('Source not found.');
 return{...s,body:s.body.slice(offset,offset+limit),total_characters:s.body.length,offset,next_offset:offset+limit<s.body.length?offset+limit:null};
}
const fields=['title','kind','status','done_when','next_action','owner','checkpoint','hard_deadline','dependency','evidence','reason','source_id','source_quote','shared'];
function dateOK(v){return /^\d{4}-\d{2}-\d{2}$/.test(v)&&!isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;}
function event(id,action,before,after,reason=''){run('INSERT INTO events VALUES(?,?,?,?,?,?,?)',uid(),id,action,before?JSON.stringify(before):null,JSON.stringify(after),reason,stamp());}
export function saveItem(input){return transaction(()=>{
 if(input.proposal_id&&!one("SELECT id FROM proposals WHERE id=? AND status='pending'",input.proposal_id))throw Error('This proposal was already resolved.');
 const before=input.id?one('SELECT * FROM items WHERE id=?',input.id):null;
 if(input.id&&!before)throw Error('Item not found.');
 if(before&&before.version!==input.version)throw Error('This item changed. Reopen it before saving.');
 const row=before?{...before}:{id:uid(),title:'',kind:'action',status:'candidate',done_when:'',next_action:'',owner:'You',checkpoint:'',hard_deadline:'',original_checkpoint:'',dependency:'',evidence:'',reason:'',source_id:null,source_quote:'',shared:0,created_at:stamp(),updated_at:stamp(),version:0};
 for(const k of fields)if(k in input)row[k]=k==='shared'?Number(Boolean(input[k])):k==='source_id'?(input[k]||null):String(input[k]||'').trim();
 if(!row.title)throw Error('Name the output or decision.');
 if(!['action','decision'].includes(row.kind)||!['candidate','now','waiting','later','done','dropped'].includes(row.status))throw Error('Choose a valid kind and status.');
 for(const k of ['checkpoint','hard_deadline'])if(row[k]&&!dateOK(row[k]))throw Error('Choose a valid date.');
 if(row.source_id){const s=one('SELECT body FROM sources WHERE id=?',row.source_id);if(!s)throw Error('Source not found.');if(row.source_quote&&!s.body.includes(row.source_quote))throw Error('The excerpt must match the source text.');}
 if(row.status==='now'){
  for(const k of ['done_when','next_action','owner','checkpoint'])if(!row[k])throw Error('Accepting needs a defined output, next action, owner, and checkpoint.');
  if(one("SELECT count(*) AS n FROM items WHERE status='now' AND id<>?",row.id).n>=3){
   const r=one("SELECT * FROM items WHERE id=? AND status='now' AND id<>?",input.replace_id||'',row.id);
   if(!r||!input.tradeoff_reason||!dateOK(input.replace_checkpoint||''))throw Error('Three outcomes are active. Choose what this replaces, why, and when to reconsider it.');
   const a={...r,status:'later',reason:input.tradeoff_reason,checkpoint:input.replace_checkpoint,updated_at:stamp(),version:r.version+1};
   run('UPDATE items SET status=?,reason=?,checkpoint=?,updated_at=?,version=? WHERE id=?',a.status,a.reason,a.checkpoint,a.updated_at,a.version,r.id);event(r.id,'displaced',r,a,a.reason);
  }
  if(!row.original_checkpoint)row.original_checkpoint=row.checkpoint;
 }
 if(row.status==='waiting'&&(!row.dependency||!row.checkpoint))throw Error('Waiting needs a person or dependency and a check-back date.');
 if(row.status==='later'&&(!row.reason||!row.checkpoint))throw Error('Later needs a reason and a review date.');
 if(row.status==='dropped'&&!row.reason)throw Error('Record why you are closing this.');
 if(row.status==='done'&&!row.evidence)throw Error('Add the finished output or decision as evidence.');
 if(before?.original_checkpoint&&(row.checkpoint!==before.checkpoint||row.status!==before.status&&!['now','done'].includes(row.status))&&!row.reason)throw Error('Record why this commitment changed.');
 row.updated_at=stamp();row.version++;
 const cols=Object.keys(row);run(`INSERT INTO items (${cols}) VALUES (${cols.map(()=>'?')}) ON CONFLICT(id) DO UPDATE SET ${cols.filter(k=>k!=='id').map(k=>`${k}=excluded.${k}`)}`,...cols.map(k=>row[k]));
 event(row.id,before?'updated':'created',before,row,row.reason);
 if(input.proposal_id)run("UPDATE proposals SET status='accepted',item_id=? WHERE id=?",row.id,input.proposal_id);
 return row;
 });}
export function dashboard(){return{items:all('SELECT * FROM items ORDER BY created_at'),coverage:all('SELECT provider,coverage,count(*) AS count FROM sources GROUP BY provider,coverage'),jobs:all('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 15').map(x=>({...x,result:x.result_json?JSON.parse(x.result_json):null})),proposals:all("SELECT * FROM proposals WHERE status='pending' ORDER BY created_at DESC").map(x=>({...x,payload:JSON.parse(x.payload)})),sync:all('SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 9'),focus:getSetting('focus',''),available_hours:getSetting('available_hours',0)};}
export function exportData(){return{schema_version:1,exported_at:stamp(),...Object.fromEntries(['sources','source_versions','items','events','settings','jobs','proposals','job_events','sync_runs'].map(t=>[t,all('SELECT * FROM '+t)]))};}
