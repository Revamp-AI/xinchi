import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {one,run,setSetting,uid} from '../lib/db.mjs';
import {saveContact,contactDetail} from '../lib/contacts.mjs';
import {parseLinkedinConnections,importLinkedinBatch} from '../lib/linkedin-import.mjs';
import {previewEmployerMatches,runAutoContactMatching,setAutoMatchEnabled,autoMatchStatus} from '../lib/contact-auto-match.mjs';
import {undoMerge,keepSeparate} from '../lib/contact-identity.mjs';
import {companyKey,corporateDomain,plausibleEmployerDomain,publicIPv4,employerWebsiteUrl,websiteCompanyEvidence} from '../lib/company-domain.mjs';

const verify=async(company,domain)=>websiteCompanyEvidence(company,domain,{url:'https://'+domain+'/',html:`<meta property="og:site_name" content="${company}">`});
async function pair(last,company='Fixtureworks'){
 const email=await saveContact({name:'Fictional '+last,email:last.toLowerCase()+'@'+company.toLowerCase()+'.com',notes:'Preserve this note',cadence_days:45,paused:true});
 const [record]=parseLinkedinConnections('First Name,Last Name,URL,Email Address,Company,Position,Connected On\nFictional,'+last+',https://www.linkedin.com/in/'+last.toLowerCase()+',,'+company+',Designer,09 Sep 2026').records;
 await importLinkedinBatch([record]);
 const linked=await one("SELECT c.* FROM contacts c JOIN contact_identities i ON i.contact_id=c.id WHERE i.external_key=?",record.key);
 return{email,linked,record};
}
async function reset(){await setSetting('contact_auto_match',{});await run("UPDATE identity_reviews SET status='separate' WHERE status='pending'");}

