import {all,getSetting} from './db.mjs';
import {secrets} from './secret-store.mjs';
export const CALENDAR_SCOPE='https://www.googleapis.com/auth/calendar.events.readonly';
export function calendarGranted(grant){return Boolean(grant?.refresh_token&&String(grant.scope||'').split(' ').includes(CALENDAR_SCOPE));}
export function normalizeCalendar(event,zone='UTC'){
 const start=event.start?.dateTime||event.start?.date||'',end=event.end?.dateTime||event.end?.date||'';
 return{provider:'calendar',external_id:'primary:'+event.id,title:event.summary||'Calendar event',occurred_at:start,url:event.htmlLink||'',coverage:'calendar event',body:[
  'Calendar: primary','Event ID: '+event.id,'Title: '+(event.summary||'Calendar event'),'Status: '+(event.status||'confirmed'),
  'Start: '+start,'End: '+end,'Time zone: '+(event.start?.timeZone||zone),'All day: '+(event.start?.date?'yes':'no'),
  'Your response: '+(event.attendees?.find(a=>a.self)?.responseStatus||(event.organizer?.self?'organizer':'unknown')),
  event.recurringEventId?'Recurring event: '+event.recurringEventId:'',event.originalStartTime?'Original instance start: '+(event.originalStartTime.dateTime||event.originalStartTime.date):'',
  event.organizer?'Organizer: '+(event.organizer.displayName||'')+' <'+(event.organizer.email||'')+'>':'',
  ...(event.attendees||[]).map(a=>'Attendee: '+(a.displayName||'')+' <'+(a.email||'')+'> ('+(a.responseStatus||'unknown')+')'),
  event.location?'Location: '+event.location:'',event.description?'Description:\n'+event.description:'',
  'Calendar attendance is context, not evidence of a promise or a hard deadline.'
 ].filter(Boolean).join('\n')};
}
export async function readCalendar({offset=0,query=''}={}){
 const grant=(await secrets()).calendar_tokens,synced=await getSetting('calendar_last_sync'),connected=calendarGranted(grant);
 const since=new Date(Date.now()-30*86400000).toISOString(),until=new Date(Date.now()+90*86400000).toISOString();
 const rows=await all("SELECT s.id source_id,v.id source_version_id,s.title,s.body,s.occurred_at,s.updated_at FROM sources s JOIN source_versions v ON v.source_id=s.id AND v.content_hash=s.content_hash WHERE s.provider='calendar' AND s.occurred_at>=? AND s.occurred_at<=?"+(query?" AND to_tsvector('simple',s.title||' '||s.body) @@ plainto_tsquery('simple',?)":'')+' ORDER BY s.occurred_at,s.id LIMIT 11 OFFSET ?',since,until,...(query?[query]:[]),Math.max(0,Number(offset)||0));
 return{connected,last_synced_at:synced?.at||null,stale:!connected||!synced||Date.now()-Date.parse(synced.at)>30*60000,coverage:'Primary calendar; past 30 and next 90 days. Event dates can support preparation checkpoints only when tied to a promised output. Cancelled, declined and tentative events cannot establish deadlines.',events:rows.slice(0,10),next_offset:rows.length>10?Math.max(0,Number(offset)||0)+10:null};
}
