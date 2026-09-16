import {listContacts,contactDetail,saveContact,saveAffiliation,importContactsCsv,contactStatus,confirmCoverage,saveDraft,linkContactItem} from '../../../lib/contacts.mjs';
import {logInteraction,reviewInteraction} from '../../../lib/contact-extraction.mjs';
import {mergePreview,mergeContacts,undoMerge,keepSeparate,bulkMergePreview,mergeReviewGroup,bulkKeepSeparate} from '../../../lib/contact-identity.mjs';
import {startContactProjection,recoverContactRuns} from '../../../lib/contact-jobs.mjs';
import {dashboard,searchSources,readSource,readSourceVersion,saveItem,all,one,run,setSetting,exportData,dateOK} from '../../../lib/db.mjs';
import {createJob,launchJob,recoverJobs,queueImportReview,cancelJob} from '../../../lib/agent.mjs';
import {connectionState,configure,googleClient,configureGoogleClient,startSync,recoverSyncRuns} from '../../../lib/connectors.mjs';
import {importDocuments,importResearchArchive} from '../../../lib/imports.mjs';
import {authMessages,gmailMessages} from '../../../lib/auth-messages.mjs';
import {APP_ORIGIN,SESSION_COOKIE,FLOW_COOKIE,SESSION_SECONDS,checkLocalRequest,sessionFor,requireSession,readCookie,cookie,beginGoogle,finishGoogle,endSession,recordAuthEvent} from '../../../lib/auth.mjs';
import {buildUpdateDraft,renderUpdateDraft} from '../../../lib/update-draft.mjs';
import {localToday} from '../../../lib/urgency.mjs';
import {HOSTED,POSTGRES_SECRETS,CLOUD_JOBS} from '../../../lib/runtime.mjs';
import {workerStatus} from '../../../lib/workers.mjs';
import {after} from 'next/server.js';
import {drainCloudWork} from '../../../lib/cloud-jobs.mjs';
import {createManualUpload,appendManualChunk,finishManualUpload,cancelManualUpload} from '../../../lib/manual-ingestion.mjs';
import {start,getRun} from 'workflow/api';
import {ingestionWorkflow} from '../../../workflows/ingestion.js';
import {resumeDurable} from '../../../lib/durable-ingestion.mjs';
import {createBeeperPairing,revokeBeeper,requestBeeperSync} from '../../../lib/beeper.mjs';
import {reviewSettings,startChatGPTLogin,pollChatGPTLogin,cancelChatGPTLogin,disconnectChatGPT,testChatGPTConnection,saveReviewProvider} from '../../../lib/review-settings.mjs';
export const maxDuration=800;
function scheduleWork(){if(CLOUD_JOBS)after(async()=>{try{await drainCloudWork((...args)=>start(ingestionWorkflow,args),id=>getRun(id).status);}catch{console.error('Background work interrupted; pending dispatch will retry.');}});}
export const runtime='nodejs';export const dynamic='force-dynamic';
function publicError(e){return e.code?'The database could not complete this request. Check its connection and migrations, then retry.':e.message;}
function json(v,status=200){return Response.json(v,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});}
export async function GET(req){try{checkLocalRequest(req);const u=new URL(req.url),path=decodeURIComponent(u.pathname.slice(5));
 if(path==='auth/status')return json({configured:!!googleClient(),user:(await sessionFor(readCookie(req,SESSION_COOKIE)))});
 if(path==='auth/google/callback'){
  let result;
  try{if(u.searchParams.get('error')){(await recordAuthEvent('consent','failed',u.searchParams.get('error')==='access_denied'?'cancelled':'signin'));throw Object.assign(Error('Google did not authorize sign-in.'),{authCode:u.searchParams.get('error')==='access_denied'?'cancelled':'signin'});}result=await finishGoogle(u.searchParams.get('code'),u.searchParams.get('state'),readCookie(req,FLOW_COOKIE));}
  catch(e){const response=new Response(null,{status:303,headers:{Location:APP_ORIGIN+'/login?error='+(authMessages[e.authCode]?e.authCode:'signin'),'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});response.headers.append('Set-Cookie',cookie(FLOW_COOKIE,'',0));return response;}
  (await endSession(readCookie(req,SESSION_COOKIE)));
  let importState='manual';if(result.gmail){try{(await startSync('gmail'));scheduleWork();importState='started';}catch{}}
  const response=new Response(null,{status:303,headers:{Location:APP_ORIGIN+'/?gmail='+(gmailMessages[result.gmailIssue]?result.gmailIssue:result.gmail?'connected':'missing')+'&import='+importState,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
  response.headers.append('Set-Cookie',cookie(SESSION_COOKIE,result.token,SESSION_SECONDS));response.headers.append('Set-Cookie',cookie(FLOW_COOKIE,'',0));return response;
 }
 const user=(await requireSession(req));
 if(path==='owners'){
  const query='%'+(u.searchParams.get('q')||'').trim().slice(0,200)+'%';
  const rows=await all("SELECT name FROM (SELECT name FROM contacts WHERE merged_into IS NULL AND archived=false AND name<>'' AND (name ILIKE ? OR email ILIKE ?) UNION SELECT owner AS name FROM items WHERE owner<>'' AND owner ILIKE ?) AS owners ORDER BY lower(name),name LIMIT 51",query,query,query);
  return json({owners:rows.slice(0,50).map(row=>row.name),hasMore:rows.length>50});
 }
 if(path==='settings/reviews')return json(await reviewSettings());
 if(path==='contacts')return json(await listContacts(Object.fromEntries(u.searchParams)));
 if(path==='contacts/status'){await recoverContactRuns();return json(await contactStatus());}
 if(path==='contacts/merge-preview')return json(await mergePreview(u.searchParams.get('target_id'),u.searchParams.get('source_id')));
 if(path.startsWith('contacts/'))return json(await contactDetail(path.slice(9)));

 if(path==='state'){(await recoverJobs());(await recoverSyncRuns());return json({...(await dashboard()),connections:(await connectionState()),worker:await workerStatus(),user});}
 if(path==='sources')return json((await searchSources(u.searchParams.get('q')||'',u.searchParams.get('provider')||'',u.searchParams.get('offset')||0)));
 if(path.startsWith('sources/'))return json(u.searchParams.get('version')?await readSourceVersion(u.searchParams.get('version')):await readSource(path.slice(8),0,2000000));
 if(path.startsWith('events/'))return json((await all('SELECT * FROM events WHERE item_id=? ORDER BY created_at DESC',path.slice(7))));
 if(path.startsWith('jobs/'))return json({job:(await one('SELECT * FROM jobs WHERE id=?',path.slice(5))),events:(await all('SELECT * FROM job_events WHERE job_id=? ORDER BY id',path.slice(5)))});
 if(path==='update-draft'){const requested=u.searchParams.get('since')||'';if(requested&&!dateOK(requested))throw Error('Choose a valid date.');const now=new Date(),today=localToday(now,process.env.XIN_TIME_ZONE),since=requested||localToday(new Date(now.getTime()-7*86400000),process.env.XIN_TIME_ZONE);const draft=buildUpdateDraft({items:(await all('SELECT * FROM items')),events:(await all('SELECT e.*,i.shared FROM events e JOIN items i ON i.id=e.item_id WHERE e.created_at>=? ORDER BY e.created_at',since)),since,today});return json({since,draft,text:renderUpdateDraft(draft)});}
 if(path==='export')return new Response(JSON.stringify((await exportData()),null,2),{headers:{'Content-Type':'application/json','Content-Disposition':'attachment; filename="xin-system-export.json"','Cache-Control':'no-store'}});

 return json({error:'Not found'},404);
 }catch(e){return json({error:publicError(e)},e.status||400);}}
export async function POST(req){try{checkLocalRequest(req,true);const path=decodeURIComponent(new URL(req.url).pathname.slice(5));
 if(!['auth/setup','auth/google/start'].includes(path))(await requireSession(req));
 const limit=path.startsWith('auth/')?32*1024:HOSTED?4*1024*1024:20*1024*1024;
 if(Number(req.headers.get('content-length'))>limit)throw Error('The request is too large.');
 const raw=await req.text();if(Buffer.byteLength(raw)>limit)throw Error('The request is too large.');const data=JSON.parse(raw||'{}');
 if(path==='auth/setup'){if(HOSTED||POSTGRES_SECRETS)return json({error:'Configure Google sign-in in the server environment.'},403);if(googleClient())return json({error:'Google sign-in is already configured. Use local setup to change its credentials.'},409);configureGoogleClient(data);return json({configured:true});}
 if(path==='auth/google/start'){const flow=(await beginGoogle(readCookie(req,FLOW_COOKIE)));const response=json({url:flow.url});response.headers.append('Set-Cookie',flow.cookie);return response;}
 if(path==='auth/logout'){(await endSession(readCookie(req,SESSION_COOKIE)));const response=json({signed_out:true});response.headers.append('Set-Cookie',cookie(SESSION_COOKIE,'',0));return response;}
 if(path==='settings/reviews')return json(await saveReviewProvider(data));
 if(path==='settings/reviews/chatgpt/start')return json(await startChatGPTLogin());
 if(path==='settings/reviews/chatgpt/poll')return json(await pollChatGPTLogin(data.id));
 if(path==='settings/reviews/chatgpt/cancel')return json(await cancelChatGPTLogin(data.id));
 if(path==='settings/reviews/chatgpt/disconnect')return json(await disconnectChatGPT());
 if(path==='settings/reviews/chatgpt/test')return json(await testChatGPTConnection(data.model));

 if(path==='contacts')return json(await saveContact(data));
 if(path==='contacts/affiliation')return json(await saveAffiliation(data));
 if(path==='contacts/import')return json(await importContactsCsv(data.csv));
 if(path==='contacts/backfill'){const failed=CLOUD_JOBS&&data.retry?await one("SELECT c.id FROM contact_runs c JOIN durable_runs d ON d.kind='contacts' AND d.run_id=c.id WHERE c.state='failed' ORDER BY c.started_at DESC LIMIT 1"):null;const result=failed?await resumeDurable('contacts',failed.id):await startContactProjection(data);scheduleWork();return json(result,202);}
 if(path==='contacts/interaction')return json(await logInteraction(data));
 if(path==='contacts/interaction-review')return json(await reviewInteraction(data));
 if(path==='contacts/coverage')return json(await confirmCoverage(data.id));
 if(path==='contacts/link')return json(await linkContactItem(data));
 if(path==='contacts/draft')return json(await saveDraft(data));
 if(path==='contacts/merge')return json(await mergeContacts(data));
 if(path==='contacts/bulk-merge-preview')return json(await bulkMergePreview(data));
 if(path==='contacts/bulk-merge')return json(await mergeReviewGroup(data));
 if(path==='contacts/bulk-separate')return json(await bulkKeepSeparate(data));
 if(path==='contacts/undo-merge')return json(await undoMerge(data.id));
 if(path==='contacts/separate')return json(await keepSeparate(data.id));
 if(path==='items')return json((await saveItem(data)));
 if(path==='settings'){if(typeof data.focus==='string')(await setSetting('focus',data.focus.slice(0,2000)));if(data.available_hours!==undefined)(await setSetting('available_hours',Math.max(0,Math.min(168,Number(data.available_hours)||0))));return json({saved:true});}
 if(path==='jobs'){const id=(await createJob(data.prompt,'review',{answers:data.answers,parent_id:data.parent_id}));(await launchJob(id));scheduleWork();return json({id},202);}
 if(path==='jobs/cancel')return json((await cancelJob(data.id)));
 if(path==='proposals/dismiss'){(await run("UPDATE proposals SET status='dismissed' WHERE id=?",data.id));return json({saved:true});}
 if(path==='connections')return json((await configure(data)));
 if(path==='beeper/pairing')return json(await createBeeperPairing());
 if(path==='beeper/revoke')return json(await revokeBeeper());
 if(path==='beeper/refresh')return json(await requestBeeperSync(),202);
 if(path==='sync'){if(data.retry_id&&data.rescan)throw Error('Choose either resume or rescan history.');const resumed=CLOUD_JOBS&&data.retry_id?await resumeDurable('sync',data.retry_id,data.provider):null;const result=resumed||await startSync(data.provider,{rescan:data.rescan??false});scheduleWork();return json(result,202);}
 if(path==='imports/start')return json(await createManualUpload(data),201);
 if(path==='imports/chunk')return json(await appendManualChunk(data));
 if(path==='imports/cancel')return json(await cancelManualUpload(data));
 if(path==='imports/finish'){const result=await finishManualUpload(data);scheduleWork();return json(result,202);}
 if(path==='import'){
  if(CLOUD_JOBS){const content=JSON.stringify(data),upload=await createManualUpload({format:'json',title:'Imported archive',bytes:Buffer.byteLength(content)});try{let part=0;for(let offset=0;offset<content.length;){let end=Math.min(offset+65536,content.length);if(end<content.length&&/[\uD800-\uDBFF]/.test(content[end-1]))end--;await appendManualChunk({id:upload.id,part:part++,content:content.slice(offset,end)});offset=end;}const result=await finishManualUpload({id:upload.id,parts:part});scheduleWork();return json(result,202);}catch(e){await cancelManualUpload({id:upload.id});throw e;}}
  const result=data.fireflies_records?(await importResearchArchive(data)):(await importDocuments(Array.isArray(data)?data:[data]));if(result.changed){await startContactProjection({drain:true});await queueImportReview();scheduleWork();}return json(result);
 }
 return json({error:'Not found'},404);
 }catch(e){return json({error:publicError(e)},e.status||400);}}
