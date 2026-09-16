import {getSetting,one} from './db.mjs';
import {secrets,updateSecrets} from './secret-store.mjs';
import {googleClient,normalizeGmail} from './connectors.mjs';
import {firefliesWindow,firefliesCheckpoint,firefliesCompletedSettings} from './fireflies-sync.mjs';
import {granolaWindow,granolaCheckpoint,granolaCompletedSettings,granolaNotesToFetch} from './granola-sync.mjs';

// These cursors are private database state, not Workflow arguments or step outputs.
// A successful advance has at most one provider request and one complete source.
const MAX_BYTES=8*1024*1024,MAX_IDS=5000,DEFAULT_QUERY='-in:spam -in:trash';
const names={gmail:'Gmail',granola:'Granola',fireflies:'Fireflies'};
const retryReasons=new Set(['RATE_LIMIT_EXCEEDED','RESOURCE_EXHAUSTED','userRateLimitExceeded','rateLimitExceeded','quotaExceeded','dailyLimitExceeded','too_many_requests']);
const safeReasons=new Set([...retryReasons,'SERVICE_DISABLED','accessNotConfigured','insufficientPermissions','forbidden']);
function failure(provider,code,options={}){
 const messages={network:'could not be reached. The import will retry.',rate_limit:'reached a temporary limit. The import will resume automatically.',unavailable:'is temporarily unavailable. The import will retry.',auth:'needs to be reconnected before this import can continue.',request:'rejected the import request. Check the connection settings.',response:'returned an unexpected response. Progress has been preserved.',oversized:'returned a record larger than the 8 MiB import limit. Export a smaller record to continue.',cursor:'returned an invalid or repeated page cursor. Progress has been preserved.',configuration:'is not configured for this workspace.'};
 return Object.assign(Error((names[provider]||'The provider')+' '+(messages[code]||messages.response)),{ingestionProviderError:true,code,permanent:true,retryAfterMs:0,...options});
}
function bounded(value,provider){let json;try{json=JSON.stringify(value);}catch{throw failure(provider,'response');}if(!json||Buffer.byteLength(json)>MAX_BYTES)throw failure(provider,'oversized');return value;}
function token(value,provider){if(value===undefined||value===null||value==='')return null;if(typeof value!=='string'||value.length>16384)throw failure(provider,'cursor');return value;}
function ids(rows,provider,max=MAX_IDS){if(!Array.isArray(rows)||rows.length>max)throw failure(provider,'response');return [...new Set(rows.map(r=>{if(typeof r?.id!=='string'||!r.id||r.id.length>512)throw failure(provider,'response');return r.id;}))];}
function outcome(cursor,records=[],settings={},message){bounded(cursor,cursor.provider);for(const record of records)bounded(record,cursor.provider);return{cursor,records,complete:cursor.phase==='done',settings,...(message?{message}:{} )};}
function providerUrl(base,path,query={}){const url=new URL(base+path);for(const [key,value]of Object.entries(query))if(value!==null&&value!==undefined&&value!=='')url.searchParams.set(key,String(value));return url;}
function retryMs(response,value){
 const header=response.headers.get('retry-after');const headerMs=header===null?0:Number.isFinite(Number(header))?Number(header)*1000:Date.parse(header)-Date.now();
 const details=value?.error?.details||[],delay=details.find?.(d=>d?.['@type']==='type.googleapis.com/google.rpc.RetryInfo')?.retryDelay;
 const googleMs=typeof delay==='string'&&/^\d+(\.\d+)?s$/.test(delay)?parseFloat(delay)*1000:0;
 const firefliesAt=Number(value?.errors?.find(e=>e?.extensions?.metadata?.retryAfter)?.extensions?.metadata?.retryAfter||0);
 return Math.min(7*24*60*60*1000,Math.max(1000,Number.isFinite(headerMs)?headerMs:0,googleMs,Number.isFinite(firefliesAt)?firefliesAt-Date.now():0));
}
async function readJson(response,provider){
 const size=Number(response.headers.get('content-length')||0);if(size>MAX_BYTES){await response.body?.cancel();throw failure(provider,'oversized');}
 if(!response.body)throw failure(provider,'response',{permanent:false,retryAfterMs:1000});
 const reader=response.body.getReader(),chunks=[];let bytes=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>MAX_BYTES){await reader.cancel();throw failure(provider,'oversized');}chunks.push(Buffer.from(value));}}
 finally{reader.releaseLock();}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return null;}
}
async function request(provider,url,options={}){
 let response,value;
 try{response=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(45000)});value=await readJson(response,provider);}
 catch(error){if(error?.ingestionProviderError)throw error;throw failure(provider,'network',{permanent:false,retryAfterMs:1000});}
 const graphError=value?.errors?.[0],status=graphError?Number(graphError.extensions?.status||400):response.status;
 const details=Array.isArray(value?.error?.details)?value.error.details:[];
 const reason=details.find(d=>d?.['@type']==='type.googleapis.com/google.rpc.ErrorInfo')?.reason||value?.error?.errors?.[0]?.reason||graphError?.extensions?.code||graphError?.code;
 if(!response.ok||graphError){
  const providerReason=safeReasons.has(reason)?reason:undefined;
  const rateLimited=status===429||retryReasons.has(reason);
  const transient=rateLimited||status===408||status>=500;
  const code=rateLimited?'rate_limit':transient?'unavailable':[401,403].includes(status)?'auth':'request';
  const grant=typeof value?.error==='string'&&['invalid_grant','invalid_client','unauthorized_client'].includes(value.error)?value.error:undefined;
  throw failure(provider,code,{status,permanent:!transient,retryAfterMs:transient?retryMs(response,value):0,...(providerReason?{providerReason}:{}),...(grant?{providerCode:grant,gmailCode:'gmail_refresh'}:{})});
 }
 if(!value||typeof value!=='object')throw failure(provider,'response',{permanent:false,retryAfterMs:1000});
 return value;
}

