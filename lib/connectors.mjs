import {readFileSync,writeFileSync,existsSync,renameSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {dataDir,root,stamp,uid,one,run,getSetting,setSetting,upsertSource} from './db.mjs';
const secretPath=resolve(dataDir,'connections.secret.json');
export function secrets(){return existsSync(secretPath)?JSON.parse(readFileSync(secretPath,'utf8')):{};}
export function saveSecrets(value){const tmp=secretPath+'.tmp';writeFileSync(tmp,JSON.stringify(value),{mode:0o600});renameSync(tmp,secretPath);}
export function connectionState(){const s=secrets();return{fireflies:{configured:!!s.fireflies_key},granola:{configured:!!s.granola_key},gmail:{configured:!!s.gmail_tokens?.refresh_token,client_ready:!!s.google_client?.client_id,email:getSetting('gmail_email',''),query:getSetting('gmail_query','-in:spam -in:trash')}};}
export function configure(input){const s=secrets();
 for(const p of ['fireflies','granola'])if(input[p+'_key'])s[p+'_key']=String(input[p+'_key']).trim();

 if(typeof input.gmail_query==='string'){if(input.gmail_query!==getSetting('gmail_query','-in:spam -in:trash')){setSetting('gmail_history',null);setSetting('gmail_page',null);}setSetting('gmail_query',input.gmail_query.trim());}
 saveSecrets(s);return connectionState();
}
export async function request(url,options={},attempt=0){const response=await fetch(url,{...options,signal:AbortSignal.timeout(60000)});if([429,500,502,503,504].includes(response.status)&&attempt<3){await new Promise(r=>setTimeout(r,Math.min(10000,1000*2**attempt)));return request(url,options,attempt+1);}let value;try{value=await response.json();}catch{throw Error('The provider returned an unreadable response.');}if(!response.ok){const e=Error('Provider request failed ('+response.status+'). '+(value.error?.message||value.message||'Check the connection and retry.'));e.status=response.status;throw e;}return value;}
export function googleClient(){return secrets().google_client||null;}
export function configureGoogleClient(input){
 const c=input.web;
 if(!c||typeof c.client_id!=='string'||!c.client_id.endsWith('.apps.googleusercontent.com')||typeof c.client_secret!=='string'||!c.client_secret.trim())throw Error('Upload the downloaded Google OAuth client JSON for a Web application.');
 if(!c.redirect_uris?.includes('http://127.0.0.1:3210/api/auth/google/callback'))throw Error('Add http://127.0.0.1:3210/api/auth/google/callback as an authorized redirect URI, then download the client JSON again.');
 const s=secrets();if(s.google_client?.client_id!==c.client_id)delete s.gmail_tokens;
 s.google_client={client_id:c.client_id,client_secret:c.client_secret};delete s.gmail_oauth;saveSecrets(s);
}
export async function saveGoogleGrant(tokens,identity){
 if(!String(tokens.scope||'').split(' ').includes('https://www.googleapis.com/auth/gmail.readonly'))return connectionState().gmail.configured;
 const profile=await gmailGet('profile',{},tokens.access_token);
 const existing=getSetting('gmail_email');
 if(profile.emailAddress?.toLowerCase()!==identity.email.toLowerCase()||(existing&&existing.toLowerCase()!==profile.emailAddress.toLowerCase()))throw Error('Google identity and stored Gmail account do not match.');
 const s=secrets(),refresh=tokens.refresh_token||s.gmail_tokens?.refresh_token;
 if(!refresh)throw Error('Google did not grant background Gmail access. Try again and allow Gmail access.');
 s.gmail_tokens={access_token:tokens.access_token,refresh_token:refresh,scope:tokens.scope,expires_at:Date.now()+Number(tokens.expires_in||3600)*1000};saveSecrets(s);setSetting('gmail_email',profile.emailAddress);return true;
}
async function gmailToken(){const s=secrets(),t=s.gmail_tokens;if(!t?.refresh_token)throw Error('Connect Gmail first.');if(t.expires_at>Date.now()+60000)return t.access_token;const fresh=await request('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...s.google_client,refresh_token:t.refresh_token,grant_type:'refresh_token'})});s.gmail_tokens={...t,...fresh,expires_at:Date.now()+fresh.expires_in*1000};saveSecrets(s);return fresh.access_token;}
async function gmailGet(path,query={},token){const u=new URL('https://gmail.googleapis.com/gmail/v1/users/me/'+path);for(const[k,v]of Object.entries(query))if(v!==null&&v!==undefined&&v!=='')u.searchParams.set(k,v);return request(u,{headers:{Authorization:'Bearer '+(token||await gmailToken())}});}
function mimeText(payload){const text=[],attachments=[];const walk=p=>{if(p.filename)attachments.push({name:p.filename,mime_type:p.mimeType,size:p.body?.size||0,id:p.body?.attachmentId||''});if(p.body?.data&&!p.filename&&p.mimeType==='text/plain')text.push(Buffer.from(p.body.data,'base64url').toString('utf8'));for(const part of p.parts||[])walk(part);};walk(payload);if(!text.length){const html=[];const visit=p=>{if(p.body?.data&&!p.filename&&p.mimeType==='text/html')html.push(Buffer.from(p.body.data,'base64url').toString('utf8').replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&'));for(const x of p.parts||[])visit(x);};visit(payload);text.push(...html);}return{text:text.join('\n\n'),attachments};}
export function normalizeGmail(m){const headers=Object.fromEntries((m.payload?.headers||[]).map(h=>[h.name.toLowerCase(),h.value]));const parts=mimeText(m.payload||{});return{provider:'gmail',external_id:m.id,title:headers.subject||'(No subject)',occurred_at:new Date(Number(m.internalDate)||Date.now()).toISOString(),url:`https://mail.google.com/mail/u/0/#all/${m.threadId}`,coverage:'email body',body:['From: '+(headers.from||''),'To: '+(headers.to||''),'Date: '+(headers.date||''),'Thread ID: '+m.threadId,'',parts.text,parts.attachments.length?'\nAttachments (content not indexed):\n'+parts.attachments.map(a=>a.name).join('\n'):''].join('\n')};}
export function startSync(provider){if(!['fireflies','granola','gmail'].includes(provider))throw Error('Unknown provider.');if(!connectionState()[provider].configured)throw Error('Set up this connection first.');const active=one("SELECT * FROM sync_runs WHERE state='running'");if(active&&Date.now()-Date.parse(active.started_at)<15*60*1000)throw Error('A source import is already running.');if(active)run("UPDATE sync_runs SET state='failed',message='Interrupted; retry the import' WHERE id=?",active.id);const id=uid();run('INSERT INTO sync_runs(id,provider,started_at,state) VALUES(?,?,?,?)',id,provider,stamp(),'running');const child=spawn(process.execPath,[resolve(root,'scripts/sync-worker.mjs'),id],{cwd:root,detached:true,stdio:'ignore',env:{...process.env,XIN_APP_ROOT:root}});child.unref();return{id};}
export async function syncProvider(provider,onProgress=()=>{}){
 const s=secrets();let changed=0,total=0;
 const put=(doc,raw)=>{if(upsertSource(doc,raw).changed)changed++;total++;onProgress(total);};
 if(provider==='fireflies'){
  if(!s.fireflies_key)throw Error('Add your Fireflies API key.');
  const participant=(process.env.XIN_FIREFLIES_PARTICIPANT_EMAIL||process.env.XIN_ALLOWED_EMAIL||'').trim();
  if(!participant)throw Error('Configure the workspace owner or XIN_FIREFLIES_PARTICIPANT_EMAIL before importing Fireflies.');
  const boundary=stamp();let skip=0;
  for(let page=0;page<200;page++){
   const value=await request('https://api.fireflies.ai/graphql',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+s.fireflies_key},body:JSON.stringify({query:'query($skip:Int,$until:DateTime,$participants:[String]){transcripts(limit:50,skip:$skip,toDate:$until,participants:$participants){id title dateString transcript_url participants sentences{speaker_name text start_time end_time} summary{short_summary action_items overview}}}',variables:{skip,until:boundary,participants:[participant]}})});
   if(value.errors?.length)throw Error(value.errors[0].message);const rows=value.data?.transcripts;if(!Array.isArray(rows))throw Error('Fireflies returned no transcript list.');
   for(const r of rows){const summary=[r.summary?.short_summary,r.summary?.overview,r.summary?.action_items].filter(Boolean).join('\n\n');const transcript=(r.sentences||[]).map(x=>`[${x.start_time}s] ${x.speaker_name||'Unattributed'}: ${x.text}`).join('\n');put({provider,external_id:r.id,title:r.title||'Untitled meeting',occurred_at:r.dateString||'',url:r.transcript_url||'',body:[summary,transcript?'Transcript\n'+transcript:''].filter(Boolean).join('\n\n'),coverage:transcript?'transcript':summary?'summary':'metadata'},r);}
   if(rows.length<50)return{changed,total,complete:true};skip+=rows.length;
  }return{changed,total,complete:false,note:'Reached the per-run safety limit; more history may remain.'};
 }
 if(provider==='granola'){
  if(!s.granola_key)throw Error('Add your Granola Personal API key.');const headers={Authorization:'Bearer '+s.granola_key};let cursor=null;const since=getSetting('granola_since');const started=stamp();
  for(let page=0;page<400;page++){
   const u=new URL('https://public-api.granola.ai/v1/notes');u.searchParams.set('page_size','30');if(cursor)u.searchParams.set('cursor',cursor);if(since)u.searchParams.set('updated_after',since);
   const list=await request(u,{headers});if(!Array.isArray(list.notes))throw Error('Granola returned no notes list.');
   for(const n of list.notes){const note=await request(`https://public-api.granola.ai/v1/notes/${encodeURIComponent(n.id)}`,{headers});let parts=[],tcursor=null;
    for(let p=0;p<500;p++){const tu=new URL(`https://public-api.granola.ai/v1/notes/${encodeURIComponent(n.id)}/transcript`);if(tcursor)tu.searchParams.set('cursor',tcursor);const t=await request(tu,{headers});const entries=t.transcript||t.entries||t.utterances;if(!Array.isArray(entries))throw Error('Granola transcript response was unexpected; the note was not marked complete.');parts.push(...entries);if(!t.hasMore)break;if(!t.cursor)throw Error('Granola omitted its next transcript cursor.');tcursor=t.cursor;if(p===499)throw Error('Transcript exceeds the per-run page limit.');}
    const summary=[note.summary_markdown||note.summary_text,note.private_notes_markdown||note.private_notes_text].filter(Boolean).join('\n\n');const transcript=parts.map(p=>`${p.start_time||''} ${p.speaker?.name||p.speaker?.attribution||'Unattributed'}: ${p.text}`).join('\n');put({provider,external_id:note.id,title:note.title||'Untitled meeting',occurred_at:note.created_at||'',url:note.web_url||'',body:[summary,transcript?'Transcript\n'+transcript:''].filter(Boolean).join('\n\n'),coverage:transcript?'transcript':summary?'summary':'empty'},{...note,transcript:parts});
   }
   if(!list.hasMore){setSetting('granola_since',new Date(Date.parse(started)-60000).toISOString());return{changed,total,complete:true};}if(!list.cursor)throw Error('Granola omitted its next cursor.');cursor=list.cursor;
  }return{changed,total,complete:false};
 }
 if(provider==='gmail'){
  let history=getSetting('gmail_history');const query=getSetting('gmail_query','-in:spam -in:trash');if(query!=='-in:spam -in:trash')history=null;
  const getMessage=async id=>{try{const m=await gmailGet('messages/'+encodeURIComponent(id),{format:'full'});if((m.labelIds||[]).some(l=>['SPAM','TRASH'].includes(l)))return;put(normalizeGmail(m),m);}catch(e){if(e.status!==404)throw e;const old=one('SELECT * FROM sources WHERE id=?','gmail:'+id);if(old)put({...old,coverage:'deleted upstream',body:'This message was deleted upstream. Prior snapshots remain in the archive.'},{deleted:true,id});}};
  if(history){let pageToken=null;const ids=new Set();try{for(let p=0;p<100;p++){const h=await gmailGet('history',{startHistoryId:history,pageToken,maxResults:500});for(const row of h.history||[])for(const m of row.messages||[])ids.add(m.id);if(!h.nextPageToken){for(const id of ids)await getMessage(id);setSetting('gmail_history',h.historyId);return{changed,total,complete:true};}pageToken=h.nextPageToken;}throw Error('Too much history for one run; a full backfill is needed.');}catch(e){if(e.status!==404)throw e;setSetting('gmail_history',null);setSetting('gmail_page',null);}}
  let pending=getSetting('gmail_page');if(!pending){const profile=await gmailGet('profile');pending={pageToken:null,historyId:profile.historyId,query};setSetting('gmail_email',profile.emailAddress);}
  for(let p=0;p<10;p++){const list=await gmailGet('messages',{q:query,maxResults:100,pageToken:pending.pageToken});for(const m of list.messages||[])await getMessage(m.id);if(!list.nextPageToken){setSetting('gmail_history',pending.historyId);setSetting('gmail_page',null);return{changed,total,complete:true};}pending.pageToken=list.nextPageToken;setSetting('gmail_page',pending);}
  return{changed,total,complete:false,note:'Imported up to 1,000 messages. Refresh again to continue the saved backfill.'};
 }
 throw Error('Unsupported provider');
}
