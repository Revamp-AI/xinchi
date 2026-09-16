import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {all,one,run,uid,upsertSource,saveItem} from '../lib/db.mjs';
import {saveContact,contactDetail,listContacts,importContactsCsv,saveDraft,linkContactItem} from '../lib/contacts.mjs';
import {projectSource,logInteraction} from '../lib/contact-extraction.mjs';
import {reconcileEmailContacts,resolveExactEmailContact,undoMerge} from '../lib/contact-identity.mjs';
import {emailAddress,personalEmail} from '../lib/contact-email.mjs';
process.env.XIN_ALLOWED_EMAIL='owner@example.com';

async function source(provider,email,name,id=uid()){
 const time=new Date(Date.now()-86400000).toISOString();
 const raw=provider==='gmail'?{id,threadId:id,internalDate:String(Date.parse(time)),payload:{headers:[{name:'From',value:`${name} <${email}>`},{name:'To',value:'owner@example.com'}]}}:{participants:[{email:'owner@example.com'},{email,name}],dateString:time};
 return(await upsertSource({provider,external_id:id,title:'Fictional conversation '+id,occurred_at:time,coverage:provider==='gmail'?'email body':'transcript',body:'A fictional discussion with a cited source.'},raw)).id;
}
// Seed legacy duplicates directly: new contact creation now rejects duplicate emails.
async function legacy(name,email,provider='gmail',extra={}){
 const id=uid();await run('INSERT INTO contacts(id,name,email,confirmed,notes,tags,do_not_contact,paused,tracked,archived,cadence_days,snoozed_until) VALUES(?,?,?,?,?,?::jsonb,?,?,?,?,?,?)',id,name,email,extra.confirmed??false,extra.notes||'',JSON.stringify(extra.tags||[]),!!extra.do_not_contact,!!extra.paused,!!extra.tracked,!!extra.archived,extra.cadence_days||30,extra.snoozed_until||null);
 await run('INSERT INTO contact_identities(id,contact_id,provider,account,external_key,display_name,address) VALUES(?,?,?,?,?,?,?)',uid(),id,provider,'owner@example.com',email.trim().toLowerCase(),name,email);
 return await one('SELECT * FROM contacts WHERE id=?',id);
}
async function separate(a,b){const [left,right]=[a.id,b.id].sort();await run("INSERT INTO identity_reviews(id,left_id,right_id,reason,status) VALUES(?,?,?,'User decision','separate')",uid(),left,right);}

