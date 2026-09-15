import {all,one,run,transaction,lockWorkspace,uid,stamp} from './db.mjs';
import {normalizeResearchArchive} from './imports.mjs';

export const MAX_IMPORT_BYTES=64*1024*1024;
export const MAX_IMPORT_CHUNK_BYTES=512*1024;
export const MAX_IMPORT_RECORD_BYTES=20*1024*1024;
export const MAX_IMPORT_RECORDS=5000;
const MAX_PARTS=1024;
const fail=message=>{throw Object.assign(Error(message),{status:400,manualImport:true,permanent:true});};
const validText=value=>typeof value==='string'&&value.isWellFormed()&&!value.includes('\u0000');

async function uploadRun(id){
 if(typeof id!=='string'||!id||id.length>100)fail('Choose a valid file upload.');
 const row=await one("SELECT * FROM sync_runs WHERE id=? AND provider='manual' FOR UPDATE",id);
 const upload=row&&await one('SELECT * FROM import_uploads WHERE run_id=?',id);
 if(!upload)fail('This file upload is no longer available. Choose the file again.');
 return {...row,...upload};
}

export async function createManualUpload({format,title,bytes}){
 if(!['json','text'].includes(format))fail('Choose a JSON or text file.');
 if(!validText(title)||!title.trim()||title.length>512)fail('Choose a file with a name of up to 512 characters.');
 if(!Number.isSafeInteger(bytes)||bytes<1||bytes>MAX_IMPORT_BYTES)fail('Choose a non-empty file of up to 64 MiB.');
 return transaction(async()=>{
  await lockWorkspace();
  if(await one("SELECT id FROM sync_runs WHERE provider='manual' AND state IN ('uploading','queued','running')"))fail('A file import is already active. Wait for it to finish or cancel it.');
  const id=uid(),date=stamp();
  await run("INSERT INTO sync_runs(id,provider,state,started_at,updated_at,message) VALUES(?,'manual','uploading',?,?,'Uploading file')",id,date,date);
  await run('INSERT INTO import_uploads(run_id,format,title,expected_bytes) VALUES(?,?,?,?)',id,format,title,bytes);
  return {id};
 });
}

export async function appendManualChunk({id,part,content}){
 if(!Number.isInteger(part)||part<0||part>=MAX_PARTS)fail('The file upload has an invalid part number.');
 if(!validText(content)||!content.length||Buffer.byteLength(content,'utf8')>MAX_IMPORT_CHUNK_BYTES)fail('File upload parts must contain valid text and be no larger than 512 KiB.');
 return transaction(async()=>{
  const upload=await uploadRun(id);
  if(upload.state!=='uploading')fail('This file upload is already closed.');
  const existing=await one('SELECT content FROM import_chunks WHERE run_id=? AND part=?',id,part);
  if(existing&&existing.content!==content)fail('This file upload part differs from the saved part. Choose the file again.');
  const received=(await one('SELECT coalesce(sum(octet_length(content)),0) AS bytes FROM import_chunks WHERE run_id=?',id)).bytes;
  const total=Number(received)+(existing?0:Buffer.byteLength(content,'utf8'));
  if(total>upload.expected_bytes||total>MAX_IMPORT_BYTES)fail('The uploaded file exceeds its declared size.');
  if(!existing)await run('INSERT INTO import_chunks(run_id,part,content) VALUES(?,?,?)',id,part,content);
  await run('UPDATE sync_runs SET updated_at=?,message=? WHERE id=?',stamp(),`Uploading file: ${Math.floor(total*100/upload.expected_bytes)}%`,id);
  return {id,part,received_bytes:total};
 });
}

export async function finishManualUpload({id,parts}){
 if(!Number.isInteger(parts)||parts<1||parts>MAX_PARTS)fail('The file upload has an invalid part count.');
 return transaction(async()=>{
  const upload=await uploadRun(id);
  if(upload.state!=='uploading')return {id,queued:true};
  const chunks=await all('SELECT part,octet_length(content) AS bytes FROM import_chunks WHERE run_id=? ORDER BY part',id);
  if(chunks.length!==parts||chunks.some((chunk,index)=>chunk.part!==index))fail('The file upload is incomplete. Retry the missing parts.');
  if(chunks.reduce((bytes,chunk)=>bytes+chunk.bytes,0)!==upload.expected_bytes)fail('The uploaded file size does not match. Choose the file again.');
  await run("UPDATE sync_runs SET state='queued',message='File uploaded; import queued',updated_at=? WHERE id=?",stamp(),id);
  return {id,queued:true};
 });
}

