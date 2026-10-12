import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import {randomBytes} from 'node:crypto';
process.env.XIN_SECRET_STORAGE='postgres';process.env.XIN_SECRETS_KEY=randomBytes(32).toString('base64url');
import assert from 'node:assert/strict';
process.env.XIN_AGENT_MODE='cloud';
const {upsertSource,all,one,run,setSetting}=await import('../lib/db.mjs');
const {secrets,saveSecrets}=await import('../lib/secret-store.mjs');
const {initialProviderCursor,advanceProvider}=await import('../lib/ingestion-providers.mjs');
const {callContextTool}=await import('../lib/context-tools.mjs');
const day=new Date(Date.now()+86400000).toISOString().slice(0,10);
const event={id:'fixture-event',summary:'Project delivery review',status:'confirmed',start:{dateTime:day+'T10:00:00+08:00',timeZone:'Asia/Singapore'},end:{dateTime:day+'T11:00:00+08:00',timeZone:'Asia/Singapore'},attendees:[{email:'owner@example.com',self:true,responseStatus:'accepted'}],description:'Review the promised implementation plan.'};
test.beforeEach(async()=>{await run('TRUNCATE sources,jobs,items CASCADE');await run("DELETE FROM settings WHERE key LIKE 'calendar_%'");await saveSecrets({calendar_tokens:{access_token:'fixture-access',refresh_token:'fixture-refresh',expires_at:Date.now()+3600000,scope:'https://www.googleapis.com/auth/calendar.events.readonly'}});});
async function sync(t,responses){const calls=[];t.mock.method(global,'fetch',async(url,options)=>{calls.push(String(url));assert.equal(options.method||'GET','GET');assert.equal(options.headers.Authorization,'Bearer fixture-access');const next=responses.shift();assert.ok(next,'Unexpected provider request');return Response.json(next.body||next,{status:next.body?next.status||200:200});});let cursor=await initialProviderCursor('calendar');for(let i=0;i<30;i++){const result=await advanceProvider('calendar',cursor);cursor=result.cursor;for(const r of result.records)await upsertSource(r.doc,r.raw);for(const [k,v]of Object.entries(result.settings))await setSetting(k,v);if(result.complete)return calls;}throw Error('Calendar failed to complete');}
test('calendar pages preserve timezone, exact snapshots and RSVP without creating relationship exchanges',async t=>{
 const calls=await sync(t,[{items:[],nextPageToken:'page2',timeZone:'Asia/Singapore'},{items:[event,{id:'all-day',summary:'All day launch',status:'tentative',start:{date:day},end:{date:day}}],timeZone:'Asia/Singapore'}]);
 assert.equal(calls.length,2);assert.match(calls[1],/pageToken=page2/);assert.match(calls[0],/showDeleted=true/);
 const rows=await all("SELECT * FROM sources WHERE provider='calendar'");assert.equal(rows.length,2);assert.match(rows.find(s=>s.external_id==='primary:fixture-event').body,/10:00:00\+08:00/);assert.match(rows.find(s=>s.external_id==='primary:all-day').body,/All day: yes/);
 assert.equal((await one('SELECT count(*) n FROM contact_queue')).n,0);
 const context=await callContextTool('read_calendar');assert.equal(context.connected,true);assert.equal(context.stale,false);assert.ok(context.events[0].source_version_id);
});
test('missing events are fetched individually: cancellations and moves beyond the window are never guessed',async t=>{
 const {normalizeCalendar}=await import('../lib/calendar.mjs');await upsertSource(normalizeCalendar(event),event);
 const calls=await sync(t,[{items:[],timeZone:'Asia/Singapore'},{...event,status:'cancelled'}]);assert.equal(calls.length,2);assert.match(calls[1],/events\/fixture-event/);
 assert.match((await one("SELECT body FROM sources WHERE id='calendar:primary:fixture-event'")).body,/Status: cancelled/);
});
test('a failed or partial calendar sync cannot erase an event or claim fresh coverage',async t=>{
 const {normalizeCalendar}=await import('../lib/calendar.mjs');await upsertSource(normalizeCalendar(event),event);
 await assert.rejects(sync(t,[{items:[]},{status:503,body:{error:{message:'private provider detail'}}}]),/temporarily unavailable/);
 assert.match((await one("SELECT body FROM sources WHERE id='calendar:primary:fixture-event'")).body,/Status: confirmed/);
 assert.equal((await callContextTool('read_calendar')).stale,true);
});
test('Google partial consent keeps calendar and Gmail independent',async()=>{
 const {saveCalendarGrant,connectionState}=await import('../lib/connectors.mjs');
 await saveSecrets({});assert.equal(await saveCalendarGrant({scope:'openid email'}, {email:'owner@example.com'}),false);
 assert.equal(await saveCalendarGrant({scope:'https://www.googleapis.com/auth/calendar.events.readonly',access_token:'new-access',refresh_token:'new-refresh'}, {email:'owner@example.com'}),true);
 const state=await connectionState();assert.equal(state.calendar.configured,true);assert.equal(state.gmail.configured,false);assert.ok(!JSON.stringify(state).includes('new-refresh'));
 await assert.rejects(saveCalendarGrant({scope:'https://www.googleapis.com/auth/calendar.events.readonly',refresh_token:'other'}, {email:'other@example.com'}),/account/);
});
test('rescheduled events outside the rolling window remain current, and minimal cancellations retain instance identity',async t=>{
 const {normalizeCalendar}=await import('../lib/calendar.mjs');
 const original={...event,recurringEventId:'series-1',originalStartTime:event.start};await upsertSource(normalizeCalendar(original),original);
 const moved={...original,start:{dateTime:'2030-01-15T10:00:00+08:00'},end:{dateTime:'2030-01-15T11:00:00+08:00'}};
 await sync(t,[{items:[]},moved]);assert.match((await one("SELECT body FROM sources WHERE id='calendar:primary:fixture-event'")).body,/2030-01-15/);
 t.mock.restoreAll();await upsertSource(normalizeCalendar(original),original);
 await sync(t,[{items:[{id:event.id,status:'cancelled'}]}]);const row=await one("SELECT body FROM sources WHERE id='calendar:primary:fixture-event'");assert.match(row.body,/Status: cancelled/);assert.match(row.body,/Recurring event: series-1/);assert.match(row.body,/Original instance start:/);
});
test('calendar deadlines reject hard deadlines, obsolete snapshots, tentative attendance and stale coverage',async t=>{
 const {validateResult}=await import('../lib/agent.mjs');
 await sync(t,[{items:[event]}]);const c=await one("SELECT v.id FROM sources s JOIN source_versions v ON v.source_id=s.id AND v.content_hash=s.content_hash WHERE s.id='calendar:primary:fixture-event'");
 const quote='Avery: I will prepare the implementation plan for the project review.';
 await upsertSource({provider:'granola',external_id:'promise',title:'Promise',coverage:'transcript',body:'Transcript\n'+quote});
 const p={title:'Prepare the plan',kind:'action',rationale:'Promised preparation',done_when:'Ready',next_action:'Draft',existing_item_id:'',uncertainty:'',confidence:'high',qualification:{basis:'verbal_promise',area:'customer',deliverable_key:'project-review-plan',owner_basis:'Avery is the workspace owner.',commitment_quote:quote,due_date:day,deadline_kind:'checkpoint',deadline_source_id:'calendar:primary:fixture-event',deadline_quote:'Start: '+event.start.dateTime},citations:[{source_id:'granola:promise',quote},{source_id:'calendar:primary:fixture-event',source_version_id:c.id,quote:'Start: '+event.start.dateTime}]};
 const result=()=>({brief:'Ready',findings:[],proposals:[p],questions:[],coverage_note:'Fixture'});
 await validateResult(result());p.qualification.deadline_kind='hard';await assert.rejects(validateResult(result()),/hard deadline/);p.qualification.deadline_kind='checkpoint';
 const {normalizeCalendar}=await import('../lib/calendar.mjs');await upsertSource(normalizeCalendar({...event,status:'tentative'}),{...event,status:'tentative'});await assert.rejects(validateResult(result()),/current/);
 await upsertSource(normalizeCalendar(event),event);await setSetting('calendar_last_sync',{at:'2020-01-01T00:00:00Z'});await assert.rejects(validateResult(result()),/fresh/);
});
