import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {all,one,run,upsertSource,saveItem,uid} from '../lib/db.mjs';
import {saveContact,contactDetail,listContacts,importContactsCsv,linkContactItem} from '../lib/contacts.mjs';
import {projectSource,extractInteraction,logInteraction,reviewInteraction,mailboxes} from '../lib/contact-extraction.mjs';
import {mergePreview,mergeContacts,undoMerge} from '../lib/contact-identity.mjs';
import {relationshipState} from '../lib/relationship-rules.mjs';
process.env.XIN_ALLOWED_EMAIL='owner@example.com';
const now=new Date('2026-09-15T12:00:00Z'),ago=n=>new Date(+now-n*86400000).toISOString();
const person={confirmed:true,tracked:true,cadence_days:30};
const event=(n,direction='inbound')=>({kind:'email',qualified:true,occurred_at:ago(n),direction});
test('cadence rules use event time, reciprocal exchanges, real coverage and deliberate pauses',()=>{
 const state=(c,i,fresh=true)=>relationshipState(c,i,{now,coverage:{fresh}}).state;
 assert.equal(state(person,[event(5)]),'New');assert.equal(state(person,[event(5),event(6,'outbound')]),'Active');
 assert.equal(state(person,[event(30)]),'Active');assert.equal(state(person,[event(31)]),'Cooling');assert.equal(state(person,[event(91)]),'Dormant');
 assert.equal(state(person,[event(31)],false),'Unclassified');assert.equal(state(person,[event(80,'outbound')]),'Unclassified');
 assert.equal(state(person,[event(80),event(0,'outbound')]),'Cooling');assert.equal(state({...person,paused:true},[event(2)]),'Paused');
 assert.equal(state({...person,do_not_contact:true},[event(2)]),'Paused');assert.equal(state({...person,tracked:false},[event(2)]),'Unclassified');
 assert.equal(state(person,[{...event(0),duplicate_status:'review',duplicate_of:'x'}]),'Unclassified');
 assert.equal(state(person,[event(-1)]),'Unclassified');
});
test('manual contacts support dated affiliations, optimistic edits, archive and exact CSV quoting',async()=>{
 const c=await saveContact({name:'Avery Chen',email:'avery@example.com',organization:'North Studio',role:'Founder',started_on:'2020-02-01',ended_on:'2025-01-01',tracked:true});
 const detail=await contactDetail(c.id);assert.equal(detail.affiliations[0].organization,'North Studio');assert.equal(detail.affiliations[0].ended_on,'2025-01-01');
 const edited=await saveContact({...c,role:'Advisor',organization:'South Studio'});await assert.rejects(saveContact({...c,name:'Stale'}),/changed/);
 assert.equal((await contactDetail(c.id)).affiliations.length,2);
 const archived=await saveContact({...edited,archived:true});assert.equal((await listContacts({archived:true})).total,1);await saveContact({...archived,archived:false});
 const csv='name,email,company,notes,tags\n"River, Sam",sam@example.com,"East, Inc.","Met at conference\nand spoke again",Partner;Peer';
 assert.equal((await importContactsCsv(csv)).added,1);assert.equal((await importContactsCsv(csv)).added,0);
 assert.equal((await listContacts({q:'River'})).records[0].notes,'Met at conference\nand spoke again');
});
const gmail=(id,from,to,extra=[])=>({id,threadId:'thread-'+id,internalDate:String(Date.now()-86400000),payload:{headers:[{name:'From',value:from},{name:'To',value:to},...extra]}});
async function email(id,from,to,extra=[]){const raw=gmail(id,from,to,extra),s=await upsertSource({provider:'gmail',external_id:id,title:'Conversation '+id,occurred_at:new Date(Number(raw.internalDate)).toISOString(),coverage:'email body',body:'A real fictional exchange about the next design review.'},raw);await projectSource(s.id);return s.id;}
test('proper mailbox parsing handles quoted names and groups; newsletters and CC do not warm',()=>{
 assert.equal(mailboxes('"Chen, Avery" <avery@example.com>, Team: Lee <lee@example.com>;').length,2);
 const source={provider:'gmail',body:'Hello',coverage:'email body'};
 assert.equal(extractInteraction(source,gmail('1','news@example.com','owner@example.com',[{name:'List-Id',value:'daily'}]),['owner@example.com']).qualified,false);
 assert.equal(extractInteraction(source,gmail('2','avery@example.com','lee@example.com',[{name:'Cc',value:'owner@example.com'}]),['owner@example.com']).qualified,false);
 const group=extractInteraction(source,gmail('group','sender@example.com','owner@example.com, bystander@example.com'),['owner@example.com']);assert.equal(group.participants.find(p=>p.address==='bystander@example.com').role,'cc');
 const undated=gmail('3','avery@example.com','owner@example.com');delete undated.internalDate;assert.equal(extractInteraction(source,undated,['owner@example.com']).occurred_at,null);
});
test('source projection is idempotent, preserves source versions and flags identity overlap for review',async()=>{
 const source=await email('mail-1','Avery Chen <avery@example.com>','Owner <owner@example.com>');
 const count=(await one('SELECT count(*) AS n FROM contacts')).n;await projectSource(source);assert.equal((await one('SELECT count(*) AS n FROM contacts')).n,count);
 const identity=await one("SELECT * FROM contact_identities WHERE provider='gmail' AND address='avery@example.com'");const detail=await contactDetail(identity.contact_id);
 assert.equal(detail.confirmed,false);assert.equal(detail.interactions.length,1);assert.ok(detail.interactions[0].citations[0].source_version_id);
 assert.ok((await one("SELECT count(*) AS n FROM identity_reviews WHERE status='pending'")).n>0);
 assert.equal((await one('SELECT state FROM contact_queue WHERE source_id=?',source)).state,'complete');
});
test('same names without provider IDs remain recording-scoped, and two recordings do not double count',async()=>{
 const input={title:'Strategy meeting',occurred_at:new Date().toISOString(),coverage:'transcript',body:'Lee: We discussed next month’s release.'};
 const raw={participants:['owner@example.com','Lee <lee@example.com>']};
 for(const provider of ['fireflies','granola']){const s=await upsertSource({...input,provider,external_id:'duplicate-test'},raw);await projectSource(s.id);}
 const duplicate=await one("SELECT * FROM interactions WHERE duplicate_status='review'");assert.ok(duplicate);await reviewInteraction({id:duplicate.id,version:duplicate.version,action:'duplicate'});assert.equal((await one('SELECT duplicate_status FROM interactions WHERE id=?',duplicate.id)).duplicate_status,'confirmed');
 for(const n of [1,2]){const s=await upsertSource({...input,provider:'fireflies',external_id:'names-'+n},{sentences:[{speaker_name:'Taylor',text:'Hello'}]});await projectSource(s.id);}
 assert.equal((await one("SELECT count(*) AS n FROM contacts WHERE name='Taylor'")).n,2);
});
test('merge previews are checked, merges preserve links and privacy preferences, undo restores records',async()=>{
 const target=await saveContact({name:'Merge Target'}),source=await saveContact({name:'Merge Source',do_not_contact:true});
 await logInteraction({contact_id:source.id,kind:'meeting',direction:'mutual',meaningful:true,occurred_at:new Date().toISOString(),body:'Reviewed the fictional roadmap.'});
 const item=await saveItem({title:'Review roadmap'});await linkContactItem({contact_id:source.id,item_id:item.id});
 const preview=await mergePreview(target.id,source.id);await assert.rejects(mergeContacts({target_id:target.id,source_id:source.id,token:'old'}),/changed/);
 const merged=await mergeContacts({target_id:target.id,source_id:source.id,token:preview.token});
 assert.equal((await contactDetail(target.id)).items[0].id,item.id);assert.equal((await contactDetail(target.id)).do_not_contact,true);
 await undoMerge(merged.id);assert.equal((await contactDetail(source.id)).items.length,1);assert.equal((await contactDetail(target.id)).items.length,0);
});
test('concurrent acceptance cannot exceed three active outcomes, including contact follow-ups',async()=>{
 await run("UPDATE items SET status='done'");const c=await saveContact({name:'Capacity Person'});
 const outcomes=await Promise.allSettled(Array.from({length:4},(_,i)=>saveItem({title:'Output '+i,status:'now',done_when:'Reviewed brief',next_action:'Write a draft',owner:'Owner',checkpoint:'2026-12-01',contact_ids:[c.id]})));
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,3);assert.equal((await one("SELECT count(*) AS n FROM items WHERE status='now'")).n,3);assert.equal((await contactDetail(c.id)).items.length,3);
});