test('provider and account bindings share exact normalized emails and retain searchable aliases',async()=>{
 const id1=await source('gmail','MATCH@example.com','Maya Lee');await projectSource(id1);
 const id2=await source('fireflies',' match@example.com ','mayalee');await projectSource(id2);
 const id3=await source('granola','match@example.com','Maya');await projectSource(id3);
 const rows=await all("SELECT * FROM contacts WHERE email='match@example.com' AND merged_into IS NULL");assert.equal(rows.length,1);
 const detail=await contactDetail(rows[0].id);assert.equal(detail.name,'Maya Lee');assert.equal(detail.identities.length,3);assert.equal(detail.interactions.length,3);assert.equal(detail.confirmed,false);assert.equal(detail.tracked,false);
 assert.ok(detail.interactions.every(i=>i.citations.length===1));assert.equal((await listContacts({q:'mayalee'})).records[0].id,detail.id);
 for(const id of [id1,id2,id3])await projectSource(id);assert.equal((await contactDetail(detail.id)).identities.length,3);
 assert.equal((await one('SELECT count(*) n FROM identity_reviews WHERE left_id=? OR right_id=?',detail.id,detail.id)).n,0);
});
test('concurrent providers cannot create duplicate profiles',async()=>{
 const ids=await Promise.all(['gmail','fireflies','granola'].map(provider=>source(provider,'concurrent@example.com','Concurrent Person')));
 await Promise.all(ids.map(id=>projectSource(id)));
 assert.equal((await one("SELECT count(*) n FROM contacts WHERE email='concurrent@example.com' AND merged_into IS NULL")).n,1);
});
test('a descriptive name replaces an untouched email fallback while maintained names and preferences survive',async()=>{
 await projectSource(await source('fireflies','fallback@example.com','fallback@example.com'));
 await projectSource(await source('gmail','fallback@example.com','Faye Brooks'));
 assert.equal((await resolveExactEmailContact('fallback@example.com')).name,'Faye Brooks');
 const c=await saveContact({name:'My chosen name',email:'chosen@example.com',notes:'Private context',paused:true,do_not_contact:true,tracked:true});
 await projectSource(await source('granola','chosen@example.com','Different source name'));
 const detail=await contactDetail(c.id);assert.equal(detail.name,c.name);assert.equal(detail.notes,c.notes);assert.equal(detail.paused,true);assert.equal(detail.do_not_contact,true);assert.equal(detail.tracked,true);
 await assert.rejects(saveContact({name:'Duplicate',email:' CHOSEN@example.com '}),/already exists/);
});
test('CSV reuses the contact, combines notes and tags, and keeps imported names as aliases',async()=>{
 const c=await saveContact({name:'Riley Brooks',email:'csvmatch@example.com',notes:'Existing note',tags:['Peer'],paused:true});
 const csv='name,email,notes,tags\nRB,CSVMATCH@example.com,Imported note,Partner';
 assert.deepEqual(await importContactsCsv(csv),{total:1,added:0,matched:1});
 assert.deepEqual(await importContactsCsv(csv),{total:1,added:0,matched:0});
 const detail=await contactDetail(c.id);assert.equal(detail.name,'Riley Brooks');assert.equal(detail.notes,'Existing note\n\nImported note');assert.deepEqual(detail.tags,['Peer','Partner']);assert.equal(detail.paused,true);assert.equal(detail.identities[0].display_name,'RB');
});
test('legacy cleanup is dry-run safe, idempotent, and preserves links, evidence, notes and restrictive preferences',async()=>{
 const a=await legacy('Yara Wang','repair@example.com','gmail',{notes:'First note',tags:['Peer']});
 const b=await legacy('Repair',' REPAIR@example.com ','granola',{notes:'Second note',tags:['Partner'],do_not_contact:true,paused:true,tracked:true,snoozed_until:'2027-01-01',cadence_days:45});
 const c=await legacy('repair@example.com','repair@example.com','fireflies');
 await logInteraction({contact_id:b.id,kind:'meeting',direction:'mutual',meaningful:true,occurred_at:new Date().toISOString(),body:'Fictional legacy evidence.'});
 const item=await saveItem({title:'Fictional commitment'});await linkContactItem({contact_id:b.id,item_id:item.id});
 await run('INSERT INTO organizations(id,name) VALUES(?,?)','repair-org','Fictional Studio');await run('INSERT INTO affiliations(id,contact_id,organization_id) VALUES(?,?,?)',uid(),b.id,'repair-org');
 await saveDraft({contact_id:c.id,subject:'Fictional draft',body:'Keep this draft.'});
 const before=await one('SELECT count(*) n FROM sources'),versions=await one('SELECT count(*) n FROM source_versions');
 assert.equal((await reconcileEmailContacts()).merged,2);assert.equal((await one('SELECT merged_into FROM contacts WHERE id=?',b.id)).merged_into,null);
 const applied=await reconcileEmailContacts({apply:true});assert.equal(applied.merged,2);
 const detail=await contactDetail(a.id);assert.equal(detail.identities.length,3);assert.equal(detail.interactions.length,1);assert.equal(detail.items[0].id,item.id);assert.equal(detail.affiliations.length,1);assert.equal(detail.drafts[0].body,'Keep this draft.');
 assert.equal(detail.notes,'First note\n\nSecond note');assert.deepEqual(detail.tags,['Peer','Partner']);assert.equal(detail.do_not_contact,true);assert.equal(detail.paused,true);assert.equal(detail.tracked,true);assert.equal(detail.snoozed_until,'2027-01-01');assert.equal(detail.cadence_days,45);assert.equal(detail.confirmed,false);
 assert.equal((await one('SELECT count(*) n FROM sources')).n,before.n);assert.equal((await one('SELECT count(*) n FROM source_versions')).n,versions.n);
 assert.equal((await reconcileEmailContacts({apply:true})).merged,0);
 assert.equal((await one('SELECT merged_into FROM contacts WHERE id=?',b.id)).merged_into,a.id);
});
test('automatic reconciliation keeps an archived mailbox archived',async()=>{
 const a=await legacy('Archived Person','archived-match@example.com','gmail',{archived:true,do_not_contact:true});
 await legacy('archived-match','archived-match@example.com','granola');
 const match=await resolveExactEmailContact(a.email);assert.equal(match.id,a.id);assert.equal(match.archived,true);assert.equal(match.do_not_contact,true);
 await projectSource(await source('fireflies',a.email,'Another name'));assert.equal((await resolveExactEmailContact(a.email)).archived,true);
});
test('undo restores an automatic pair and prevents imports from immediately merging it again',async()=>{
 const a=await legacy('Uma Rivera','undo-match@example.com','gmail'),b=await legacy('undo-match','undo-match@example.com','granola');
 await resolveExactEmailContact(a.email);
 const decision=await one('SELECT * FROM identity_decisions WHERE left_id=? AND right_id=?',a.id,b.id);assert.ok(decision.before_snapshot.automatic_email);
 await undoMerge(decision.id);assert.equal((await one('SELECT merged_into FROM contacts WHERE id=?',b.id)).merged_into,null);
 assert.equal(await resolveExactEmailContact(a.email),null);
 await projectSource(await source('gmail',a.email,'Uma Rivera'));
 assert.equal((await one('SELECT merged_into FROM contacts WHERE id=?',b.id)).merged_into,null);
});
test('explicit separations and conflicting maintained profiles remain reviewable',async()=>{
 const a=await legacy('Separate A','separate@example.com','gmail'),b=await legacy('Separate B','separate@example.com','granola');await separate(a,b);
 assert.equal(await resolveExactEmailContact(a.email),null);
 await legacy('Maintained A','conflict@example.com','gmail',{confirmed:true});await legacy('Maintained B','conflict@example.com','granola',{confirmed:true});
 assert.equal(await resolveExactEmailContact('conflict@example.com'),null);
});
test('shared mailboxes, names, dots and plus-tags are never silently treated as personal-email matches',async()=>{
 assert.equal(emailAddress(' Person <FOO@example.com> '),'foo@example.com');assert.equal(personalEmail('support@example.com'),'');
 await legacy('Support A','support@example.com','gmail');await legacy('Support B','support@example.com','granola');assert.equal(await resolveExactEmailContact('support@example.com'),null);
 for(const address of ['sam@example.com','s.am@example.com','sam+work@example.com'])await projectSource(await source('gmail',address,'Sam'));
 assert.equal((await all("SELECT id FROM contacts WHERE name='Sam' AND merged_into IS NULL")).length,3);
});
test('a known provider binding repairs old exact-email duplicates and keeps unrelated review suggestions',async()=>{
 const a=await legacy('Old Binding','old-binding@example.com','gmail'),b=await legacy('old-binding','old-binding@example.com','granola'),third=await saveContact({name:'Old Binding',email:'different-person@example.com'});
 const [left,right]=[b.id,third.id].sort();await run("INSERT INTO identity_reviews(id,left_id,right_id,reason) VALUES(?,?,?,'Similar name')",uid(),left,right);
 await projectSource(await source('gmail',a.email,'Old Binding'));
 assert.equal((await one('SELECT merged_into FROM contacts WHERE id=?',b.id)).merged_into,a.id);
 const pair=[a.id,third.id].sort();assert.equal((await one('SELECT status FROM identity_reviews WHERE left_id=? AND right_id=?',...pair)).status,'pending');
});
test('a stable provider identity can gain an email later and join an existing contact',async()=>{
 const c=await saveContact({name:'Late Email Person',email:'late-email@example.com'}),old=await legacy('late-email','','beeper');
 await run("UPDATE contact_identities SET external_key='peer-1',account='beeper-account' WHERE contact_id=?",old.id);
 const raw={chat:{id:'chat-1',accountID:'beeper-account',type:'single',participants:{hasMore:false,items:[{id:'self-1',isSelf:true},{id:'peer-1',isSelf:false,email:c.email,fullName:'Late Email Person'}]}},message:{id:'message-1',senderID:'peer-1',isSender:false,timestamp:new Date().toISOString(),text:'A fictional conversation.'}};
 const s=await upsertSource({provider:'beeper',external_id:'late-email-message',title:'Fictional direct chat',occurred_at:raw.message.timestamp,coverage:'message body',body:raw.message.text},raw);await projectSource(s.id);
 assert.equal((await one('SELECT merged_into FROM contacts WHERE id=?',old.id)).merged_into,c.id);
 assert.equal((await contactDetail(c.id)).identities[0].address,c.email);
});
test('an email group rolls back all merges if any linked record update fails',async()=>{
 const a=await legacy('Atomic Person','atomic@example.com','gmail');await legacy('atomic','atomic@example.com','granola');await legacy('Blocker','atomic@example.com','fireflies');
 await run("CREATE FUNCTION reject_fixture_merge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.email='atomic@example.com' AND OLD.name='Blocker' AND NEW.merged_into IS NOT NULL THEN RAISE EXCEPTION 'fixture rejected merge'; END IF; RETURN NEW; END $$");
 await run('CREATE TRIGGER reject_fixture_merge BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION reject_fixture_merge()');
 try{await assert.rejects(resolveExactEmailContact(a.email),/fixture rejected/);}finally{await run('DROP TRIGGER reject_fixture_merge ON contacts');await run('DROP FUNCTION reject_fixture_merge()');}
 assert.equal((await one('SELECT count(*) n FROM contacts WHERE email=? AND merged_into IS NULL',a.email)).n,3);
 assert.equal((await one('SELECT count(*) n FROM identity_decisions WHERE left_id=?',a.id)).n,0);
 await resolveExactEmailContact(a.email);
});
test('overlapping event participants retain meaningful evidence and undo restores both roles',async()=>{
 const a=await legacy('Role Person','roles@example.com','gmail'),b=await legacy('roles','roles@example.com','granola');
 await logInteraction({contact_id:b.id,kind:'meeting',direction:'mutual',meaningful:true,occurred_at:new Date().toISOString(),body:'Fictional evidence.'});
 const event=await one('SELECT interaction_id FROM interaction_participants WHERE contact_id=?',b.id);
 await run("INSERT INTO interaction_participants VALUES(?,?,'cc')",event.interaction_id,a.id);
 await resolveExactEmailContact(a.email);
 assert.equal((await one('SELECT role FROM interaction_participants WHERE interaction_id=? AND contact_id=?',event.interaction_id,a.id)).role,'participant');
 const decision=await one('SELECT id FROM identity_decisions WHERE left_id=? AND right_id=?',a.id,b.id);await undoMerge(decision.id);
 assert.equal((await all('SELECT contact_id FROM interaction_participants WHERE interaction_id=?',event.interaction_id)).length,2);
});
