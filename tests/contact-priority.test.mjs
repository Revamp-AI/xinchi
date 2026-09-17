import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {all,one,run,hash} from '../lib/db.mjs';
import {saveContact,contactDetail,listContacts,importContactsCsv} from '../lib/contacts.mjs';
import {mergePreview,mergeContacts,undoMerge} from '../lib/contact-identity.mjs';
import {callContextTool} from '../lib/context-tools.mjs';

test('priority is explicit, versioned, and survives edits and exact-email imports without changing restrictions',async()=>{
 const c=await saveContact({name:'Priority Preference',email:'priority@example.com',paused:true,do_not_contact:true,cadence_days:90});
 assert.equal(c.priority,false);
 await assert.rejects(saveContact({id:c.id,version:c.version,priority:'false'}),/Priority must/);
 const starred=await saveContact({id:c.id,version:c.version,priority:true});
 assert.equal(starred.priority,true);assert.equal(starred.paused,true);assert.equal(starred.do_not_contact,true);assert.equal(starred.tracked,false);assert.equal(starred.cadence_days,90);
 assert.equal((await contactDetail(c.id)).relationship.state,'Paused');
 await assert.rejects(saveContact({id:c.id,version:c.version,priority:false}),/changed/);
 await importContactsCsv('name,email,role\nPriority Import,priority@example.com,Advisor');
 const imported=await contactDetail(c.id);assert.equal(imported.priority,true);
 const edited=await saveContact({id:c.id,version:imported.version,notes:'A maintained note.'});assert.equal(edited.priority,true);
 assert.equal((await saveContact({id:c.id,version:edited.version,priority:false})).priority,false);
});

test('priority sorting and combined filters apply before pagination and the map sample limit',async()=>{
 for(let n=0;n<17;n++)await saveContact({name:'Priority Sample A'+String(n).padStart(2,'0')});
 const starred=await saveContact({name:'Priority Sample Z',priority:true,tags:['Partner']});
 const first=await listContacts({q:'Priority Sample',limit:1});
 assert.equal(first.total,18);assert.equal(first.records[0].id,starred.id);assert.equal(first.map_records.length,15);assert.equal(first.map_records[0].id,starred.id);
 assert.notEqual((await listContacts({q:'Priority Sample',limit:1,offset:1})).records[0].id,starred.id);
 const filtered=await listContacts({q:'Priority Sample',priority:'true',tag:'Partner',segment:'Unclassified'});
 assert.equal(filtered.total,1);assert.equal(filtered.counts.Unclassified,1);assert.equal(filtered.records[0].id,starred.id);
 assert.equal((await listContacts({q:'Priority Sample',priority:'false'})).total,18);
 assert.equal((await listContacts({q:'Priority Sample',priority:true,tag:'Customer'})).total,0);
 const tool=await callContextTool('search_contacts',{query:'Priority Sample',priority:true});assert.deepEqual(tool.records.map(c=>c.id),[starred.id]);
});

test('merges preserve priority from either profile and undo restores both original preferences',async()=>{
 for(const [targetPriority,sourcePriority] of [[false,true],[true,false]]){
  const a=await saveContact({name:'Priority Kept',priority:targetPriority}),b=await saveContact({name:'Priority Moved',priority:sourcePriority});
  const p=await mergePreview(a.id,b.id),decision=await mergeContacts({target_id:a.id,source_id:b.id,token:p.token});
  assert.equal((await contactDetail(a.id)).priority,true);await undoMerge(decision.id);
  assert.equal((await contactDetail(a.id)).priority,targetPriority);assert.equal((await contactDetail(b.id)).priority,sourcePriority);
 }
});

test('priority edits after a merge are protected from undo',async()=>{
 const a=await saveContact({name:'Priority Fence A'}),b=await saveContact({name:'Priority Fence B'}),p=await mergePreview(a.id,b.id);
 const merged=await mergeContacts({target_id:a.id,source_id:b.id,token:p.token}),c=await contactDetail(a.id);
 await saveContact({id:a.id,version:c.version,priority:true});await assert.rejects(undoMerge(merged.id),/changed after/);
 assert.equal((await contactDetail(a.id)).priority,true);
});

test('adding priority does not invalidate an unchanged merge recorded before the migration',async()=>{
 const a=await saveContact({name:'Legacy Priority A'}),b=await saveContact({name:'Legacy Priority B'}),p=await mergePreview(a.id,b.id);
 const merged=await mergeContacts({target_id:a.id,source_id:b.id,token:p.token});
 const decision=await one('SELECT * FROM identity_decisions WHERE id=?',merged.id),ids=[a.id,b.id];
 const legacy={contacts:await all('SELECT * FROM contacts WHERE id=ANY(?::text[]) ORDER BY id',ids)};
 for(const table of ['contact_identities','interaction_participants','affiliations','item_contacts','message_drafts'])legacy[table]=await all(`SELECT * FROM ${table} WHERE contact_id=ANY(?::text[]) ORDER BY row_to_json(${table})::text`,ids);
 legacy.identity_reviews=await all('SELECT * FROM identity_reviews WHERE left_id=ANY(?::text[]) OR right_id=ANY(?::text[]) ORDER BY id',ids,ids);
 for(const c of [...legacy.contacts,...decision.before_snapshot.contacts])delete c.priority;
 await run('UPDATE identity_decisions SET before_snapshot=?::jsonb,after_hash=? WHERE id=?',JSON.stringify(decision.before_snapshot),hash(legacy),merged.id);
 await undoMerge(merged.id);assert.equal((await contactDetail(a.id)).priority,false);assert.equal((await contactDetail(b.id)).priority,false);
});