test('only exact company/domain labels and non-shared corporate addresses qualify',()=>{
 assert.equal(companyKey('Fixtureworks, Inc.'),'fixtureworks');
 assert.ok(plausibleEmployerDomain('Fixtureworks','fixtureworks.com'));
 for(const d of ['getfixtureworks.com','fixturew0rks.com','fixtureworks.example.com','xn--fixtureworks.com'])assert.equal(plausibleEmployerDomain('Fixtureworks',d),false);
 for(const e of ['x@gmail.com','support@fixtureworks.com','x@localhost','x@127.0.0.1'])assert.equal(corporateDomain(e),'');
 assert.equal(corporateDomain('person@fixtureworks.co.uk'),'fixtureworks.co.uk');
});
test('verification requires branded website metadata and confines HTTPS redirects',()=>{
 assert.ok(websiteCompanyEvidence('Fixtureworks','fixtureworks.com',{url:'https://www.fixtureworks.com/',html:'<title>Fixtureworks — tools</title>'}));
 assert.equal(websiteCompanyEvidence('Fixtureworks','fixtureworks.com',{url:'https://fixtureworks.com/',html:'<title>Buy this domain</title><p>Formerly Fixtureworks</p>'}),null);
 assert.equal(websiteCompanyEvidence('Fixtureworks','fixtureworks.com',{url:'https://fixtureworks.com/',html:'<title>Fixtureworks competitor</title>'}),null);
 for(const url of ['http://fixtureworks.com','https://fixtureworks.com.evil.com','https://localhost/','https://user:pass@fixtureworks.com','https://fixtureworks.com:8443'])assert.throws(()=>employerWebsiteUrl(url,'fixtureworks.com'));
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','172.16.0.1','100.64.0.1','198.19.1.1','224.0.0.1','::1','::ffff:127.0.0.1'])assert.equal(publicIPv4(ip),false);
 assert.equal(publicIPv4('8.8.8.8'),true);
});
test('verified name and employer matches preserve preferences, audit evidence and undo stays separate',async()=>{
 await reset();const {email,linked}=await pair('Match');
 const before=await previewEmployerMatches();assert.equal(before.length,1);assert.equal(before[0].company,'Fixtureworks');
 const result=await runAutoContactMatching({force:true,verify});assert.equal(result.merged,1);
 const detail=await contactDetail(email.id);assert.equal(detail.cadence_days,45);assert.equal(detail.paused,true);assert.equal(detail.notes,email.notes);assert.ok(detail.identities.some(i=>i.provider==='linkedin'));
 const decision=await one('SELECT * FROM identity_decisions WHERE id=?',result.decisions[0]);assert.equal(decision.before_snapshot.automatic_match.company,'Fixtureworks');assert.ok(decision.before_snapshot.automatic_match.source_version_id);
 assert.equal((await one('SELECT merged_into FROM contacts WHERE id=?',linked.id)).merged_into,email.id);
 await undoMerge(decision.id);assert.equal((await previewEmployerMatches()).length,0);assert.equal((await runAutoContactMatching({force:true,verify})).merged,0);
});
test('unverified websites do not merge and unchanged failures are cached',async()=>{
 await reset();await pair('Unverified','Unverifiedworks');let calls=0;
 assert.equal((await runAutoContactMatching({force:true,verify:async()=>{calls++;return null;}})).merged,0);
 assert.equal((await runAutoContactMatching({force:true,verify:async()=>{calls++;return null;}})).merged,0);assert.equal(calls,1);
});
test('same-name ambiguity, former affiliations and stale exports remain reviewable',async()=>{
 await reset();const p=await pair('Ambiguous');await saveContact({name:p.email.name,email:'third@fixtureworks.com'});assert.equal((await previewEmployerMatches()).length,0);
 await reset();const old=await pair('Former');await run('UPDATE affiliations SET ended_on=CURRENT_DATE WHERE contact_id=?',old.linked.id);assert.equal((await previewEmployerMatches()).length,0);
 await reset();const stale=await pair('Stale');await run("UPDATE source_versions SET fetched_at=? WHERE source_id=(SELECT source_id FROM contact_identities WHERE contact_id=? AND provider='linkedin')",new Date(Date.now()-91*86400000).toISOString(),stale.linked.id);assert.equal((await previewEmployerMatches()).length,0);
});
test('different LinkedIn profiles and conflicting maintained context cannot be silently merged',async()=>{
 await reset();const p=await pair('Conflict');await run("INSERT INTO contact_identities(id,contact_id,provider,account,external_key) VALUES(?,?,'linkedin','workspace','https://www.linkedin.com/in/another-conflict')",uid(),p.email.id);assert.equal((await previewEmployerMatches()).length,0);
 await reset();const q=await pair('Roles');await saveContact({...q.email,role:'Different maintained role'});await saveContact({...q.linked,confirmed:true});assert.equal((await runAutoContactMatching({force:true,verify})).merged,0);
});
test('changes and keep-separate decisions during website verification are rechecked',async()=>{
 await reset();const p=await pair('Race','Raceworks');
 const result=await runAutoContactMatching({force:true,verify:async(company,domain)=>{const r=await one("SELECT id FROM identity_reviews WHERE status='pending' AND (left_id=? OR right_id=?)",p.linked.id,p.linked.id);await keepSeparate(r.id);return verify(company,domain);}});assert.equal(result.merged,0);
});
test('pause is honored during verification and concurrent runs cannot duplicate merges',async()=>{
 await reset();await pair('Paused','Pauseworks');
 const paused=await runAutoContactMatching({force:true,verify:async(company,domain)=>{await setAutoMatchEnabled(false);return verify(company,domain);}});assert.equal(paused.merged,0);assert.equal((await autoMatchStatus()).enabled,false);
 assert.equal((await runAutoContactMatching({force:true,verify})).skipped,true);
 await setAutoMatchEnabled(true);const results=await Promise.all([runAutoContactMatching({force:true,verify}),runAutoContactMatching({force:true,verify})]);assert.equal(results.reduce((n,r)=>n+(r.merged||0),0),1);
});
test('one pass checks at most five new websites and reports deferred work',async()=>{
 await reset();for(let i=0;i<6;i++)await pair('Bounded'+i,'Boundedworks'+i);
 let checked=0;const result=await runAutoContactMatching({force:true,verify:async()=>{checked++;return null;}});assert.equal(checked,5);assert.equal(result.deferred,1);
});
