import {all,one,run,transaction,lockWorkspace,uid,hash} from './db.mjs';
import {existingContact,evaluateContacts} from './contacts.mjs';
const related=['contact_identities','interaction_participants','affiliations','item_contacts','message_drafts'];
async function snapshot(ids){
 const data={contacts:await all('SELECT * FROM contacts WHERE id=ANY(?::text[]) ORDER BY id',ids)};
 for(const t of related)data[t]=await all(`SELECT * FROM ${t} WHERE contact_id=ANY(?::text[]) ORDER BY row_to_json(${t})::text`,ids);
 data.identity_reviews=await all('SELECT * FROM identity_reviews WHERE left_id=ANY(?::text[]) OR right_id=ANY(?::text[]) ORDER BY id',ids,ids);
 return data;
}
export async function mergePreview(left,right){if(left===right)throw Error('Choose two different contacts.');const target=await existingContact(left),source=await existingContact(right),data=await snapshot([left,right]);return{target,source,counts:Object.fromEntries(related.map(t=>[t,data[t].filter(r=>r.contact_id===right).length])),token:hash(data),note:'The first profile is kept. Identities, evidence, affiliations, drafts and commitment links move to it. Do-not-contact and pause preferences are preserved.'};}
export async function mergeContacts({target_id,source_id,token}){
 const decision=await transaction(async()=>{await lockWorkspace();const preview=await mergePreview(target_id,source_id);if(preview.token!==token)throw Error('These contacts changed. Preview the merge again.');const ids=[target_id,source_id],before=await snapshot(ids);
 for(const table of ['interaction_participants','item_contacts']){const col=table==='item_contacts'?'item_id':'interaction_id';await run(`INSERT INTO ${table} SELECT ${col},?${table==='interaction_participants'?',role':''} FROM ${table} WHERE contact_id=? ON CONFLICT DO NOTHING`,target_id,source_id);await run(`DELETE FROM ${table} WHERE contact_id=?`,source_id);}
 for(const table of ['contact_identities','affiliations','message_drafts'])await run(`UPDATE ${table} SET contact_id=? WHERE contact_id=?`,target_id,source_id);
 await run('UPDATE contacts SET do_not_contact=do_not_contact OR ?,paused=paused OR ?,confirmed=true,version=version+1,updated_at=now() WHERE id=?',preview.source.do_not_contact,preview.source.paused,target_id);
 await run('UPDATE contacts SET merged_into=?,archived=true,version=version+1,updated_at=now() WHERE id=?',target_id,source_id);
 await run("UPDATE identity_reviews SET status='merged' WHERE left_id=ANY(?::text[]) OR right_id=ANY(?::text[])",ids,ids);
 const id=uid();await run("INSERT INTO identity_decisions(id,kind,left_id,right_id,before_snapshot,after_hash) VALUES(?,'merge',?,?,?::jsonb,?)",id,target_id,source_id,JSON.stringify(before),hash(await snapshot(ids)));return id;
 });await evaluateContacts([target_id]);return{id:decision,contact_id:target_id};
}
export async function undoMerge(id){
 const ids=await transaction(async()=>{await lockWorkspace();const d=await one("SELECT * FROM identity_decisions WHERE id=? AND kind='merge' AND undone_at IS NULL FOR UPDATE",id);if(!d)throw Error('Merge not found or already undone.');const ids=[d.left_id,d.right_id];if(hash(await snapshot(ids))!==d.after_hash)throw Error('These records changed after the merge. Review them before undoing; no later edits were removed.');
 for(const t of related)await run(`DELETE FROM ${t} WHERE contact_id=ANY(?::text[])`,ids);
 await run('DELETE FROM identity_reviews WHERE left_id=ANY(?::text[]) OR right_id=ANY(?::text[])',ids,ids);
 for(const c of d.before_snapshot.contacts){const keys=Object.keys(c).filter(k=>k!=='id');await run(`UPDATE contacts SET ${keys.map(k=>'"'+k+'"=?')} WHERE id=?`,...keys.map(k=>k==='tags'?JSON.stringify(c[k]):c[k]),c.id);}
 for(const t of [...related,'identity_reviews'])for(const row of d.before_snapshot[t]){const keys=Object.keys(row);await run(`INSERT INTO ${t} (${keys}) VALUES(${keys.map(()=>'?')})`,...keys.map(k=>Array.isArray(row[k])?JSON.stringify(row[k]):row[k]));}
 await run('UPDATE identity_decisions SET undone_at=now() WHERE id=?',id);return ids;
 });await evaluateContacts(ids);return{undone:true};
}
export async function keepSeparate(id){await run("UPDATE identity_reviews SET status='separate' WHERE id=? AND status='pending'",id);return{saved:true};}
