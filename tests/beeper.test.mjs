import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
process.env.XIN_AGENT_MODE='cloud';process.env.XIN_ALLOWED_EMAIL='owner@example.test';
const {all,one,run,hash,exportData,upsertSource}=await import('../lib/db.mjs');
const b=await import('../lib/beeper.mjs');
const {handleBeeperRequest}=await import('../lib/beeper-route.mjs');
const {prepareDispatches,advanceDurableUnit}=await import('../lib/durable-ingestion.mjs');
const {extractInteraction,projectSource}=await import('../lib/contact-extraction.mjs');
const {repairBeeperContactNames}=await import('../lib/beeper-contact-repair.mjs');
const {suggestIdentityMatches}=await import('../lib/contacts.mjs');
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
test('pairing accepts a full 1,732-conversation selection over 512 KiB and imports the final conversation',async()=>{
 const selection=Array.from({length:1732},(_,i)=>({...chat,id:'chat-'+i,title:'Fictional conversation '+String(i).padEnd(270,'.')}));
 const {code}=await b.createBeeperPairing(),body={code,label:'Fictional Mac',selection:selection.map(({id,accountID,title,network})=>({id,accountID,title,network}))};
 assert.ok(Buffer.byteLength(JSON.stringify(body))>512*1024);
 const response=await handleBeeperRequest(req(body),'pair');assert.equal(response.status,201);
 const d=await response.json(),stored=await one('SELECT selection FROM focus_auth.beeper_devices WHERE id=?',d.id);
 assert.equal(stored.selection.length,1732);assert.equal(stored.selection.at(-1).id,selection.at(-1).id);
 const u=await b.beginBeeperUpload(d.id,{request_id:randomUUID()}),last=selection.at(-1);
 await b.appendBeeperBatch(d.id,{run_id:u.id,part:0,records:[{chat:last,message:{...message(),chatID:last.id}}]});
 assert.equal((await one('SELECT count(*) AS n FROM import_records')).n,1);
 await assert.rejects(b.appendBeeperBatch(d.id,{run_id:u.id,part:1,records:[{chat:{...chat,id:'outside-selection'},message:{...message(),chatID:'outside-selection'}}]}),/not selected/);
});
test('pairing still rejects empty, duplicate, invalid, and oversized selections without consuming the code',async()=>{
 const {code}=await b.createBeeperPairing(),body={code,label:'Fictional Mac'};
 for(const selection of [[],[chat,chat],[{...chat,id:''}]])await assert.rejects(b.pairBeeper({...body,selection}));
 const large={...body,selection:[chat],padding:'x'.repeat(4*1024*1024)};
 for(const headers of [{},{'content-length':String(4*1024*1024+1)}]){
  const response=await handleBeeperRequest(req(large,null,headers),'pair');assert.equal(response.status,413);
  assert.match((await response.json()).error,/setup --choose/);
 }
 assert.equal((await handleBeeperRequest(req({...body,selection:[chat]}),'pair')).status,201);
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
 const contact=await one("SELECT c.confirmed,c.tracked,s.state FROM contacts c JOIN contact_states s ON s.contact_id=c.id JOIN contact_identities i ON i.contact_id=c.id WHERE i.provider='beeper'");
 assert.equal(contact.confirmed,false);assert.equal(contact.tracked,false);assert.equal(contact.state,'New');
 assert.equal((await one('SELECT review_requested FROM contact_runs')).review_requested,true);
});
test('group chats, missing ownership, bots, hidden messages, and reactions do not establish warmth',()=>{
 assert.throws(()=>b.normalizeBeeper({chat:{...chat,type:'group'},message:message()}),/direct message/);
 for(const transform of [r=>{r.raw.chat.participants.items[0].isSelf=false;},r=>{r.raw.chat.participants.items[1].isNetworkBot=true;},r=>{r.raw.message.isHidden=true;},r=>{r.raw.message.type='REACTION';}]){const r=b.normalizeBeeper(record());transform(r);assert.equal(extractInteraction(r.doc,r.raw,[]).qualified,false);}
 const r=b.normalizeBeeper(record());r.raw.message.isSender=true;r.raw.message.senderID='self';const e=extractInteraction(r.doc,r.raw,[]);assert.equal(e.direction,'outbound');assert.equal(e.qualified,true);
});
test('unnamed Beeper peers use their direct-chat titles, never the outgoing owner name',async()=>{
 for(const [id,title] of [['avery','Avery Fixture'],['blake','Blake Fixture']]){
  const c={...chat,id, title,participants:{hasMore:false,items:[chat.participants.items[0],{id,fullName:'',isSelf:false}]}},m={...message(id),chatID:id,senderID:'self',senderName:'+1 202-555-0100',isSender:true};
  const r=b.normalizeBeeper({chat:c,message:m}),s=await upsertSource(r.doc,r.raw);
  await projectSource(s.id);await projectSource(s.id);
  const reply=b.normalizeBeeper({chat:c,message:{...m,id:id+'-reply',senderID:id,senderName:'Another sender label',isSender:false}});
  await projectSource((await upsertSource(reply.doc,reply.raw)).id);
 }
 assert.deepEqual((await all('SELECT name FROM contacts ORDER BY name')).map(c=>c.name),['Avery Fixture','Blake Fixture']);
 assert.equal((await one('SELECT count(*) AS n FROM contact_identities')).n,2);
 assert.equal((await one('SELECT count(*) AS n FROM identity_reviews')).n,0);
 assert.equal((await one("SELECT count(*) AS n FROM contact_states WHERE state='Active'")).n,2);
 const r=b.normalizeBeeper(record());r.raw.chat.title='Direct conversation';r.raw.chat.participants.items[1].fullName='';
 assert.equal(extractInteraction(r.doc,r.raw,[]).participants[0].name,'Fictional colleague');
 r.raw.message.isSender=true;r.raw.message.senderID='self';r.raw.message.senderName='Owner';
 assert.equal(extractInteraction(r.doc,r.raw,[]).participants[0].name,'peer@example.test');
 r.raw.chat.participants.items[1].email='';
 assert.equal(extractInteraction(r.doc,r.raw,[]).participants[0].name,'Beeper contact');
});
test('self conversations and unresolved participant ownership do not create peer profiles',async()=>{
 for(const isSender of [false,true]){
  const r=b.normalizeBeeper({chat:{...chat,participants:{hasMore:false,items:[{id:'self',isSelf:false}]}},message:{...message('self-'+isSender),senderID:'self',senderName:'Owner',isSender}});
  assert.deepEqual(extractInteraction(r.doc,r.raw,[]).participants,[]);
  await projectSource((await upsertSource(r.doc,r.raw)).id);
 }
 const r=b.normalizeBeeper(record());r.raw.chat.participants.items[0].isSelf=false;
 assert.deepEqual(extractInteraction(r.doc,r.raw,[]).participants,[]);
 assert.equal((await one('SELECT count(*) AS n FROM contacts')).n,0);
 assert.equal((await one('SELECT count(*) AS n FROM sources')).n,2);
});
test('Beeper label repair preserves distinct identities, user edits and evidence, and retires false matches',async()=>{
 const ownerName='+1 202-555-0100',profiles=[];
 for(const [id,title] of [['avery','Avery Fixture'],['blake','Blake Fixture'],['custom','Custom Fixture']]){
  const c={...chat,id,title,participants:{hasMore:false,items:[chat.participants.items[0],{id,isSelf:false,fullName:''}]}};
  const r=b.normalizeBeeper({chat:c,message:{...message(id),chatID:id,senderID:'self',senderName:ownerName,isSender:true}});
  await projectSource((await upsertSource(r.doc,r.raw)).id);
  const contact=await one('SELECT contact_id FROM contact_identities WHERE external_key=?',id);
  await run('UPDATE contacts SET name=? WHERE id=?',ownerName,contact.contact_id);
  await run('UPDATE contact_identities SET display_name=? WHERE contact_id=?',ownerName,contact.contact_id);
  profiles.push(contact.contact_id);
 }
 await run('UPDATE contacts SET tracked=true,version=2 WHERE id=?',profiles[2]);
 // Legacy self profiles could be created from incoming messages lacking an isSelf marker.
 const self=b.normalizeBeeper({chat:{...chat,id:'self-chat',title:ownerName,participants:{hasMore:false,items:[{id:'self',isSelf:false}]}},message:{...message('self-message'),chatID:'self-chat',senderID:'self',senderName:ownerName,isSender:false}});
 const source=await upsertSource(self.doc,self.raw);await projectSource(source.id);
 await run('INSERT INTO contacts(id,name,confirmed) VALUES(?,?,false)','self-profile',ownerName);
 await run("INSERT INTO contact_identities(id,contact_id,provider,account,external_key,display_name,source_id) VALUES('self-identity','self-profile','beeper',?,'self',?,?)",chat.accountID,ownerName,source.id);
 await run("INSERT INTO interaction_participants SELECT id,'self-profile','uncertain' FROM interactions WHERE source_id=?",source.id);
 for(const id of [...profiles,'self-profile'])await suggestIdentityMatches(id,ownerName,'');
 const separate=await one('SELECT id FROM identity_reviews WHERE (left_id=? AND right_id=?) OR (left_id=? AND right_id=?)',profiles[0],profiles[2],profiles[2],profiles[0]);
 await run("UPDATE identity_reviews SET status='separate' WHERE id=?",separate.id);
 const identities=await all('SELECT id,contact_id,external_key FROM contact_identities ORDER BY id'),evidence=await all('SELECT id,raw_json FROM source_versions ORDER BY id');
 const preview=await repairBeeperContactNames();assert.equal(preview.renamed,2);assert.equal(preview.archived_self_profiles,1);assert.equal(preview.skipped_customized,1);assert.equal(preview.obsolete_name_reviews,5);
 assert.equal((await one('SELECT name FROM contacts WHERE id=?',profiles[0])).name,ownerName);
 const repaired=await repairBeeperContactNames({apply:true});assert.equal(repaired.renamed,2);
 assert.deepEqual((await all('SELECT name FROM contacts WHERE id=ANY(?::text[]) ORDER BY name',profiles.slice(0,2))).map(c=>c.name),['Avery Fixture','Blake Fixture']);
 assert.equal((await one("SELECT archived FROM contacts WHERE id='self-profile'")).archived,true);
 assert.equal((await one('SELECT name FROM contacts WHERE id=?',profiles[2])).name,ownerName);
 assert.equal((await one('SELECT tracked FROM contacts WHERE id=?',profiles[2])).tracked,true);
 assert.equal((await one('SELECT status FROM identity_reviews WHERE id=?',separate.id)).status,'separate');
 assert.equal((await one("SELECT count(*) AS n FROM identity_reviews WHERE status='obsolete'")).n,5);
 assert.deepEqual(await all('SELECT id,contact_id,external_key FROM contact_identities ORDER BY id'),identities);
 assert.deepEqual(await all('SELECT id,raw_json FROM source_versions ORDER BY id'),evidence);
 assert.equal((await one('SELECT count(*) AS n FROM contacts WHERE confirmed OR merged_into IS NOT NULL')).n,0);
 for(const s of await all("SELECT id FROM sources WHERE provider='beeper'"))await projectSource(s.id);
 assert.equal((await one('SELECT name FROM contacts WHERE id=?',profiles[0])).name,'Avery Fixture');
 assert.equal((await one('SELECT count(*) AS n FROM contacts')).n,4);
 const repeat=await repairBeeperContactNames({apply:true});assert.equal(repeat.renamed,0);assert.equal(repeat.archived_self_profiles,0);assert.equal(repeat.obsolete_name_reviews,0);
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
 assert.deepEqual(chooseChats('1,1',[chat]),[chat]);assert.deepEqual(chooseChats('',[chat]),[chat]);assert.throws(()=>chooseChats('0',[chat]),/numbers/);
 assert.throws(()=>pageProgress({items:[message()],hasMore:true,oldestCursor:'same'},'same',0),/advance/);
 assert.throws(()=>pageProgress({items:[{...message(),timestamp:'invalid'}],hasMore:false},null,0),/timestamp/);
 assert.equal(splitRecords(Array.from({length:51},(_,i)=>record('m'+i))).length,3);
});
