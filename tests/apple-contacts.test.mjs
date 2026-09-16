import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {one,run,uid} from '../lib/db.mjs';
import {saveContact,contactDetail} from '../lib/contacts.mjs';
import {internationalPhone,normalizeAppleContacts,importAppleContacts} from '../lib/apple-contacts.mjs';
import {projectSource} from '../lib/contact-extraction.mjs';

const card=(key,extra={})=>({key,name:'Fictional '+key,emails:[],phones:[],urls:[],...extra});
test('phone matching keeps international country codes and never guesses local numbers',()=>{
 assert.equal(internationalPhone('+1 (415) 555-0100'),'+14155550100');
 for(const value of ['4155550100','00441555550100','+1 415 555 0100 ext 3','+0 111 222 333'])assert.equal(internationalPhone(value),'');
 assert.throws(()=>normalizeAppleContacts([card('same'),card('same',{name:'Other Person'})]),/conflicting/);
});
test('dry run is read-only; import preserves all emails and phones without interactions; retry is unchanged',async()=>{
 const r=card('archive-one',{emails:['one@fixture.com','two@fixture.com'],phones:['+1 415 555 0100','020 7946 0000'],company:'Fictional Studio',role:'Designer'});
 assert.equal((await importAppleContacts([r])).added,1);assert.equal((await one('SELECT count(*) n FROM contacts')).n,0);
 assert.equal((await importAppleContacts([r],{apply:true})).added,1);const c=await one("SELECT contact_id FROM contact_identities WHERE provider='apple' AND external_key=?",r.key);
 const detail=await contactDetail(c.contact_id);assert.equal(detail.confirmed,false);assert.equal(detail.tracked,false);assert.equal(detail.affiliations.length,1);
 for(const address of ['one@fixture.com','two@fixture.com','+14155550100','020 7946 0000'])assert.ok(detail.identities.some(i=>i.address===address));
 await projectSource(detail.identities[0].source_id);assert.equal((await contactDetail(c.contact_id)).interactions.length,0);
 assert.equal((await importAppleContacts([r],{apply:true})).unchanged,1);
});
test('exact email enriches an existing contact while keeping notes, names and preferences',async()=>{
 const old=await saveContact({name:'Maintained Apple Name',email:'existing@fixture.com',notes:'Private note',paused:true,do_not_contact:true,cadence_days:60});
 const result=await importAppleContacts([card('existing',{emails:[old.email],name:'Imported Name',phones:['+65 9123 4567']})],{apply:true});assert.equal(result.matched,1);
 const c=await contactDetail(old.id);for(const key of ['name','notes','paused','do_not_contact','cadence_days'])assert.equal(c[key],old[key]);
});
test('phone placeholders get a name; conflicting names and local numbers never auto-link',async()=>{
 const placeholder=await saveContact({name:'+1 415-555-0200',confirmed:false});
 await run("INSERT INTO contact_identities(id,contact_id,provider,account,external_key,display_name) VALUES(?,?,'beeper','fixture',?,'Phone contact')",uid(),placeholder.id,'beeper-fixture');
 const result=await importAppleContacts([card('phone-match',{name:'Real Fixture Name',phones:['+14155550200']})],{apply:true});assert.equal(result.matched,1);assert.equal((await contactDetail(placeholder.id)).name,'Real Fixture Name');
 const other=await saveContact({name:'Another Person'});await run("INSERT INTO contact_identities(id,contact_id,provider,account,external_key,address) VALUES(?,?,'apple','archive','other-phone','+14155550300')",uid(),other.id);
 assert.equal((await importAppleContacts([card('different-phone-name',{phones:['+14155550300']})],{apply:true})).added,1);
});
test('conflicting identifiers are skipped, and a bad batch leaves no partial data',async()=>{
 const a=await saveContact({name:'Email Alpha',email:'alpha@fixture.com'}),b=await saveContact({name:'Email Beta',email:'beta@fixture.com'});
 assert.equal((await importAppleContacts([card('ambiguous',{emails:[a.email,b.email]})],{apply:true})).conflicts,1);
 await assert.rejects(importAppleContacts([card('good'),{key:''}],{apply:true}),/identifier/);
 assert.equal((await one("SELECT count(*) n FROM contact_identities WHERE provider='apple' AND external_key='good'")).n,0);
});
