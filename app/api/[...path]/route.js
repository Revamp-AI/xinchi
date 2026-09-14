import {dashboard,searchSources,readSource,saveItem,all,one,run,setSetting,exportData} from '../../../lib/db.mjs';
import {createJob,launchJob,recoverJobs,queueImportReview} from '../../../lib/agent.mjs';
import {connectionState,configure,googleClient,configureGoogleClient,startSync,recoverSyncRuns} from '../../../lib/connectors.mjs';
import {importDocuments,importResearchArchive} from '../../../lib/imports.mjs';
import {authMessages,gmailMessages} from '../../../lib/auth-messages.mjs';
import {APP_ORIGIN,SESSION_COOKIE,FLOW_COOKIE,SESSION_SECONDS,checkLocalRequest,sessionFor,requireSession,readCookie,cookie,beginGoogle,finishGoogle,endSession,recordAuthEvent} from '../../../lib/auth.mjs';
import {buildUpdateDraft,renderUpdateDraft} from '../../../lib/update-draft.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
function json(v,status=200){return Response.json(v,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});}
export async function GET(req){try{checkLocalRequest(req);const u=new URL(req.url),path=decodeURIComponent(u.pathname.slice(5));
 if(path==='auth/status')return json({configured:!!googleClient(),user:sessionFor(readCookie(req,SESSION_COOKIE))});
 if(path==='auth/google/callback'){
  let result;
  try{if(u.searchParams.get('error')){recordAuthEvent('consent','failed',u.searchParams.get('error')==='access_denied'?'cancelled':'signin');throw Object.assign(Error('Google did not authorize sign-in.'),{authCode:u.searchParams.get('error')==='access_denied'?'cancelled':'signin'});}result=await finishGoogle(u.searchParams.get('code'),u.searchParams.get('state'),readCookie(req,FLOW_COOKIE));}
  catch(e){const response=new Response(null,{status:303,headers:{Location:APP_ORIGIN+'/login?error='+(authMessages[e.authCode]?e.authCode:'signin'),'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});response.headers.append('Set-Cookie',cookie(FLOW_COOKIE,'',0));return response;}
  endSession(readCookie(req,SESSION_COOKIE));
  let importState='manual';if(result.gmail){try{startSync('gmail');importState='started';}catch{}}
  const response=new Response(null,{status:303,headers:{Location:APP_ORIGIN+'/?gmail='+(gmailMessages[result.gmailIssue]?result.gmailIssue:result.gmail?'connected':'missing')+'&import='+importState,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
  response.headers.append('Set-Cookie',cookie(SESSION_COOKIE,result.token,SESSION_SECONDS));response.headers.append('Set-Cookie',cookie(FLOW_COOKIE,'',0));return response;
 }
 const user=requireSession(req);
 if(path==='state'){recoverJobs();recoverSyncRuns();return json({...dashboard(),connections:connectionState(),user});}
 if(path==='sources')return json(searchSources(u.searchParams.get('q')||'',u.searchParams.get('provider')||'',u.searchParams.get('offset')||0));
 if(path.startsWith('sources/'))return json(readSource(path.slice(8),0,2000000));
 if(path.startsWith('events/'))return json(all('SELECT * FROM events WHERE item_id=? ORDER BY created_at DESC',path.slice(7)));
 if(path.startsWith('jobs/'))return json({job:one('SELECT * FROM jobs WHERE id=?',path.slice(5)),events:all('SELECT * FROM job_events WHERE job_id=? ORDER BY id',path.slice(5))});
 if(path==='update-draft'){const requested=u.searchParams.get('since')||'';if(requested&&!(/^\d{4}-\d{2}-\d{2}$/.test(requested)&&!isNaN(Date.parse(requested))))throw Error('Choose a valid date.');const today=new Date().toISOString().slice(0,10),since=requested||new Date(Date.now()-7*864e5).toISOString().slice(0,10);const draft=buildUpdateDraft({items:all('SELECT * FROM items'),events:all('SELECT e.*,i.shared FROM events e JOIN items i ON i.id=e.item_id WHERE e.created_at>=? ORDER BY e.created_at',since),since,today});return json({since,draft,text:renderUpdateDraft(draft)});}
 if(path==='export')return new Response(JSON.stringify(exportData(),null,2),{headers:{'Content-Type':'application/json','Content-Disposition':'attachment; filename="xin-system-export.json"','Cache-Control':'no-store'}});

 return json({error:'Not found'},404);
 }catch(e){return json({error:e.message},e.status||400);}}
export async function POST(req){try{checkLocalRequest(req,true);const path=decodeURIComponent(new URL(req.url).pathname.slice(5));
 if(!['auth/setup','auth/google/start'].includes(path))requireSession(req);
 const limit=path.startsWith('auth/')?32*1024:20*1024*1024;
 if(Number(req.headers.get('content-length'))>limit)throw Error('The request is too large.');
 const raw=await req.text();if(raw.length>limit)throw Error('The request is too large.');const data=JSON.parse(raw||'{}');
 if(path==='auth/setup'){if(googleClient())return json({error:'Google sign-in is already configured. Use local setup to change its credentials.'},409);configureGoogleClient(data);return json({configured:true});}
 if(path==='auth/google/start'){const flow=beginGoogle(readCookie(req,FLOW_COOKIE));const response=json({url:flow.url});response.headers.append('Set-Cookie',flow.cookie);return response;}
 if(path==='auth/logout'){endSession(readCookie(req,SESSION_COOKIE));const response=json({signed_out:true});response.headers.append('Set-Cookie',cookie(SESSION_COOKIE,'',0));return response;}

 if(path==='items')return json(saveItem(data));
 if(path==='settings'){if(typeof data.focus==='string')setSetting('focus',data.focus.slice(0,2000));if(data.available_hours!==undefined)setSetting('available_hours',Math.max(0,Math.min(168,Number(data.available_hours)||0)));return json({saved:true});}
 if(path==='jobs'){const id=createJob(data.prompt);launchJob(id);return json({id},202);}
 if(path==='proposals/dismiss'){run("UPDATE proposals SET status='dismissed' WHERE id=?",data.id);return json({saved:true});}
 if(path==='connections')return json(configure(data));
 if(path==='sync')return json(startSync(data.provider),202);
 if(path==='import'){const result=data.fireflies_records?importResearchArchive(data):importDocuments(Array.isArray(data)?data:[data]);if(result.changed)queueImportReview();return json(result);}
 return json({error:'Not found'},404);
 }catch(e){return json({error:e.message},e.status||400);}}
