import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
process.env.XIN_AGENT_MODE='cloud';process.env.XIN_ALLOWED_EMAIL='owner@example.test';
const {all,one,run,hash,exportData}=await import('../lib/db.mjs');
const b=await import('../lib/beeper.mjs');
const {handleBeeperRequest}=await import('../lib/beeper-route.mjs');
const {prepareDispatches,advanceDurableUnit}=await import('../lib/durable-ingestion.mjs');
const {extractInteraction,projectSource}=await import('../lib/contact-extraction.mjs');
const {syncTick,chooseChats,pageProgress,splitRecords,focusOrigin}=await import('../public/beeper-companion.mjs');
const chat={id:'chat-1',accountID:'account-1',network:'Example',title:'Fictional colleague',type:'single',participants:{hasMore:false,items:[{id:'self',fullName:'Owner',isSelf:true},{id:'peer',fullName:'Fictional colleague',email:'peer@example.test',isSelf:false}]}};
const message=(id='message-1')=>({id,accountID:chat.accountID,chatID:chat.id,senderID:'peer',senderName:'Fictional colleague',isSender:false,text:'Fictional project update.',type:'TEXT',timestamp:new Date().toISOString()});
const record=(id)=>({chat,message:message(id)});
async function device(){const {code}=await b.createBeeperPairing();return b.pairBeeper({code,label:'Fictional Mac',selection:[chat]});}
const req=(body,secret,extra={})=>new Request('http://127.0.0.1:3210/api/beeper/device/batch',{method:'POST',headers:{host:'127.0.0.1:3210','content-type':'application/json',...(secret?{authorization:'Bearer '+secret}:{}),...extra},body:JSON.stringify(body)});
test.beforeEach(async()=>{
 await run('TRUNCATE beeper_uploads,import_records,durable_runs,sync_runs,contact_runs,contact_queue,interaction_sources,interaction_participants,interactions,contact_identities,contact_states,contact_state_history,identity_reviews,identity_decisions,affiliations,item_contacts,message_drafts,contacts,sources,source_versions,focus_auth.beeper_pairings,focus_auth.beeper_devices CASCADE');
});
test('pairing codes expire, are single-use, and rotation/revocation invalidates device credentials',async()=>{
 const pair=await b.createBeeperPairing();await run("UPDATE focus_auth.beeper_pairings SET expires_at=now()-interval '1 minute'");
 await assert.rejects(b.pairBeeper({code:pair.code,label:'Mac',selection:[chat]}),/expired/);
 const {code}=await b.createBeeperPairing(),d=await b.pairBeeper({code,label:'Mac',selection:[chat]});
 await assert.rejects(b.pairBeeper({code,label:'Mac',selection:[chat]}),/expired/);
 assert.equal(await b.requireBeeperDevice(req({},d.token)),d.id);
 const stored=await one('SELECT token_hash FROM focus_auth.beeper_devices WHERE id=?',d.id);assert.equal(stored.token_hash,hash(d.token));assert.ok(!JSON.stringify(await exportData()).includes(d.token));
 const next=await device();await assert.rejects(b.requireBeeperDevice(req({},d.token)),/revoked/);await b.revokeBeeper();await assert.rejects(b.requireBeeperDevice(req({},next.token)),/revoked/);
});
test('device routes reject unauthenticated, browser-origin, unknown, and oversized requests',async()=>{
 assert.equal((await handleBeeperRequest(req({}), 'heartbeat')).status,401);
 const d=await device();assert.equal((await handleBeeperRequest(req({},d.token,{origin:'http://127.0.0.1:3210'}),'heartbeat')).status,403);
 assert.equal((await handleBeeperRequest(req({},d.token),'export')).status,404);
 assert.equal((await handleBeeperRequest(req({text:'x'.repeat(512*1024)},d.token),'batch')).status,413);
 process.env.XIN_ALLOWED_EMAIL='other@example.test';try{await assert.rejects(b.requireBeeperDevice(req({},d.token)),/revoked/);}finally{process.env.XIN_ALLOWED_EMAIL='owner@example.test';}
});
test('batches are selected, ordered, bounded, atomic, and safe to replay after a lost acknowledgment',async()=>{
 const d=await device(),u=await b.beginBeeperUpload(d.id,{request_id:randomUUID()}),records=[record()];
 const body={run_id:u.id,part:0,records};await b.appendBeeperBatch(d.id,body);await b.appendBeeperBatch(d.id,body);
 assert.equal((await one('SELECT count(*) AS n FROM import_records')).n,1);
 await assert.rejects(b.appendBeeperBatch(d.id,{...body,records:[record('different')]}),/position/);
 await assert.rejects(b.appendBeeperBatch(d.id,{...body,part:2}),/position/);
 const wrong={chat:{...chat,id:'not-selected'},message:{...message(),chatID:'not-selected'}};
 await assert.rejects(b.appendBeeperBatch(d.id,{run_id:u.id,part:1,records:[record('valid'),wrong]}),/not selected/);
 assert.equal((await one('SELECT record_count FROM beeper_uploads')).record_count,1);
 await assert.rejects(b.finishBeeperUpload(d.id,{run_id:u.id,parts:2}),/incomplete/);
 await b.finishBeeperUpload(d.id,{run_id:u.id,parts:1});await b.finishBeeperUpload(d.id,{run_id:u.id,parts:1});
 assert.equal((await one('SELECT state FROM sync_runs WHERE id=?',u.id)).state,'queued');
});
test('sleeping Macs keep uploads without launching a workflow; complete uploads use durable steps and contact extraction',async()=>{
 const d=await device(),u=await b.beginBeeperUpload(d.id,{request_id:randomUUID()});
 await run("UPDATE sync_runs SET updated_at=(now()-interval '3 days')::text WHERE id=?",u.id);
 assert.equal((await prepareDispatches()).length,0);assert.equal((await one('SELECT state FROM sync_runs WHERE id=?',u.id)).state,'uploading');
 await b.appendBeeperBatch(d.id,{run_id:u.id,part:0,records:[record()]});await b.finishBeeperUpload(d.id,{run_id:u.id,parts:1});
 const dispatch=(await prepareDispatches())[0];const outcome=await advanceDurableUnit('sync',u.id,dispatch.token,'fictional-workflow',0);assert.equal(outcome.done,true);
 const source=await one("SELECT * FROM sources WHERE provider='beeper'");await projectSource(source.id);
 const interaction=await one('SELECT * FROM interactions');assert.equal(interaction.kind,'message');assert.equal(interaction.direction,'inbound');assert.equal(interaction.qualified,true);
 assert.equal((await one('SELECT account FROM contact_identities')).account,chat.accountID);assert.equal((await one('SELECT count(*) AS n FROM import_records')).n,0);
 assert.equal((await one('SELECT review_requested FROM contact_runs')).review_requested,true);
});
test('group chats, missing ownership, bots, hidden messages, and reactions do not establish warmth',()=>{
 assert.throws(()=>b.normalizeBeeper({chat:{...chat,type:'group'},message:message()}),/direct message/);
 for(const transform of [r=>{r.raw.chat.participants.items[0].isSelf=false;},r=>{r.raw.chat.participants.items[1].isNetworkBot=true;},r=>{r.raw.message.isHidden=true;},r=>{r.raw.message.type='REACTION';}]){const r=b.normalizeBeeper(record());transform(r);assert.equal(extractInteraction(r.doc,r.raw,[]).qualified,false);}
 const r=b.normalizeBeeper(record());r.raw.message.isSender=true;r.raw.message.senderID='self';const e=extractInteraction(r.doc,r.raw,[]);assert.equal(e.direction,'outbound');assert.equal(e.qualified,true);
});
test('disconnect cancels a partial upload, removes staging, and frees Beeper independently of other imports',async()=>{
 const d=await device(),u=await b.beginBeeperUpload(d.id,{request_id:randomUUID()});await b.appendBeeperBatch(d.id,{run_id:u.id,part:0,records:[record()]});await b.revokeBeeper();
 assert.equal((await one('SELECT state FROM sync_runs WHERE id=?',u.id)).state,'failed');assert.equal((await all('SELECT * FROM import_records')).length,0);
 const fresh=await device();await b.beginBeeperUpload(fresh.id,{request_id:randomUUID()});
});
test('companion replays a saved batch after the cloud accepted it but its response was lost',async()=>{
 const d=await device(),config={...d,selection:[chat]},state={};let saved={},lost=false;
 const requestCloud=async(c,action,body)=>{const ops={heartbeat:b.beeperHeartbeat,start:b.beginBeeperUpload,batch:b.appendBeeperBatch,finish:b.finishBeeperUpload};const result=await ops[action](c.id,body);if(action==='batch'&&!lost){lost=true;throw Error('Lost response');}return result;};
 const requestLocal=async(_c,path)=>path.includes('/messages')?{items:[message()],hasMore:false}:chat;
 const options={requestCloud,requestLocal,save:async s=>{saved=structuredClone(s);}};
 await syncTick(config,state,options);await syncTick(config,state,options);
 await assert.rejects(syncTick(config,state,options),/Lost response/);
 const restarted=structuredClone(saved);assert.equal(restarted.run.part,0);await syncTick(config,restarted,options);assert.equal(restarted.run.part,1);
 await syncTick(config,restarted,options);assert.equal(restarted.run.sealed,true);assert.equal((await one('SELECT count(*) AS n FROM import_records')).n,1);
});
test('companion selection and pagination reject unsafe origins and stalled or invalid cursors',()=>{
 assert.throws(()=>focusOrigin('http://example.test'),/HTTPS/);assert.throws(()=>focusOrigin('https://token@example.test'),/HTTPS/);
 assert.deepEqual(chooseChats('1,1',[chat]),[chat]);assert.throws(()=>chooseChats('',[chat]),/numbers/);
 assert.throws(()=>pageProgress({items:[message()],hasMore:true,oldestCursor:'same'},'same',0),/advance/);
 assert.throws(()=>pageProgress({items:[{...message(),timestamp:'invalid'}],hasMore:false},null,0),/timestamp/);
 assert.equal(splitRecords(Array.from({length:51},(_,i)=>record('m'+i))).length,3);
});
