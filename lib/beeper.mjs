import {randomBytes} from 'node:crypto';
import {all,one,run,transaction,lockWorkspace,uid,stamp,hash} from './db.mjs';

const owner=()=>String(process.env.XIN_ALLOWED_EMAIL||'').trim().toLowerCase();
const token=()=>randomBytes(32).toString('base64url');
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const string=(value,max=1000)=>typeof value==='string'&&value.length<=max&&value.isWellFormed()&&!value.includes('\0');
const key=value=>string(value)&&value.length>0;
const pairPattern=/^[A-Za-z0-9_-]{43}$/;
const issues={offline:'Open Beeper Desktop on your Mac to continue.',auth:'Reconnect Beeper in the companion on your Mac.',sync:'The companion could not finish this import. Check its status on your Mac.'};

export async function beeperState(){
 const d=await one('SELECT id,label,selection,last_seen,requested,issue FROM focus_auth.beeper_devices WHERE revoked_at IS NULL AND owner_email=? ORDER BY created_at DESC LIMIT 1',owner());
 return d?{configured:true,...d,online:!!d.last_seen&&Date.now()-Date.parse(d.last_seen)<120000,issue:issues[d.issue]||''}:{configured:false};
}
export async function createBeeperPairing(){
 if(!owner())fail('Configure the workspace owner first.');
 const code=token();
 await transaction(async()=>{await lockWorkspace();await run('DELETE FROM focus_auth.beeper_pairings');await run("INSERT INTO focus_auth.beeper_pairings VALUES(?,?,now()+interval '10 minutes')",hash(code),owner());});
 return{code,expires_at:new Date(Date.now()+600000).toISOString()};
}
async function revokeDevices(){
 await run("UPDATE sync_runs SET state='failed',message='Companion disconnected; pair again to start a new import',finished_at=?,updated_at=? WHERE id IN (SELECT u.run_id FROM beeper_uploads u JOIN focus_auth.beeper_devices d ON d.id=u.device_id WHERE d.revoked_at IS NULL) AND state='uploading'",stamp(),stamp());
 await run("DELETE FROM import_records WHERE run_id IN (SELECT u.run_id FROM beeper_uploads u JOIN sync_runs s ON s.id=u.run_id WHERE s.state='failed' AND u.sealed=false)");
 await run('UPDATE focus_auth.beeper_devices SET revoked_at=now(),requested=false WHERE revoked_at IS NULL');
}
export async function revokeBeeper(){return transaction(async()=>{await lockWorkspace();await revokeDevices();await run('DELETE FROM focus_auth.beeper_pairings');return{revoked:true};});}
export async function pairBeeper({code,label,selection}){
 if(!pairPattern.test(code||''))fail('Pairing code is invalid or expired.',401);
 if(!string(label,100)||!label.trim())fail('Give this Mac a name.');
 if(!Array.isArray(selection)||!selection.length)fail('Select at least one direct conversation.');
 const selected=selection.map(c=>{if(!key(c.id)||!key(c.accountID)||!string(c.title,300)||!string(c.network,100))fail('Conversation selection is invalid.');return{id:c.id,accountID:c.accountID,title:c.title,network:c.network};});
 if(new Set(selected.map(c=>JSON.stringify([c.accountID,c.id]))).size!==selected.length)fail('Choose each conversation once.');
 return transaction(async()=>{
  await lockWorkspace();const pairing=await one('DELETE FROM focus_auth.beeper_pairings WHERE token_hash=? AND expires_at>now() AND owner_email=? RETURNING owner_email',hash(code),owner());
  if(!pairing)fail('Pairing code is invalid or expired. Generate another code in Focus.',401);
  await revokeDevices();const id=uid(),secret=token();
  await run('INSERT INTO focus_auth.beeper_devices(id,token_hash,owner_email,label,selection,last_seen) VALUES(?,?,?,?,?::jsonb,now())',id,hash(secret),owner(),label.trim(),JSON.stringify(selected));
  return{id,token:secret};
 });
}
// Device credentials are accepted only by the dedicated ingestion routes. They
// never establish a browser session or grant archive/review/send-message access.
export async function requireBeeperDevice(req){
 const value=(req.headers.get('authorization')||'').match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
 const d=value&&await one('SELECT id FROM focus_auth.beeper_devices WHERE token_hash=? AND revoked_at IS NULL AND owner_email=?',hash(value),owner());
 if(!d)fail('Companion access expired or was revoked. Pair again in Focus.',401);return d.id;
}
async function deviceFor(id){const d=await one('SELECT * FROM focus_auth.beeper_devices WHERE id=? AND revoked_at IS NULL AND owner_email=? FOR UPDATE',id,owner());if(!d)fail('Companion access was revoked.',401);return d;}
export async function requestBeeperSync(){return transaction(async()=>{await lockWorkspace();const d=await one('SELECT id FROM focus_auth.beeper_devices WHERE revoked_at IS NULL AND owner_email=?',owner());if(!d)fail('Pair your Mac first.');await run('UPDATE focus_auth.beeper_devices SET requested=true WHERE id=?',d.id);return{queued:true};});}
export async function beeperHeartbeat(id,{issue=''}={}){return transaction(async()=>{
 const d=await deviceFor(id);await run('UPDATE focus_auth.beeper_devices SET last_seen=now(),issue=? WHERE id=?',issues[issue]?issue:'',id);
 const active=await one("SELECT s.id,s.state,s.message,s.started_at,u.part_count FROM sync_runs s JOIN beeper_uploads u ON u.run_id=s.id WHERE u.device_id=? ORDER BY s.started_at DESC LIMIT 1",id);
 return{requested:d.requested,active:active||null};
});}
export async function beginBeeperUpload(id,{request_id}){if(!/^[a-f0-9-]{36}$/.test(request_id||''))fail('Invalid import request.');return transaction(async()=>{
 await lockWorkspace();await deviceFor(id);
 const old=await one('SELECT s.id,s.state,s.started_at,u.part_count FROM sync_runs s JOIN beeper_uploads u ON u.run_id=s.id WHERE s.id=? AND u.device_id=?',request_id,id);if(old)return old;
 if(await one("SELECT id FROM sync_runs WHERE provider='beeper' AND state IN ('uploading','queued','running')"))fail('Beeper is still processing the previous import.',409);
 await run("INSERT INTO sync_runs(id,provider,state,started_at,updated_at,message) VALUES(?,'beeper','uploading',?,?,'Receiving selected conversations from your Mac')",request_id,stamp(),stamp());
 await run('INSERT INTO beeper_uploads(run_id,device_id) VALUES(?,?)',request_id,id);
 await run('UPDATE focus_auth.beeper_devices SET requested=false WHERE id=?',id);
 return{id:request_id,state:'uploading',started_at:stamp(),part_count:0};
});}

