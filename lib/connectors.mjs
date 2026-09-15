import {expireLeases} from './leases.mjs';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {dataDir,root,stamp,uid,all,one,run,getSetting,setSetting,upsertSource,transaction,lockWorkspace} from './db.mjs';
import {gmailFailureCode,gmailMessages} from './auth-messages.mjs';
import {secrets,saveSecrets,updateSecrets,localSecrets,saveLocalSecrets} from './secret-store.mjs';
import {APP_ORIGIN,HOSTED,POSTGRES_SECRETS,REMOTE_WORKERS} from './runtime.mjs';
import {checkJobBudget} from './job-budget.mjs';
export {secrets,saveSecrets} from './secret-store.mjs';
export async function connectionState(){const s=await secrets();return{fireflies:{configured:!!s.fireflies_key},granola:{configured:!!s.granola_key},gmail:{configured:!!s.gmail_tokens?.refresh_token,client_ready:!!googleClient()?.client_id,email:(await getSetting('gmail_email','')),query:(await getSetting('gmail_query','-in:spam -in:trash')),issue:s.gmail_issue?.code&&gmailMessages[s.gmail_issue.code]?{code:s.gmail_issue.code,message:gmailMessages[s.gmail_issue.code]}:null}};}
export async function configure(input){
 await updateSecrets(s=>{for(const p of ['fireflies','granola'])if(input[p+'_key'])s[p+'_key']=String(input[p+'_key']).trim();});
 if(typeof input.gmail_query==='string'){if(input.gmail_query!==(await getSetting('gmail_query','-in:spam -in:trash'))){(await setSetting('gmail_history',null));(await setSetting('gmail_page',null));}(await setSetting('gmail_query',input.gmail_query.trim()));}
 return connectionState();
}
export async function request(url,options={},attempt=0){
 const {onRetry,...fetchOptions}=options;
 let response;try{response=await fetch(url,{...fetchOptions,signal:AbortSignal.timeout(Math.min(60000,checkJobBudget()))});}catch(error){checkJobBudget();throw error;}
 let value;try{value=await response.json();}catch{value=null;}
 const providerCode=typeof value?.error==='string'?value.error:undefined;
 const details=value?.error?.details||[];
 const providerReason=details.find(d=>d['@type']==='type.googleapis.com/google.rpc.ErrorInfo')?.reason||value?.error?.errors?.[0]?.reason;
 const rateLimited=response.status===429||(response.status===403&&['RATE_LIMIT_EXCEEDED','userRateLimitExceeded','rateLimitExceeded'].includes(providerReason));
 if((rateLimited||[500,502,503,504].includes(response.status))&&attempt<(rateLimited?6:3)){
  const retryAfter=response.headers.get('retry-after');
  const headerMs=retryAfter===null?0:Number.isFinite(Number(retryAfter))?Number(retryAfter)*1000:Date.parse(retryAfter)-Date.now();
  const retryDelay=details.find(d=>d['@type']==='type.googleapis.com/google.rpc.RetryInfo')?.retryDelay;
  const providerMs=typeof retryDelay==='string'&&/^\d+(\.\d+)?s$/.test(retryDelay)?parseFloat(retryDelay)*1000:0;
  const delay=Math.max(Math.min(60000,1000*2**attempt+Math.floor(Math.random()*1000)),Number.isFinite(headerMs)?headerMs:0,providerMs);
  checkJobBudget(delay);await onRetry?.({delay,rateLimited});await new Promise(r=>setTimeout(r,delay));return request(url,options,attempt+1);
 }
 if(!response.ok){const e=Error('Provider request failed ('+response.status+'). '+(value?.error?.message||value?.message||'Check the connection and retry.'));Object.assign(e,{status:response.status,providerCode,providerReason});throw e;}
 if(value===null)throw Error('The provider returned an unreadable response.');return value;
}
export function googleClient(){
 if(process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET)return {client_id:process.env.GOOGLE_CLIENT_ID,client_secret:process.env.GOOGLE_CLIENT_SECRET};
 return HOSTED||POSTGRES_SECRETS?null:localSecrets().google_client||null;
}
export function configureGoogleClient(input){
 if(HOSTED||POSTGRES_SECRETS)throw Object.assign(Error('Configure Google sign-in in the server environment.'),{status:403});
 const c=input.web;
 if(!c||typeof c.client_id!=='string'||!c.client_id.endsWith('.apps.googleusercontent.com')||typeof c.client_secret!=='string'||!c.client_secret.trim())throw Error('Upload the downloaded Google OAuth client JSON for a Web application.');
 if(!c.redirect_uris?.includes(APP_ORIGIN+'/api/auth/google/callback'))throw Error('Add '+APP_ORIGIN+'/api/auth/google/callback as an authorized redirect URI, then download the client JSON again.');
 const s=localSecrets();if(s.google_client?.client_id!==c.client_id)delete s.gmail_tokens;
 s.google_client={client_id:c.client_id,client_secret:c.client_secret};delete s.gmail_oauth;saveLocalSecrets(s);
}
export async function clearGmailIssue(){await updateSecrets(s=>{delete s.gmail_issue;});}
export async function recordGmailIssue(error){const code=gmailFailureCode(error);await updateSecrets(s=>{s.gmail_issue={code,at:stamp()};});return code;}
export async function saveGoogleGrant(tokens,identity){
 if(!String(tokens.scope||'').split(' ').includes('https://www.googleapis.com/auth/gmail.readonly'))return (await connectionState()).gmail.configured;
 const existing=(await getSetting('gmail_email'));
 if(existing&&existing.toLowerCase()!==identity.email.toLowerCase())throw Object.assign(Error('Google identity and stored Gmail account do not match.'),{authCode:'account'});
 const s=await secrets(),refresh=tokens.refresh_token||s.gmail_tokens?.refresh_token;
 if(!refresh)throw Object.assign(Error('Google did not provide background Gmail access.'),{gmailCode:'gmail_refresh'});
 const grant={access_token:tokens.access_token,refresh_token:refresh,scope:tokens.scope,expires_at:Date.now()+Number(tokens.expires_in||3600)*1000};
 let profile;
 try{profile=await gmailGet('profile',{},tokens.access_token);}
 catch(error){
  // Google identity has already been verified. Retain its grant so enabling the
  // Gmail API can be followed by Refresh without repeating account consent.
  await updateSecrets(current=>{current.gmail_tokens=grant;current.gmail_issue={code:gmailFailureCode(error),at:stamp()};});(await setSetting('gmail_email',identity.email));throw error;
 }
 if(profile.emailAddress?.toLowerCase()!==identity.email.toLowerCase())throw Object.assign(Error('Google identity and Gmail account do not match.'),{authCode:'account'});
 await updateSecrets(current=>{current.gmail_tokens=grant;delete current.gmail_issue;});(await setSetting('gmail_email',profile.emailAddress));return true;
}
async function gmailToken(){const s=await secrets(),t=s.gmail_tokens;if(!t?.refresh_token)throw Error('Connect Gmail first.');if(t.expires_at>Date.now()+60000)return t.access_token;const fresh=await request('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...googleClient(),refresh_token:t.refresh_token,grant_type:'refresh_token'})});await updateSecrets(current=>{if(current.gmail_tokens?.refresh_token===t.refresh_token)current.gmail_tokens={...t,...fresh,expires_at:Date.now()+fresh.expires_in*1000};});return fresh.access_token;}
async function gmailGet(path,query={},token,onRetry){const u=new URL('https://gmail.googleapis.com/gmail/v1/users/me/'+path);for(const[k,v]of Object.entries(query))if(v!==null&&v!==undefined&&v!=='')u.searchParams.set(k,v);return request(u,{headers:{Authorization:'Bearer '+(token||await gmailToken())},onRetry});}
function mimeText(payload){const text=[],attachments=[];const walk=p=>{if(p.filename)attachments.push({name:p.filename,mime_type:p.mimeType,size:p.body?.size||0,id:p.body?.attachmentId||''});if(p.body?.data&&!p.filename&&p.mimeType==='text/plain')text.push(Buffer.from(p.body.data,'base64url').toString('utf8'));for(const part of p.parts||[])walk(part);};walk(payload);if(!text.length){const html=[];const visit=p=>{if(p.body?.data&&!p.filename&&p.mimeType==='text/html')html.push(Buffer.from(p.body.data,'base64url').toString('utf8').replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&'));for(const x of p.parts||[])visit(x);};visit(payload);text.push(...html);}return{text:text.join('\n\n'),attachments};}
export function normalizeGmail(m){const headers=Object.fromEntries((m.payload?.headers||[]).map(h=>[h.name.toLowerCase(),h.value]));const parts=mimeText(m.payload||{});return{provider:'gmail',external_id:m.id,title:headers.subject||'(No subject)',occurred_at:new Date(Number(m.internalDate)||Date.now()).toISOString(),url:`https://mail.google.com/mail/u/0/#all/${m.threadId}`,coverage:'email body',body:['From: '+(headers.from||''),'To: '+(headers.to||''),'Date: '+(headers.date||''),'Thread ID: '+m.threadId,'',parts.text,parts.attachments.length?'\nAttachments (content not indexed):\n'+parts.attachments.map(a=>a.name).join('\n'):''].join('\n')};}
export function isProcessAlive(pid){if(!pid)return false;try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}}
export function staleRun(row,nowMs){return row.lease_until?Date.parse(row.lease_until)<nowMs:nowMs-Date.parse(row.updated_at||row.started_at)>120000;}
export async function recoverSyncRuns(){return expireLeases('sync_runs');}
export async function startSync(provider){
 if(!['fireflies','granola','gmail'].includes(provider))throw Error('Unknown provider.');
 if(!(await connectionState())[provider].configured)throw Error('Set up this connection first.');
 const id=await transaction(async()=>{await lockWorkspace();await recoverSyncRuns();
 if(await one("SELECT id FROM sync_runs WHERE state IN ('queued','running','uploading')"))throw Error('A source import is already running.');
 const id=uid();await run('INSERT INTO sync_runs(id,provider,started_at,updated_at,state) VALUES(?,?,?,?,?)',id,provider,stamp(),stamp(),'queued');return id;});
 if(REMOTE_WORKERS)return{id};
 const child=spawn(process.execPath,[resolve(root,'scripts/sync-worker.mjs'),id],{cwd:root,detached:true,stdio:'ignore',env:{...process.env,XIN_APP_ROOT:root}});child.unref();
 child.on('error',()=>run("UPDATE sync_runs SET state='failed',message='Could not start import worker' WHERE id=? AND state='queued'",id).catch(()=>{}));return{id};
}
export async function syncProvider(provider,onProgress=()=>{},onStatus=()=>{},guard=async()=>{}){
 const checkpoint=(key,value)=>transaction(async()=>{await guard();return setSetting(key,value);});
 const s=await secrets();let changed=0,total=0;
 const put=async(doc,raw)=>{checkJobBudget();await transaction(async()=>{await guard();if((await upsertSource(doc,raw)).changed)changed++;});total++;await onProgress(total,changed);};
 if(provider==='fireflies'){
  if(!s.fireflies_key)throw Error('Add your Fireflies API key.');
  const participant=(process.env.XIN_FIREFLIES_PARTICIPANT_EMAIL||process.env.XIN_ALLOWED_EMAIL||'').trim();
  if(!participant)throw Error('Configure the workspace owner or XIN_FIREFLIES_PARTICIPANT_EMAIL before importing Fireflies.');
  const saved=await getSetting('fireflies_page');const pending=saved?.participant===participant?saved:{boundary:stamp(),skip:0,participant};const boundary=pending.boundary;let skip=pending.skip;
  for(let page=0;page<200;page++){
   const value=await request('https://api.fireflies.ai/graphql',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+s.fireflies_key},body:JSON.stringify({query:'query($skip:Int,$until:DateTime,$participants:[String]){transcripts(limit:50,skip:$skip,toDate:$until,participants:$participants){id title dateString transcript_url participants sentences{speaker_name text start_time end_time} summary{short_summary action_items overview}}}',variables:{skip,until:boundary,participants:[participant]}})});
   if(value.errors?.length)throw Error(value.errors[0].message);const rows=value.data?.transcripts;if(!Array.isArray(rows))throw Error('Fireflies returned no transcript list.');
   for(const r of rows){const summary=[r.summary?.short_summary,r.summary?.overview,r.summary?.action_items].filter(Boolean).join('\n\n');const transcript=(r.sentences||[]).map(x=>`[${x.start_time}s] ${x.speaker_name||'Unattributed'}: ${x.text}`).join('\n');(await put({provider,external_id:r.id,title:r.title||'Untitled meeting',occurred_at:r.dateString||'',url:r.transcript_url||'',body:[summary,transcript?'Transcript\n'+transcript:''].filter(Boolean).join('\n\n'),coverage:transcript?'transcript':summary?'summary':'metadata'},r));skip++;await checkpoint('fireflies_page',{boundary,skip,participant});}
   if(rows.length<50){await checkpoint('fireflies_page',null);return{changed,total,complete:true};}
  }return{changed,total,complete:false,note:'Reached the per-run safety limit; more history may remain.'};
 }
 if(provider==='granola'){
  if(!s.granola_key)throw Error('Add your Granola Personal API key.');const headers={Authorization:'Bearer '+s.granola_key};const pending=await getSetting('granola_page');let cursor=pending?.cursor||null;const since=pending?pending.since:(await getSetting('granola_since'));const started=pending?.started||stamp();
  await checkpoint('granola_page',{cursor,since,started});
  for(let page=0;page<400;page++){
   const u=new URL('https://public-api.granola.ai/v1/notes');u.searchParams.set('page_size','30');if(cursor)u.searchParams.set('cursor',cursor);if(since)u.searchParams.set('updated_after',since);
   const list=await request(u,{headers});if(!Array.isArray(list.notes))throw Error('Granola returned no notes list.');
   for(const n of list.notes){const note=await request(`https://public-api.granola.ai/v1/notes/${encodeURIComponent(n.id)}`,{headers});let parts=[],tcursor=null;
    for(let p=0;p<500;p++){const tu=new URL(`https://public-api.granola.ai/v1/notes/${encodeURIComponent(n.id)}/transcript`);if(tcursor)tu.searchParams.set('cursor',tcursor);const t=await request(tu,{headers});const entries=t.transcript||t.entries||t.utterances;if(!Array.isArray(entries))throw Error('Granola transcript response was unexpected; the note was not marked complete.');parts.push(...entries);if(!t.hasMore)break;if(!t.cursor)throw Error('Granola omitted its next transcript cursor.');tcursor=t.cursor;if(p===499)throw Error('Transcript exceeds the per-run page limit.');}
    const summary=[note.summary_markdown||note.summary_text,note.private_notes_markdown||note.private_notes_text].filter(Boolean).join('\n\n');const transcript=parts.map(p=>`${p.start_time||''} ${p.speaker?.name||p.speaker?.attribution||'Unattributed'}: ${p.text}`).join('\n');(await put({provider,external_id:note.id,title:note.title||'Untitled meeting',occurred_at:note.created_at||'',url:note.web_url||'',body:[summary,transcript?'Transcript\n'+transcript:''].filter(Boolean).join('\n\n'),coverage:transcript?'transcript':summary?'summary':'empty'},{...note,transcript:parts}));
   }
   if(!list.hasMore){(await checkpoint('granola_since',new Date(Date.parse(started)-60000).toISOString()));await checkpoint('granola_page',null);return{changed,total,complete:true};}if(!list.cursor)throw Error('Granola omitted its next cursor.');cursor=list.cursor;await checkpoint('granola_page',{cursor,since,started});
  }return{changed,total,complete:false};
 }
 if(provider==='gmail'){
  const readGmail=(path,query={})=>gmailGet(path,query,undefined,({delay,rateLimited})=>onStatus(`${rateLimited?'Gmail rate limit reached':'Gmail temporarily unavailable'}. Retrying in ${Math.ceil(delay/1000)} seconds.`));
  let history=(await getSetting('gmail_history'));const query=(await getSetting('gmail_query','-in:spam -in:trash'));if(query!=='-in:spam -in:trash')history=null;
  const getMessage=async id=>{try{const m=await readGmail('messages/'+encodeURIComponent(id),{format:'full'});if((m.labelIds||[]).some(l=>['SPAM','TRASH'].includes(l)))return;(await put(normalizeGmail(m),m));}catch(e){if(e.status!==404)throw e;const old=(await one('SELECT * FROM sources WHERE id=?','gmail:'+id));if(old)(await put({...old,coverage:'deleted upstream',body:'This message was deleted upstream. Prior snapshots remain in the archive.'},{deleted:true,id}));}};
  if(history){let pageToken=null;const ids=new Set();try{for(let p=0;p<100;p++){const h=await readGmail('history',{startHistoryId:history,pageToken,maxResults:500});for(const row of h.history||[])for(const m of row.messages||[])ids.add(m.id);if(!h.nextPageToken){for(const id of ids)await getMessage(id);(await checkpoint('gmail_history',h.historyId));return{changed,total,complete:true};}pageToken=h.nextPageToken;}throw Error('Too much history for one run; a full backfill is needed.');}catch(e){if(e.status!==404)throw e;(await checkpoint('gmail_history',null));(await checkpoint('gmail_page',null));}}
  let pending=(await getSetting('gmail_page'));if(!pending){const profile=await readGmail('profile');pending={pageToken:null,historyId:profile.historyId,query};(await checkpoint('gmail_email',profile.emailAddress));}
  for(let p=0;p<10;p++){const list=await readGmail('messages',{q:query,maxResults:100,pageToken:pending.pageToken});for(const m of list.messages||[])await getMessage(m.id);if(!list.nextPageToken){(await checkpoint('gmail_history',pending.historyId));(await checkpoint('gmail_page',null));return{changed,total,complete:true};}pending.pageToken=list.nextPageToken;(await checkpoint('gmail_page',pending));}
  return{changed,total,complete:false,note:'Imported up to 1,000 messages. Refresh again to continue the saved backfill.'};
 }
 throw Error('Unsupported provider');
}
