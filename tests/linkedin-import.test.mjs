import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLinkedinConnections,linkedinProfileUrl,previewLinkedinConnections,importLinkedinBatch} from '../lib/linkedin-import.mjs';
import {one,run} from '../lib/db.mjs';
import {saveContact,contactDetail,listContacts} from '../lib/contacts.mjs';
import {mergeContacts,mergePreview,undoMerge} from '../lib/contact-identity.mjs';
import {projectSource} from '../lib/contact-extraction.mjs';

const header='First Name,Last Name,URL,Email Address,Company,Position,Connected On';
const csv=(...rows)=>'\ufeffNotes:\n"Some connections do not share their email."\n\n'+header+'\n'+rows.join('\n');
const records=(...rows)=>parseLinkedinConnections(csv(...rows)).records;
const record=(slug,first='Fictional',last=slug,email='',company='North Studio',position='Designer')=>records(`${first},${last},https://www.linkedin.com/in/${slug},${email},${company},${position},09 Sep 2026`)[0];

test('native LinkedIn parser supports Notes, BOM, Unicode, quoting and unidentifiable rows',()=>{
 const parsed=parseLinkedinConnections(csv('Mei,林,https://sg.linkedin.com/in/Mei-Lin/?trk=export,mei@example.com,"Studio, East","Lead\nDesigner",9 Sep 2026',',,,,,,09 Sep 2026'));
 assert.equal(parsed.total,2);assert.equal(parsed.skipped.length,1);assert.equal(parsed.records[0].profile_url,'https://www.linkedin.com/in/mei-lin');
 assert.equal(parsed.records[0].company,'Studio, East');assert.equal(parsed.records[0].position,'Lead\nDesigner');assert.equal(parsed.records[0].connected_on,'2026-09-09');
 assert.equal(parseLinkedinConnections(csv('Email,Only,,email-only@example.com,,,2026-09-09')).records[0].key,'email:email-only@example.com');
});
test('invalid and conflicting rows fail before importing; duplicate export rows are counted',()=>{
 assert.throws(()=>parseLinkedinConnections('name,email\nMei,a@example.com'),/Connections.csv/);
 assert.throws(()=>parseLinkedinConnections(csv('A,B,https://evil.example/in/a,,,,09 Sep 2026')),/profile URL/);
 assert.throws(()=>parseLinkedinConnections(csv('A,B,https://linkedin.com/in/a,bad-email,,,09 Sep 2026')),/invalid email/);
 assert.throws(()=>parseLinkedinConnections(csv('A,B,https://linkedin.com/in/a,,,,31 Feb 2026')),/connection date/);
 const row='A,B,https://linkedin.com/in/a,,,,09 Sep 2026';
 assert.equal(parseLinkedinConnections(csv(row,row)).skipped.length,1);
 assert.throws(()=>parseLinkedinConnections(csv(row,row.replace('A,B','C,D'))),/conflicting rows/);
 for(const url of ['https://linkedin.com.evil.test/in/a','javascript:alert(1)','https://x:pass@linkedin.com/in/a','https://linkedin.com/in/a%2Fb','https://linkedin.com/company/a'])assert.equal(linkedinProfileUrl(url),'');
});
test('preview is read-only; import preserves source evidence without warming or tracking',async()=>{
 const r=record('preview-person'),parsed={total:1,records:[r],skipped:[]};
 const before=await one('SELECT count(*) n FROM contacts');assert.equal((await previewLinkedinConnections(parsed)).added,1);assert.deepEqual(await one('SELECT count(*) n FROM contacts'),before);
 const imported=await importLinkedinBatch([r]);assert.equal(imported.added,1);
 const c=(await listContacts({q:r.profile_url})).records[0];
 assert.equal(c.name,r.name);
 const detail=await contactDetail((await one('SELECT id FROM contacts WHERE name=?',r.name)).id);
 assert.equal(detail.confirmed,false);assert.equal(detail.tracked,false);assert.equal(detail.relationship.state,'Unclassified');assert.equal(detail.interactions.length,0);
 assert.equal(detail.identities[0].profile_url,r.profile_url);assert.equal(detail.identities[0].connected_on,'2026-09-09');assert.ok(detail.identities[0].source_version_id);
 assert.equal(detail.affiliations[0].started_on,null);assert.equal(detail.affiliations[0].role,'Designer');
 await projectSource(detail.identities[0].source_id);assert.equal((await contactDetail(detail.id)).interactions.length,0);
});
test('an exact personal email enriches the existing profile and retains preferences and notes',async()=>{
 const old=await saveContact({name:'Chosen Name',email:'exact-linked@example.com',role:'Chosen Role',notes:'Keep this private note.',tracked:true,paused:true,do_not_contact:true,cadence_days:45,archived:true});
 const r=record('same-email','Imported','Alias','EXACT-LINKED@example.com','Export Company','Export Role');
 assert.equal((await importLinkedinBatch([r])).matched,1);
 const d=await contactDetail(old.id);
 for(const key of ['name','email','role','notes','tracked','paused','do_not_contact','cadence_days','archived','confirmed'])assert.deepEqual(d[key],old[key]);
 assert.equal(d.identities[0].display_name,'Imported Alias');assert.equal(d.affiliations[0].role,'Export Role');
 assert.equal((await listContacts({q:'Imported Alias',archived:true})).records[0].id,old.id);
});
test('stable profile URLs make reimports and metadata changes idempotent',async()=>{
 const r=record('repeatable');await importLinkedinBatch([r]);
 const identity=await one("SELECT * FROM contact_identities WHERE provider='linkedin' AND external_key=?",r.key),before=await contactDetail(identity.contact_id);
 assert.equal((await importLinkedinBatch([r])).unchanged,1);assert.equal((await contactDetail(before.id)).version,before.version);
 const changed={...r,name:'Updated Export Name',position:'Founder',company:'New Company',raw:{...r.raw,Position:'Founder',Company:'New Company'}};
 assert.equal((await importLinkedinBatch([changed])).matched,1);
 const d=await contactDetail(before.id);assert.equal(d.name,before.name);assert.equal(d.affiliations.length,2);
 assert.equal((await one('SELECT count(*) n FROM source_versions WHERE source_id=?',identity.source_id)).n,2);
 assert.equal((await importLinkedinBatch([changed])).unchanged,1);
 assert.equal((await one('SELECT count(*) n FROM contact_identities WHERE external_key=?',r.key)).n,1);
});
test('names and reversed names suggest review without merging; explicit separations persist',async()=>{
 const original=await saveContact({name:'Match Eleanor',email:'eleanor@example.com'}),r=record('name-only','Eleanor','Match');
 const result=await importLinkedinBatch([r]);assert.equal(result.added,1);assert.equal(result.review_pairs,1);
 const linked=await one('SELECT contact_id FROM contact_identities WHERE external_key=?',r.key);assert.notEqual(linked.contact_id,original.id);
 const pair=[linked.contact_id,original.id].sort();const review=await one('SELECT * FROM identity_reviews WHERE left_id=? AND right_id=?',...pair);assert.equal(review.status,'pending');
 await run("UPDATE identity_reviews SET status='separate' WHERE id=?",review.id);
 await importLinkedinBatch([{...r,company:'Another Company'}]);assert.equal((await one('SELECT status FROM identity_reviews WHERE id=?',review.id)).status,'separate');
});
test('concurrent retries and two rows sharing an email do not duplicate contacts or affiliations',async()=>{
 const first=record('concurrent-a','Concurrent','Person','concurrent@example.com'),second=record('concurrent-b','Concurrent','Alias','concurrent@example.com');
 await Promise.all([importLinkedinBatch([first,second]),importLinkedinBatch([first,second])]);
 assert.equal((await one('SELECT count(*) n FROM contacts WHERE email=?',first.email)).n,1);
 const c=await one('SELECT id FROM contacts WHERE email=?',first.email);
 assert.equal((await one('SELECT count(*) n FROM affiliations WHERE contact_id=?',c.id)).n,1);
});
test('identity/email conflicts are left for review without rebinding or overwriting',async()=>{
 const original=record('conflicted');await importLinkedinBatch([original]);
 const binding=await one('SELECT * FROM contact_identities WHERE external_key=?',original.key);
 const other=await saveContact({name:'Different Person',email:'conflicting@example.com'});
 const result=await importLinkedinBatch([{...original,email:other.email}]);assert.equal(result.conflicts,1);assert.equal(result.review_pairs,1);
 assert.equal((await one('SELECT address FROM contact_identities WHERE id=?',binding.id)).address,'');
 assert.equal((await one('SELECT email FROM contacts WHERE id=?',binding.contact_id)).email,'');
});
test('shared mailboxes do not link people or become trusted personal emails',async()=>{
 const old=await saveContact({name:'Support Office',email:'support@example.com'}),r=record('shared','Person','Shared','support@example.com');
 assert.equal((await importLinkedinBatch([r])).added,1);
 const i=await one('SELECT * FROM contact_identities WHERE external_key=?',r.key);assert.notEqual(i.contact_id,old.id);assert.equal(i.address,'');
 assert.equal(JSON.parse((await one('SELECT raw_json FROM source_versions WHERE source_id=?',i.source_id)).raw_json).linkedin_connection.email,'support@example.com');
});
test('manual merge and undo retain LinkedIn evidence and stable retry bindings',async()=>{
 const target=await saveContact({name:'Reviewed Target'}),r=record('merge-undo');await importLinkedinBatch([r]);
 const source=await one('SELECT contact_id FROM contact_identities WHERE external_key=?',r.key);
 const preview=await mergePreview(target.id,source.contact_id),decision=await mergeContacts({target_id:target.id,source_id:source.contact_id,token:preview.token});
 assert.equal((await importLinkedinBatch([r])).unchanged,1);
 assert.equal((await contactDetail(target.id)).identities.find(i=>i.provider==='linkedin').profile_url,r.profile_url);
 await undoMerge(decision.id);
 assert.equal((await one('SELECT contact_id FROM contact_identities WHERE external_key=?',r.key)).contact_id,source.contact_id);
});
test('a failed batch rolls back source data, contacts and evidence; retry succeeds',async()=>{
 const r=record('atomic-linkedin');
 await run("CREATE FUNCTION reject_linkedin_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.external_key LIKE '%atomic-linkedin' THEN RAISE EXCEPTION 'fixture rejection'; END IF; RETURN NEW; END $$");
 await run('CREATE TRIGGER reject_linkedin_fixture BEFORE INSERT ON contact_identities FOR EACH ROW EXECUTE FUNCTION reject_linkedin_fixture()');
 try{await assert.rejects(importLinkedinBatch([r]),/fixture rejection/);}finally{await run('DROP TRIGGER reject_linkedin_fixture ON contact_identities');await run('DROP FUNCTION reject_linkedin_fixture()');}
 assert.equal((await one('SELECT count(*) n FROM contacts WHERE name=?',r.name)).n,0);
 assert.equal((await one('SELECT count(*) n FROM sources WHERE url=?',r.profile_url)).n,0);
 assert.equal((await importLinkedinBatch([r])).added,1);
});