export async function cancelManualUpload({id}){
 return transaction(async()=>{
  const row=await one("SELECT state FROM sync_runs WHERE id=? AND provider='manual' FOR UPDATE",id);
  if(row?.state==='uploading'){
   await run("UPDATE sync_runs SET state='failed',message='Upload cancelled; choose the file again',updated_at=?,finished_at=? WHERE id=?",stamp(),stamp(),id);
   await run('DELETE FROM import_uploads WHERE run_id=?',id);
  }
  return {id,cancelled:row?.state==='uploading'};
 });
}

function normalizeRecord({doc,raw}){
 if(!doc||typeof doc!=='object'||Array.isArray(doc))fail('The file contains an invalid source record.');
 const provider=String(doc.provider||'manual'),external_id=String(doc.external_id||'').trim();
 if(!['fireflies','granola','gmail','manual'].includes(provider)||!external_id||!doc.title)fail('Every source record needs a supported provider, ID, and title.');
 const normalized={provider,external_id,title:String(doc.title),occurred_at:String(doc.occurred_at||''),body:String(doc.body||''),url:typeof doc.url==='string'&&/^https?:\/\//.test(doc.url)?doc.url:'',coverage:String(doc.coverage||'metadata')};
 const record={doc:normalized,raw:raw??doc};
 const serialized=JSON.stringify(record);
 if(Buffer.byteLength(serialized,'utf8')>MAX_IMPORT_RECORD_BYTES)fail('Each source record must be no larger than 20 MiB after normalization.');
 // PostgreSQL text/JSONB cannot represent NUL or unpaired Unicode surrogates.
 const visit=value=>{if(typeof value==='string'&&!validText(value))fail('The file contains text that cannot be imported.');if(value&&typeof value==='object')for(const [key,item] of Object.entries(value)){if(!validText(key))fail('The file contains text that cannot be imported.');visit(item);}};
 visit(record);
 return record;
}

export async function prepareManualRecords(id){
 return transaction(async()=>{
  const upload=await uploadRun(id);
  if(!['queued','running'].includes(upload.state))fail('This file is not queued for import.');
  const staged=(await one('SELECT count(*) AS count FROM import_records WHERE run_id=?',id)).count;
  if(staged)return {total:staged};
  const text=(await all('SELECT content FROM import_chunks WHERE run_id=? ORDER BY part',id)).map(chunk=>chunk.content).join('');
  if(Buffer.byteLength(text,'utf8')!==upload.expected_bytes)fail('The saved file is incomplete. Choose the file again.');
  let records;
  try{
   if(upload.format==='text'){
    const doc={provider:'manual',external_id:id,title:upload.title,body:text,coverage:'document',occurred_at:upload.started_at};
    records=[{doc,raw:doc}];
   }else{
    const parsed=JSON.parse(text);
    if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&('fireflies_records' in parsed||'granola_index' in parsed||'tool_responses' in parsed))records=normalizeResearchArchive(parsed);
    else records=(Array.isArray(parsed)?parsed:[parsed]).map(doc=>({doc,raw:doc?.raw??doc}));
   }
   if(records.length>MAX_IMPORT_RECORDS)fail('Import an array of up to 5,000 source records.');
   records=records.map(normalizeRecord);
  }catch(error){if(error.manualImport)throw error;fail('The file is not a valid JSON source archive.');}
  if(records.length)await run('INSERT INTO import_records(run_id,ordinal,payload) SELECT ?,ordinality-1,value FROM jsonb_array_elements(?::jsonb) WITH ORDINALITY AS records(value,ordinality) ON CONFLICT(run_id,ordinal) DO NOTHING',id,JSON.stringify(records));
  return {total:records.length};
 });
}

export async function advanceManual(id,cursor={}){
 cursor ||= {};
 if(cursor.phase!=='records'){
  const {total}=await prepareManualRecords(id);
  return {cursor:{phase:'records',next:0,total},records:[],complete:total===0,message:`File validated: ${total} source records`};
 }
 const {next,total}=cursor;
 if(!Number.isInteger(next)||!Number.isInteger(total)||next<0||next>total||total>MAX_IMPORT_RECORDS)fail('The saved file import position is invalid.');
 if(next===total)return {cursor,records:[],complete:true};
 const record=await one('SELECT payload FROM import_records WHERE run_id=? AND ordinal=?',id,next);
 if(!record)fail('The staged file import is incomplete. Choose the file again.');
 return {cursor:{phase:'records',next:next+1,total},records:[record.payload],complete:next+1===total,message:`Importing file: ${next+1} of ${total} records`};
}