export async function initialProviderCursor(provider){
 if(!names[provider])throw failure(provider,'configuration');
 const base={v:1,provider};
 if(provider==='gmail'){
  const query=await getSetting('gmail_query',DEFAULT_QUERY),saved=await getSetting('gmail_page');
  const pending=saved?.query===query&&saved?.historyId?saved:null;
  const history=query===DEFAULT_QUERY?await getSetting('gmail_history'):null;
  return{...base,mode:pending?'full':history?'history':'full',phase:pending||history?'list':'profile',query,historyId:token(pending?.historyId||history,provider),pageToken:token(pending?.pageToken,provider),pendingIds:[],nextPageToken:null};
 }
 if(provider==='granola'){
  const saved=await granolaWindow();
  return{...base,phase:'list',pageToken:token(saved.cursor,provider),since:saved.since,started:saved.started,rescan:Boolean(saved.rescan),pendingIds:[],nextPageToken:null};
 }
 return{...base,phase:'record',...await firefliesWindow()};
}

async function gmailAccess(cursor){
 const stored=await secrets(),grant=stored.gmail_tokens;
 if(!grant?.refresh_token)throw failure('gmail','configuration',{gmailCode:'gmail_refresh'});
 if(grant.access_token&&grant.expires_at>Date.now()+60000)return{access:grant.access_token};
 const client=googleClient();if(!client?.client_id||!client.client_secret)throw failure('gmail','configuration',{gmailCode:'gmail_refresh'});
 const fresh=await request('gmail','https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:client.client_id,client_secret:client.client_secret,refresh_token:grant.refresh_token,grant_type:'refresh_token'})});
 if(typeof fresh.access_token!=='string'||!fresh.access_token||!Number.isFinite(Number(fresh.expires_in))||Number(fresh.expires_in)<=60)throw failure('gmail','response');
 await updateSecrets(current=>{if(current.gmail_tokens?.refresh_token===grant.refresh_token)current.gmail_tokens={...current.gmail_tokens,access_token:fresh.access_token,refresh_token:fresh.refresh_token||grant.refresh_token,scope:fresh.scope||grant.scope,expires_at:Date.now()+Number(fresh.expires_in)*1000};});
 return{refreshed:outcome(cursor,[],{},'Gmail access renewed. Resuming import.')};
}
function gmailPage(cursor,records=[]){
 if(cursor.pendingIds.length)return outcome(cursor,records);
 if(cursor.nextPageToken){cursor.pageToken=cursor.nextPageToken;cursor.nextPageToken=null;cursor.phase='list';return outcome(cursor,records,cursor.mode==='full'?{gmail_page:{pageToken:cursor.pageToken,historyId:cursor.historyId,query:cursor.query}}:{});}
 cursor.phase='done';return outcome(cursor,records,{gmail_history:cursor.mode==='history'?cursor.pageHistoryId:cursor.historyId,gmail_page:null});
}
async function advanceGmail(cursor){
 const credentials=await gmailAccess(cursor);if(credentials.refreshed)return credentials.refreshed;
 const get=(path,query)=>request('gmail',providerUrl('https://gmail.googleapis.com/gmail/v1/users/me/',path,query),{headers:{Authorization:'Bearer '+credentials.access}});
 if(cursor.phase==='profile'){
  const profile=await get('profile');if(!token(profile.historyId,'gmail')||typeof profile.emailAddress!=='string')throw failure('gmail','response');
  cursor.historyId=profile.historyId;cursor.phase='list';return outcome(cursor,[],{gmail_email:profile.emailAddress,gmail_page:{pageToken:null,historyId:cursor.historyId,query:cursor.query}});
 }
 if(cursor.phase==='list'){
  let page;
  if(cursor.mode==='history'){
   try{page=await get('history',{startHistoryId:cursor.historyId,pageToken:cursor.pageToken,maxResults:100});}
   catch(error){if(error.status!==404)throw error;return outcome({v:1,provider:'gmail',mode:'full',phase:'profile',query:cursor.query,historyId:null,pageToken:null,pendingIds:[],nextPageToken:null},[],{gmail_history:null,gmail_page:null},'Gmail history expired. Starting a full import.');}
   if(page.history!==undefined&&!Array.isArray(page.history))throw failure('gmail','response');
   const changed=[];for(const row of page.history||[]){for(const type of ['messagesAdded','messagesDeleted','labelsAdded','labelsRemoved']){if(row[type]!==undefined&&!Array.isArray(row[type]))throw failure('gmail','response');for(const event of row[type]||[])changed.push(event.message);}if(row.messages!==undefined&&!Array.isArray(row.messages))throw failure('gmail','response');changed.push(...(row.messages||[]));if(changed.length>MAX_IDS)throw failure('gmail','oversized');}
   cursor.pendingIds=ids(changed,'gmail');cursor.pageHistoryId=token(page.historyId,'gmail');if(!cursor.pageHistoryId)throw failure('gmail','response');
  }else{page=await get('messages',{q:cursor.query,maxResults:100,pageToken:cursor.pageToken});cursor.pendingIds=ids(page.messages||[],'gmail',100);}
  cursor.nextPageToken=token(page.nextPageToken,'gmail');if(cursor.nextPageToken&&cursor.nextPageToken===cursor.pageToken)throw failure('gmail','cursor');cursor.phase='message';return gmailPage(cursor);
 }
 if(cursor.phase==='message'&&cursor.pendingIds?.length){
  const id=cursor.pendingIds[0],records=[];
  try{const raw=await get('messages/'+encodeURIComponent(id),{format:'full'});if(raw.id!==id)throw failure('gmail','response');if(!(raw.labelIds||[]).some(label=>['SPAM','TRASH'].includes(label)))records.push({doc:normalizeGmail(raw),raw});}
  catch(error){if(error.status!==404)throw error;const old=await one('SELECT provider,external_id,title,occurred_at,url FROM sources WHERE id=?','gmail:'+id);if(old)records.push({doc:{...old,coverage:'deleted upstream',body:'This message was deleted upstream. Prior snapshots remain in the archive.'},raw:{deleted:true,id}});}
  cursor.pendingIds.shift();return gmailPage(cursor,records);
 }
 throw failure('gmail','cursor');
}

async function granolaPage(cursor,records=[]){
 delete cursor.note;delete cursor.parts;delete cursor.transcriptToken;delete cursor.transcriptPages;
 if(cursor.pendingIds.length){cursor.phase='detail';return outcome(cursor,records);}
 if(cursor.nextPageToken){cursor.pageToken=cursor.nextPageToken;cursor.nextPageToken=null;cursor.phase='list';return outcome(cursor,records,{granola_page:granolaCheckpoint(cursor)});}
 cursor.phase='done';return outcome(cursor,records,await granolaCompletedSettings(cursor));
}
async function advanceGranola(cursor){
 const stored=await secrets();if(!stored.granola_key)throw failure('granola','configuration');
 const get=(path,query)=>request('granola',providerUrl('https://public-api.granola.ai/v1/',path,query),{headers:{Authorization:'Bearer '+stored.granola_key}});
 if(cursor.phase==='list'){
  const list=await get('notes',{page_size:30,cursor:cursor.pageToken,updated_after:cursor.since});
  ids(list.notes,'granola',30);if(typeof list.hasMore!=='boolean')throw failure('granola','response');
  cursor.pendingIds=ids(await granolaNotesToFetch(list.notes,cursor),'granola',30);
  cursor.nextPageToken=list.hasMore?token(list.cursor,'granola'):null;if(list.hasMore&&(!cursor.nextPageToken||cursor.nextPageToken===cursor.pageToken))throw failure('granola','cursor');
  return granolaPage(cursor);
 }
 if(cursor.phase==='detail'&&cursor.pendingIds?.length){
  let note;try{note=await get('notes/'+encodeURIComponent(cursor.pendingIds[0]));}catch(error){if(error.status!==404)throw error;cursor.pendingIds.shift();return granolaPage(cursor);}
  if(note.id!==cursor.pendingIds[0])throw failure('granola','response');
  // Inline transcripts can be truncated; only the paginated endpoint establishes coverage.
  delete note.transcript;cursor.note=note;cursor.parts=[];cursor.transcriptToken=null;cursor.transcriptPages=0;cursor.phase='transcript';return outcome(cursor);
 }
 if(cursor.phase==='transcript'&&cursor.note){
  let page;try{page=await get('notes/'+encodeURIComponent(cursor.note.id)+'/transcript',{page_size:50,cursor:cursor.transcriptToken});}catch(error){if(error.status!==404)throw error;cursor.pendingIds.shift();return granolaPage(cursor);}
  const entries=page.transcript;if(!Array.isArray(entries)||entries.length>50||typeof page.hasMore!=='boolean'||entries.some(entry=>typeof entry?.text!=='string'))throw failure('granola','response');
  cursor.parts.push(...entries);cursor.transcriptPages++;if(cursor.transcriptPages>10000)throw failure('granola','oversized');
  if(page.hasMore){const next=token(page.cursor,'granola');if(!next||next===cursor.transcriptToken)throw failure('granola','cursor');cursor.transcriptToken=next;return outcome(cursor);}
  const note=cursor.note,parts=cursor.parts;const summary=[note.summary_markdown||note.summary_text,note.private_notes_markdown||note.private_notes_text].filter(Boolean).join('\n\n');
  const transcript=parts.map(part=>`${part.start_time??''} ${part.speaker?.name||part.speaker?.attribution||part.speaker?.diarization_label||'Unattributed'}: ${part.text}`).join('\n');
  const record={doc:{provider:'granola',external_id:note.id,title:note.title||'Untitled meeting',occurred_at:note.created_at||'',url:note.web_url||'',body:[summary,transcript?'Transcript\n'+transcript:''].filter(Boolean).join('\n\n'),coverage:transcript?'transcript':summary?'summary':'empty'},raw:{...note,transcript:parts}};
  cursor.pendingIds.shift();return granolaPage(cursor,[record]);
 }
 throw failure('granola','cursor');
}

async function advanceFireflies(cursor){
 if(cursor.phase!=='record'||!Number.isSafeInteger(cursor.skip)||cursor.skip<0||!cursor.participant||!Number.isFinite(Date.parse(cursor.boundary))||(cursor.since!=null&&(!Number.isFinite(Date.parse(cursor.since))||Date.parse(cursor.since)>Date.parse(cursor.boundary))))throw failure('fireflies','cursor');
 const stored=await secrets();if(!stored.fireflies_key)throw failure('fireflies','configuration');
 const value=await request('fireflies','https://api.fireflies.ai/graphql',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+stored.fireflies_key},body:JSON.stringify({query:'query($skip:Int,$since:DateTime,$until:DateTime,$participants:[String!]){transcripts(limit:1,skip:$skip,fromDate:$since,toDate:$until,participants:$participants){id title dateString transcript_url participants sentences{speaker_name text start_time end_time} summary{short_summary action_items overview}}}',variables:{skip:cursor.skip,since:cursor.since??null,until:cursor.boundary,participants:[cursor.participant]}})});
 const rows=value.data?.transcripts;ids(rows,'fireflies',1);
 if(!rows.length){cursor.phase='done';return outcome(cursor,[],await firefliesCompletedSettings(cursor));}
 const raw=rows[0];if(raw.sentences!==undefined&&raw.sentences!==null&&!Array.isArray(raw.sentences))throw failure('fireflies','response');
 const summary=[raw.summary?.short_summary,raw.summary?.overview,raw.summary?.action_items].filter(Boolean).join('\n\n');
 const transcript=(raw.sentences||[]).map(part=>`[${part.start_time}s] ${part.speaker_name||'Unattributed'}: ${part.text}`).join('\n');
 const record={doc:{provider:'fireflies',external_id:raw.id,title:raw.title||'Untitled meeting',occurred_at:raw.dateString||'',url:raw.transcript_url||'',body:[summary,transcript?'Transcript\n'+transcript:''].filter(Boolean).join('\n\n'),coverage:transcript?'transcript':summary?'summary':'metadata'},raw};
 cursor.skip++;return outcome(cursor,[record],{fireflies_page:firefliesCheckpoint(cursor)},cursor.since?'Syncing recent Fireflies transcripts; progress saved':'Importing Fireflies history; progress saved');
}

export async function advanceProvider(provider,cursor){
 if(!names[provider]||cursor?.provider!==provider||cursor?.v!==1)throw failure(provider,'cursor');
 // Never mutate the caller's checkpoint, even when a request fails or is replayed.
 const next=structuredClone(bounded(cursor,provider));if(next.phase==='done')return outcome(next);
 if(provider==='gmail')return advanceGmail(next);
 if(provider==='granola')return advanceGranola(next);
 return advanceFireflies(next);
}
