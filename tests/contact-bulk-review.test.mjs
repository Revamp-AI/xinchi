import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {one,run,uid} from '../lib/db.mjs';
import {saveContact,saveDraft,contactDetail,contactStatus} from '../lib/contacts.mjs';
import {logInteraction} from '../lib/contact-extraction.mjs';
import {bulkMergePreview,mergeReviewGroup,bulkKeepSeparate,undoMerge} from '../lib/contact-identity.mjs';

const person=(name,extra={})=>saveContact({name,...extra});
async function review(a,b,status='pending'){
 const id=uid(),[left,right]=[a.id,b.id].sort();
 await run('INSERT INTO identity_reviews(id,left_id,right_id,reason,status) VALUES(?,?,?,?,?)',id,left,right,'Fictional match',status);
 return id;
}
const approve=g=>({review_ids:g.review_ids,token:g.token,target_id:g.target_id});

test('selection validation rejects empty, repeated, oversized and nonexistent IDs',async()=>{
 for(const ids of [[],null,['x','x'],Array.from({length:31},(_,i)=>String(i)),[4]]){
  await assert.rejects(bulkMergePreview({ids}),/Select between/);
  await assert.rejects(bulkKeepSeparate({ids}),/Select between/);
 }
 await assert.rejects(bulkMergePreview({ids:['nonexistent']}),/already reviewed/);
});
test('preview groups overlapping matches, excludes unselected people, and performs no mutations',async()=>{
 const a=await person('Group A'),b=await person('Group B'),c=await person('Group C'),other=await person('Unselected Person');
 const ab=await review(a,b),bc=await review(b,c);await review(c,other);
 const before=await one('SELECT count(*) n FROM identity_decisions');
 const result=await bulkMergePreview({ids:[ab,bc]});assert.equal(result.groups.length,1);
 assert.deepEqual(new Set(result.groups[0].contacts.map(c=>c.id)),new Set([a.id,b.id,c.id]));
 assert.equal(result.groups[0].contacts[0].counts.contact_identities,0);
 assert.deepEqual(await one('SELECT count(*) n FROM identity_decisions'),before);
 assert.equal((await one('SELECT merged_into FROM contacts WHERE id=?',b.id)).merged_into,null);
});
test('group merge preserves evidence and preferences, records one decision, and undo restores every profile',async()=>{
 const a=await person('Bulk Kept',{notes:'Kept note',tags:['Peer']}),b=await person('Bulk Source',{notes:'Source note',paused:true,do_not_contact:true,organization:'Fictional Organization',role:'Founder',tags:['Partner']}),c=await person('Bulk Third',{tracked:true});
 await run("INSERT INTO contact_identities(id,contact_id,provider,account,external_key,display_name) VALUES(?,?,'linkedin','workspace',?,'Source alias')",uid(),b.id,'https://www.linkedin.com/in/bulk-fixture');
 await saveDraft({contact_id:c.id,body:'Fictional draft'});
 await logInteraction({contact_id:b.id,kind:'meeting',direction:'mutual',occurred_at:new Date().toISOString(),body:'Fictional discussion.',meaningful:true});
 const ids=[await review(a,b),await review(b,c)],g=(await bulkMergePreview({ids})).groups[0];
 const result=await mergeReviewGroup({...approve(g),target_id:a.id});assert.equal(result.merged,2);
 const detail=await contactDetail(a.id);assert.equal(detail.interactions.length,1);assert.ok(detail.identities.some(i=>i.provider==='linkedin'));assert.equal(detail.affiliations.length,1);assert.equal(detail.drafts.length,1);
 assert.equal(detail.notes,'Kept note\n\nSource note');assert.equal(detail.do_not_contact,true);assert.equal(detail.paused,true);assert.equal(detail.tracked,true);assert.deepEqual(detail.tags,['Peer','Partner']);
 assert.equal((await one('SELECT count(*) n FROM identity_decisions WHERE left_id=?',a.id)).n,1);
 assert.equal((await contactStatus()).decisions.find(d=>d.id===result.id).merged_count,2);
 await undoMerge(result.id);
 assert.equal((await contactDetail(b.id)).interactions.length,1);assert.equal((await contactDetail(c.id)).drafts.length,1);
 assert.equal((await contactDetail(a.id)).do_not_contact,false);
 assert.equal((await one("SELECT count(*) n FROM identity_reviews WHERE id=ANY(?::text[]) AND status='pending'",ids)).n,2);
});
test('the chosen kept profile must belong to the reviewed group',async()=>{
 const a=await person('Choice A'),b=await person('Choice B'),outside=await person('Outside choice');
 const g=(await bulkMergePreview({ids:[await review(a,b)]})).groups[0];
 await assert.rejects(mergeReviewGroup({...approve(g),target_id:outside.id}),/from this preview/);
 const merged=await mergeReviewGroup({...approve(g),target_id:b.id});assert.equal(merged.contact_id,b.id);
});
test('same-name profiles retain every primary email as an identity alias',async()=>{
 const a=await person('Two Address Person',{email:'bulk-first@example.com'}),b=await person('Two Address Person',{email:'bulk-second@example.com'});
 const g=(await bulkMergePreview({ids:[await review(a,b)]})).groups[0];
 await mergeReviewGroup({...approve(g),target_id:a.id});
 const detail=await contactDetail(a.id);assert.equal(detail.email,a.email);assert.ok(detail.identities.some(i=>i.address===b.email));
});
test('changed profiles and resolved matches cannot be merged from a stale preview',async()=>{
 const a=await person('Stale A'),b=await person('Stale B');const id=await review(a,b),g=(await bulkMergePreview({ids:[id]})).groups[0];
 await saveContact({...b,notes:'A new private note'});
 await assert.rejects(mergeReviewGroup(approve(g)),/profiles changed/);
 assert.equal((await one('SELECT merged_into FROM contacts WHERE id=?',b.id)).merged_into,null);
 const refreshed=(await bulkMergePreview({ids:[id]})).groups[0];await bulkKeepSeparate({ids:[id]});
 await assert.rejects(mergeReviewGroup(approve(refreshed)),/already reviewed/);
});
test('a separation between any two selected profiles blocks the entire overlapping group',async()=>{
 const a=await person('Separate A'),b=await person('Separate B'),c=await person('Separate C');
 const ids=[await review(a,b),await review(b,c)];await review(a,c,'separate');
 const g=(await bulkMergePreview({ids})).groups[0];assert.match(g.blocked,/different people/);
 await assert.rejects(mergeReviewGroup(approve(g)),/different people/);
});
test('oversized groups are blocked and disconnected groups require separate requests',async()=>{
 const people=[];for(let i=0;i<11;i++)people.push(await person('Large Group '+i));
 const ids=[];for(let i=1;i<people.length;i++)ids.push(await review(people[0],people[i]));
 const g=(await bulkMergePreview({ids})).groups[0];assert.match(g.blocked,/more than 10/);
 await assert.rejects(mergeReviewGroup(approve(g)),/more than 10/);
 const a=await person('Disconnected A'),b=await person('Disconnected B');const other=await review(a,b);
 const groups=(await bulkMergePreview({ids:[ids[0],other]})).groups;assert.equal(groups.length,2);
 await assert.rejects(mergeReviewGroup({...approve(groups[0]),review_ids:[ids[0],other]}),/one connected group/);
});
test('concurrent requests and network retries record a merge once; an old retry cannot undo an undo',async()=>{
 const a=await person('Retry A'),b=await person('Retry B'),ids=[await review(a,b)],g=(await bulkMergePreview({ids})).groups[0];
 const [first,second]=await Promise.all([mergeReviewGroup(approve(g)),mergeReviewGroup(approve(g))]);
 assert.equal(first.id,second.id);assert.equal(second.replayed,true);
 assert.equal((await one('SELECT count(*) n FROM identity_decisions WHERE left_id=?',g.target_id)).n,1);
 await undoMerge(first.id);await assert.rejects(mergeReviewGroup(approve(g)),/was undone/);
 const refreshed=(await bulkMergePreview({ids})).groups[0];assert.notEqual(refreshed.token,g.token);
 await mergeReviewGroup(approve(refreshed));
});
test('a group rolls back completely if any profile fails during the merge',async()=>{
 const a=await person('Atomic Kept'),b=await person('Atomic Other'),c=await person('Atomic Blocker');
 const g=(await bulkMergePreview({ids:[await review(a,b),await review(a,c)]})).groups[0];
 await run("CREATE FUNCTION reject_bulk_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.name='Atomic Blocker' AND NEW.merged_into IS NOT NULL THEN RAISE EXCEPTION 'fixture rejection'; END IF; RETURN NEW; END $$");
 await run('CREATE TRIGGER reject_bulk_fixture BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION reject_bulk_fixture()');
 try{await assert.rejects(mergeReviewGroup({...approve(g),target_id:a.id}),/fixture rejection/);}finally{await run('DROP TRIGGER reject_bulk_fixture ON contacts');await run('DROP FUNCTION reject_bulk_fixture()');}
 assert.equal((await one('SELECT count(*) n FROM contacts WHERE id=ANY(?::text[]) AND merged_into IS NULL',[a.id,b.id,c.id])).n,3);
 assert.equal((await one('SELECT count(*) n FROM identity_decisions WHERE left_id=?',a.id)).n,0);
 await mergeReviewGroup({...approve(g),target_id:a.id});
});
test('separating a selection skips stale matches and never acts on the next visible batch',async()=>{
 const a=await person('Separate Selected A'),b=await person('Separate Selected B'),c=await person('Separate Unselected C');
 const ab=await review(a,b),bc=await review(b,c),missing=uid();
 const result=await bulkKeepSeparate({ids:[ab,missing]});assert.deepEqual(result.completed,[ab]);assert.deepEqual(result.skipped,[missing]);
 assert.equal((await one('SELECT status FROM identity_reviews WHERE id=?',bc)).status,'pending');
 const again=await bulkKeepSeparate({ids:[ab]});assert.equal(again.completed.length,0);assert.equal(again.skipped.length,1);
});
test('later changes block undo of the whole group without removing those changes',async()=>{
 const a=await person('Undo Guard A'),b=await person('Undo Guard B'),c=await person('Undo Guard C');
 const g=(await bulkMergePreview({ids:[await review(a,b),await review(a,c)]})).groups[0],merged=await mergeReviewGroup(approve(g));
 const kept=await contactDetail(merged.contact_id);await saveContact({...kept,notes:'Keep this later edit.'});
 await assert.rejects(undoMerge(merged.id),/records changed/);
 assert.equal((await contactDetail(kept.id)).notes,'Keep this later edit.');
});
test('review totals include the next batches beyond the visible limit',async()=>{
 const a=await person('Pagination Anchor');
 for(let i=0;i<32;i++)await review(a,await person('Pagination Person '+i));
 const status=await contactStatus();assert.equal(status.reviews.length,30);assert.ok(status.review_total>30);
 assert.equal(status.review_total,(await one("SELECT count(*) n FROM identity_reviews r JOIN contacts l ON l.id=r.left_id JOIN contacts rh ON rh.id=r.right_id WHERE r.status='pending' AND l.merged_into IS NULL AND rh.merged_into IS NULL")).n);
});
