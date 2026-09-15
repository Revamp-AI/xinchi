import {all,one,run,transaction,lockWorkspace,uid,hash} from './db.mjs';
import {existingContact,evaluateContacts} from './contacts.mjs';
import {emailAddress,personalEmail,exactEmailContacts,combinedNotes} from './contact-email.mjs';
const related=['contact_identities','interaction_participants','affiliations','item_contacts','message_drafts'];
async function snapshot(ids){
 const data={contacts:await all('SELECT * FROM contacts WHERE id=ANY(?::text[]) ORDER BY id',ids)};
 for(const t of related)data[t]=await all(`SELECT * FROM ${t} WHERE contact_id=ANY(?::text[]) ORDER BY row_to_json(${t})::text`,ids);
 data.identity_reviews=await all('SELECT * FROM identity_reviews WHERE left_id=ANY(?::text[]) OR right_id=ANY(?::text[]) ORDER BY id',ids,ids);
 return data;
}
export async function mergePreview(left,right){if(left===right)throw Error('Choose two different contacts.');const target=await existingContact(left),source=await existingContact(right),data=await snapshot([left,right]);return{target,source,counts:Object.fromEntries(related.map(t=>[t,data[t].filter(r=>r.contact_id===right).length])),token:hash(data),note:'The first profile is kept. Identities, evidence, affiliations, drafts and commitment links move to it. Do-not-contact and pause preferences are preserved.'};}
async function applyMerge(target,source,automaticEmail=''){
 const target_id=target.id,source_id=source.id,ids=[target_id,source_id],before=await snapshot(ids);
 // If both profiles participated in one event, retain the stronger recorded role.
 await run("INSERT INTO interaction_participants SELECT interaction_id,?,role FROM interaction_participants WHERE contact_id=? ON CONFLICT(interaction_id,contact_id) DO UPDATE SET role=CASE WHEN interaction_participants.role IN ('cc','mentioned','uncertain','') AND excluded.role NOT IN ('cc','mentioned','uncertain','') THEN excluded.role ELSE interaction_participants.role END",target_id,source_id);
 await run('DELETE FROM interaction_participants WHERE contact_id=?',source_id);
 await run('INSERT INTO item_contacts SELECT item_id,? FROM item_contacts WHERE contact_id=? ON CONFLICT DO NOTHING',target_id,source_id);
 await run('DELETE FROM item_contacts WHERE contact_id=?',source_id);
 for(const table of ['contact_identities','affiliations','message_drafts'])await run(`UPDATE ${table} SET contact_id=? WHERE contact_id=?`,target_id,source_id);
 if(source.name!==target.name&&!await one('SELECT id FROM contact_identities WHERE contact_id=? AND display_name=?',target_id,source.name))await run("INSERT INTO contact_identities(id,contact_id,provider,account,external_key,display_name,address) VALUES(?,?,'manual','workspace',?,?,?)",uid(),target_id,'contact:'+source_id,source.name,source.email);
 const tags=[...new Set([...target.tags,...source.tags])],snooze=[target.snoozed_until,source.snoozed_until].filter(Boolean).sort().at(-1)||null;
 await run('UPDATE contacts SET email=?,role=?,notes=?,tags=?::jsonb,do_not_contact=?,paused=?,snoozed_until=?,tracked=?,archived=?,confirmed=?,version=version+1,updated_at=now() WHERE id=?',target.email||source.email,target.role||source.role,combinedNotes(target.notes,source.notes),JSON.stringify(tags),target.do_not_contact||source.do_not_contact,target.paused||source.paused,snooze,target.tracked||source.tracked,automaticEmail?target.archived||source.archived:target.archived,automaticEmail?target.confirmed||source.confirmed:true,target_id);
 await run('UPDATE contacts SET merged_into=?,archived=true,version=version+1,updated_at=now() WHERE id=?',target_id,source_id);
 // Carry unresolved matches and explicit separations to the surviving contact.
 // Merging a pair must not dismiss an unrelated match on the kept profile.
 for(const review of before.identity_reviews){
  if(![review.left_id,review.right_id].includes(source_id))continue;
  const other=review.left_id===source_id?review.right_id:review.left_id;
  if(other!==target_id&&['pending','separate'].includes(review.status)){
   const [left,right]=[target_id,other].sort();
   await run("INSERT INTO identity_reviews(id,left_id,right_id,reason,status) VALUES(?,?,?,?,?) ON CONFLICT(left_id,right_id) DO UPDATE SET status=CASE WHEN excluded.status='separate' THEN 'separate' ELSE identity_reviews.status END",uid(),left,right,review.reason,review.status);
  }
  if(review.status==='pending')await run('UPDATE identity_reviews SET status=? WHERE id=?',other===target_id?'merged':'obsolete',review.id);
 }
 const id=uid();await run("INSERT INTO identity_decisions(id,kind,left_id,right_id,before_snapshot,after_hash) VALUES(?,'merge',?,?,?::jsonb,?)",id,target_id,source_id,JSON.stringify(automaticEmail?{...before,automatic_email:automaticEmail}:before),hash(await snapshot(ids)));return id;
}
export async function mergeContacts({target_id,source_id,token}){
 const decision=await transaction(async()=>{await lockWorkspace();const preview=await mergePreview(target_id,source_id);if(preview.token!==token)throw Error('These contacts changed. Preview the merge again.');return applyMerge(preview.target,preview.source);
 });await evaluateContacts([target_id]);return{id:decision,contact_id:target_id};
}

