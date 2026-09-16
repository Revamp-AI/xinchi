import {all,run,transaction,lockWorkspace} from './db.mjs';
import {extractInteraction} from './contact-extraction.mjs';
import {suggestIdentityMatches} from './contacts.mjs';

// Repairs only untouched profiles produced by the old outgoing-sender fallback.
// Names are corrected within an existing provider identity; no people are merged.
export async function repairBeeperContactNames({apply=false}={}){
 return transaction(async()=>{
  if(apply)await lockWorkspace();
  const selves=await all(`SELECT DISTINCT raw->'chat'->>'accountID' AS account,p->>'id' AS external_key
   FROM sources s JOIN source_versions v ON v.source_id=s.id AND v.content_hash=s.content_hash
   CROSS JOIN LATERAL (SELECT v.raw_json::jsonb AS raw) r
   CROSS JOIN LATERAL jsonb_array_elements(raw->'chat'->'participants'->'items') p
   WHERE s.provider='beeper' AND (p->>'isSelf'='true' OR (raw->'message'->>'isSender'='true' AND p->>'id'=raw->'message'->>'senderID'))`);
  const selfKeys=new Set(selves.map(p=>JSON.stringify([p.account,p.external_key])));
  const rows=await all(`SELECT c.*,i.id AS identity_id,i.account,i.external_key,i.display_name,i.source_id,s.coverage,v.raw_json,
   (SELECT count(*) FROM contact_identities ci WHERE ci.contact_id=c.id) AS identity_count,
   EXISTS(SELECT 1 FROM affiliations a WHERE a.contact_id=c.id UNION ALL SELECT 1 FROM item_contacts ic WHERE ic.contact_id=c.id UNION ALL SELECT 1 FROM message_drafts d WHERE d.contact_id=c.id) AS has_links,
   EXISTS(SELECT 1 FROM sources ms WHERE ms.provider='manual' AND ms.external_id='contact-profile-'||c.id) AS has_manual_profile,
   EXISTS(SELECT 1 FROM interaction_participants ip JOIN interactions e ON e.id=ip.interaction_id LEFT JOIN sources es ON es.id=e.source_id WHERE ip.contact_id=c.id AND (es.provider IS DISTINCT FROM 'beeper' OR e.qualified)) AS has_meaningful_activity
   FROM contacts c JOIN contact_identities i ON i.contact_id=c.id
   JOIN sources s ON s.id=i.source_id JOIN source_versions v ON v.source_id=s.id AND v.content_hash=s.content_hash
   WHERE i.provider='beeper' AND c.merged_into IS NULL AND NOT c.archived ORDER BY c.id`);
  const changes=[],skipped=[];
  for(const c of rows){
   const raw=JSON.parse(c.raw_json),p=raw.chat?.participants?.items?.find(p=>p.id===c.external_key);
   const isSelf=selfKeys.has(JSON.stringify([c.account,c.external_key]));
   const person=extractInteraction({provider:'beeper',coverage:c.coverage},raw,[]).participants.find(p=>p.external_id===c.external_key);
   const name=person?.name.slice(0,200);
   const badFallback=p&&!p.fullName&&raw.message?.isSender===true&&c.name===raw.message.senderName&&c.display_name===c.name;
   if(!isSelf&&!(badFallback&&name&&name!=='Beeper contact'&&name!==c.name))continue;
   const untouched=!c.confirmed&&c.version===1&&c.identity_count===1&&!c.has_manual_profile&&!c.has_links&&!c.tracked&&!c.paused&&!c.do_not_contact&&!c.snoozed_until&&!c.notes&&!c.role&&!c.tags.length&&c.cadence_days===30;
   if(!untouched||(isSelf&&c.has_meaningful_activity)){skipped.push(c.id);continue;}
   changes.push({id:c.id,identity_id:c.identity_id,before:c.name,after:isSelf?c.name:name,archive:isSelf,email:c.email});
  }
  const byId=new Map(changes.map(c=>[c.id,c])),ids=[...byId.keys()];
  const reviews=ids.length?await all(`SELECT r.id,r.left_id,r.right_id,l.name AS left_name,l.email AS left_email,h.name AS right_name,h.email AS right_email
   FROM identity_reviews r JOIN contacts l ON l.id=r.left_id JOIN contacts h ON h.id=r.right_id
   WHERE r.status='pending' AND r.reason='Same display name; may be different people.' AND (r.left_id=ANY(?::text[]) OR r.right_id=ANY(?::text[]))`,ids,ids):[];
  const obsolete=reviews.filter(r=>{
   const left=byId.get(r.left_id),right=byId.get(r.right_id);
   return left?.archive||right?.archive||((left?.after||r.left_name).toLowerCase()!==(right?.after||r.right_name).toLowerCase()&&(!r.left_email||r.left_email.toLowerCase()!==r.right_email.toLowerCase()));
  });
  if(apply){
   for(const c of changes){
    await run('UPDATE contacts SET name=?,archived=?,version=version+1,updated_at=now() WHERE id=?',c.after,c.archive,c.id);
    if(!c.archive)await run('UPDATE contact_identities SET display_name=? WHERE id=?',c.after,c.identity_id);
   }
   if(obsolete.length)await run("UPDATE identity_reviews SET status='obsolete' WHERE id=ANY(?::text[])",obsolete.map(r=>r.id));
   for(const c of changes)if(!c.archive)await suggestIdentityMatches(c.id,c.after,c.email);
  }
  return{applied:apply,renamed:changes.filter(c=>!c.archive).length,archived_self_profiles:changes.filter(c=>c.archive).length,obsolete_name_reviews:obsolete.length,skipped_customized:skipped.length,changes};
 });
}