export function normalizeBeeper({chat,message:m}){
 if(!chat||!m||!key(chat.id)||!key(chat.accountID)||chat.type!=='single'||!key(m.id)||m.chatID!==chat.id||m.accountID!==chat.accountID||!key(m.senderID))fail('Beeper returned an invalid direct message.');
 if(!string(chat.title,300)||!string(chat.network,100)||!string(m.text??'',120000)||!string(m.senderName??'',300)||!string(m.linkedMessageID??'')||!string(m.type??'',30)||typeof m.isSender!=='boolean'||!Number.isFinite(Date.parse(m.timestamp)))fail('Beeper message metadata is incomplete.');
 const participants=chat.participants?.items;
 if(!Array.isArray(participants)||participants.length>100)fail('Beeper participant metadata is incomplete.');
 const people=participants.map(p=>{if(!key(p.id)||!string(p.fullName??'',300)||!string(p.email??'',300))fail('Beeper participant metadata is invalid.');return{id:p.id,fullName:p.fullName||'',email:p.email||'',isSelf:p.isSelf===true,isNetworkBot:p.isNetworkBot===true};});
 const raw={chat:{id:chat.id,accountID:chat.accountID,title:chat.title,network:chat.network,type:'single',participants:{items:people,hasMore:chat.participants.hasMore===true}},message:{id:m.id,accountID:m.accountID,chatID:m.chatID,senderID:m.senderID,senderName:m.senderName||'',timestamp:new Date(m.timestamp).toISOString(),isSender:m.isSender,text:m.text||'',type:m.type||'',isDeleted:m.isDeleted===true,isHidden:m.isHidden===true,linkedMessageID:m.linkedMessageID||''}};
 const deleted=raw.message.isDeleted||raw.message.isHidden,body=deleted?'This message was deleted or hidden upstream. Prior snapshots remain in the archive.':m.text||'[Message content unavailable; attachments are not imported]';
 return{doc:{provider:'beeper',external_id:hash([chat.accountID,chat.id,m.id]),title:(chat.network||'Beeper')+' · '+(chat.title||'Direct conversation'),occurred_at:raw.message.timestamp,url:'',coverage:deleted?'deleted upstream':m.text?'message body':'metadata',body:['From: '+(m.isSender?'You':m.senderName||m.senderID),'Conversation: '+chat.title,'',body].join('\n')},raw};
}
export async function appendBeeperBatch(id,{run_id,part,records}){
 if(!Number.isSafeInteger(part)||part<0||part>20000||!Array.isArray(records)||!records.length||records.length>25)fail('A Beeper batch must contain 1–25 messages.');
 const normalized=records.map(normalizeBeeper),digest=hash(normalized);
 return transaction(async()=>{
  await lockWorkspace();const d=await deviceFor(id),u=await one("SELECT u.*,s.state,s.started_at FROM beeper_uploads u JOIN sync_runs s ON s.id=u.run_id WHERE u.run_id=? AND u.device_id=? FOR UPDATE",run_id,id);
  if(!u)fail('This import is unavailable.');
  if(part===u.part_count-1&&digest===u.last_part_hash)return{part,received:u.record_count};
  if(u.state!=='uploading'||u.sealed||part!==u.part_count)fail('The saved upload position changed.',409);
  if(u.record_count+normalized.length>100000)fail('This import exceeds 100,000 messages. Choose fewer conversations.');
  for(const r of normalized){if(!d.selection.some(c=>c.id===r.raw.chat.id&&c.accountID===r.raw.chat.accountID))fail('This conversation was not selected.',403);const age=Date.parse(u.started_at)-Date.parse(r.doc.occurred_at);if(age>91*86400000||age<-300000)fail('Messages must be within the selected 90-day window.');}
  await run('INSERT INTO import_records(run_id,ordinal,payload) SELECT ?,?+ordinality-1,value FROM jsonb_array_elements(?::jsonb) WITH ORDINALITY AS records(value,ordinality)',run_id,u.record_count,JSON.stringify(normalized));
  await run('UPDATE beeper_uploads SET part_count=part_count+1,record_count=record_count+?,last_part_hash=? WHERE run_id=?',normalized.length,digest,run_id);
  await run('UPDATE sync_runs SET updated_at=?,message=? WHERE id=?',stamp(),(u.record_count+normalized.length)+' messages received; saved on the server',run_id);
  await run("UPDATE focus_auth.beeper_devices SET last_seen=now(),issue='' WHERE id=?",id);
  return{part,received:u.record_count+normalized.length};
 });
}
export async function finishBeeperUpload(id,{run_id,parts}){return transaction(async()=>{
 await lockWorkspace();await deviceFor(id);const u=await one('SELECT * FROM beeper_uploads WHERE run_id=? AND device_id=? FOR UPDATE',run_id,id);
 if(!u||parts!==u.part_count)fail('Upload is incomplete. Resume the companion.');
 if(!u.sealed){await run('UPDATE beeper_uploads SET sealed=true WHERE run_id=?',run_id);await run("UPDATE sync_runs SET state='queued',message='Upload saved; processing conversations',updated_at=? WHERE id=? AND state='uploading'",stamp(),run_id);}
 return{id:run_id,queued:true};
});}
export async function advanceBeeper(id,cursor){
 const u=await one('SELECT record_count,sealed FROM beeper_uploads WHERE run_id=?',id);if(!u?.sealed)throw Error('Beeper upload is not complete.');
 const next=cursor?.next||0;if(next>=u.record_count)return{cursor:{next},records:[],complete:true};
 const r=await one('SELECT payload FROM import_records WHERE run_id=? AND ordinal=?',id,next);if(!r)throw Error('Beeper staging record is missing.');
 return{cursor:{next:next+1},records:[r.payload],complete:next+1===u.record_count,message:`Importing Beeper: ${next+1} of ${u.record_count} messages`};
}