const label=value=>String(value||'').trim().toLowerCase().replace(/\s+/g,' ');
function nameQuality(contact){
 const name=label(contact.name),email=emailAddress(contact.email);
 if(!name||emailAddress(name)||name===email.split('@')[0]||['unknown participant','beeper contact'].includes(name))return 0;
 return name.split(' ').length>1?2:1;
}
function canonicalOrder(a,b){return Number(b.confirmed)-Number(a.confirmed)||Number(b.version>1)-Number(a.version>1)||nameQuality(b)-nameQuality(a)||Date.parse(a.created_at)-Date.parse(b.created_at)||a.id.localeCompare(b.id);}
async function mergeBlocker(contacts){
 const ids=contacts.map(c=>c.id);
 if(await one("SELECT id FROM identity_reviews WHERE status='separate' AND left_id=ANY(?::text[]) AND right_id=ANY(?::text[]) LIMIT 1",ids,ids))return 'Kept separate by you';
 const maintained=contacts.filter(c=>c.confirmed||c.version>1);
 if(new Set(maintained.filter(c=>nameQuality(c)>0).map(c=>label(c.name))).size>1)return 'Conflicting maintained names';
 if(new Set(maintained.map(c=>label(c.role)).filter(Boolean)).size>1)return 'Conflicting maintained roles';
 if(new Set(contacts.map(c=>c.cadence_days).filter(n=>n!==30)).size>1)return 'Conflicting follow-up cadences';
 return '';
}
async function reconcileEmailGroup(email,{apply}){
 const contacts=await exactEmailContacts(email);if(!contacts.length)return{contact:null,merged:0};
 contacts.sort(canonicalOrder);
 if(contacts.length===1)return{contact:contacts[0],merged:0};
 const reason=await mergeBlocker(contacts);
 if(reason)return{contact:null,merged:0,skipped:reason,profiles:contacts.length};
 let target=contacts[0];
 if(apply)for(const source of contacts.slice(1)){
  // Keep an explicitly configured cadence when the other profile uses the default.
  // Its original value must be in the audit snapshot, so update after the merge.
  const decision=await applyMerge(target,source,email);
  if(target.cadence_days===30&&source.cadence_days!==30){
   await run('UPDATE contacts SET cadence_days=? WHERE id=?',source.cadence_days,target.id);
   await run('UPDATE identity_decisions SET after_hash=? WHERE id=?',hash(await snapshot([target.id,source.id])),decision);
  }
  target=await existingContact(target.id);
 }
 return{contact:target,merged:contacts.length-1};
}
// Called inside import/save transactions; taking the same lock also makes it safe
// for direct callers and serializes concurrent providers before creating profiles.
export async function resolveExactEmailContact(address){
 const email=personalEmail(address);if(!email)return null;
 return transaction(async()=>{await lockWorkspace();return(await reconcileEmailGroup(email,{apply:true})).contact;});
}
export async function reconcileEmailContacts({apply=false}={}){
 const emails=await all("SELECT address FROM (SELECT id AS contact_id,lower(btrim(email)) AS address FROM contacts WHERE merged_into IS NULL AND email<>'' UNION SELECT i.contact_id,lower(btrim(i.address)) FROM contact_identities i JOIN contacts c ON c.id=i.contact_id WHERE c.merged_into IS NULL AND i.address<>'') addresses GROUP BY address HAVING count(DISTINCT contact_id)>1 ORDER BY address");
 let merged=0,groups=0;const skipped=[],affected=[];
 // Commit one email group at a time so ingestion can continue between groups.
 for(const {address} of emails){
  const email=personalEmail(address);if(!email){skipped.push({reason:'Shared or invalid mailbox'});continue;}
  const result=await transaction(async()=>{if(apply)await lockWorkspace();return reconcileEmailGroup(email,{apply});});
  if(result.skipped)skipped.push({reason:result.skipped,profiles:result.profiles});
  if(result.merged){merged+=result.merged;groups++;affected.push(result.contact.id);}
 }
 if(apply&&affected.length)await evaluateContacts([...new Set(affected)]);
 return{apply,groups,merged,skipped,affected};
}
export async function undoMerge(id){
 const ids=await transaction(async()=>{await lockWorkspace();const d=await one("SELECT * FROM identity_decisions WHERE id=? AND kind='merge' AND undone_at IS NULL FOR UPDATE",id);if(!d)throw Error('Merge not found or already undone.');const ids=[d.left_id,d.right_id];if(hash(await snapshot(ids))!==d.after_hash)throw Error('These records changed after the merge. Review them before undoing; no later edits were removed.');
 for(const t of related)await run(`DELETE FROM ${t} WHERE contact_id=ANY(?::text[])`,ids);
 await run('DELETE FROM identity_reviews WHERE left_id=ANY(?::text[]) OR right_id=ANY(?::text[])',ids,ids);
 for(const c of d.before_snapshot.contacts){const keys=Object.keys(c).filter(k=>k!=='id');await run(`UPDATE contacts SET ${keys.map(k=>'"'+k+'"=?')} WHERE id=?`,...keys.map(k=>k==='tags'?JSON.stringify(c[k]):c[k]),c.id);}
 for(const t of [...related,'identity_reviews'])for(const row of d.before_snapshot[t]){const keys=Object.keys(row);await run(`INSERT INTO ${t} (${keys}) VALUES(${keys.map(()=>'?')})`,...keys.map(k=>Array.isArray(row[k])?JSON.stringify(row[k]):row[k]));}
 if(d.before_snapshot.automatic_email){const [left,right]=ids.slice().sort();await run("INSERT INTO identity_reviews(id,left_id,right_id,reason,status) VALUES(?,?,?,'Automatic email match undone by you.','separate') ON CONFLICT(left_id,right_id) DO UPDATE SET status='separate'",uid(),left,right);}
 await run('UPDATE identity_decisions SET undone_at=now() WHERE id=?',id);return ids;
 });await evaluateContacts(ids);return{undone:true};
}
export async function keepSeparate(id){await transaction(async()=>{await lockWorkspace();await run("UPDATE identity_reviews SET status='separate' WHERE id=? AND status='pending'",id);});return{saved:true};}
