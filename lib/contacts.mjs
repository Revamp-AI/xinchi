import {parse} from 'csv-parse/sync';
import {emailAddress,exactEmailContacts,combinedNotes} from './contact-email.mjs';
import {resolveExactEmailContact} from './contact-identity.mjs';
import {all,one,run,transaction,lockWorkspace,uid,stamp,hash,dateOK,upsertSource,getSetting,setSetting} from './db.mjs';
import {relationshipState,SEGMENTS,RULE_VERSION} from './relationship-rules.mjs';

export {emailAddress} from './contact-email.mjs';
const text=(v,max=2000)=>String(v||'').trim().slice(0,max);
export async function existingContact(id){const row=await one('SELECT * FROM contacts WHERE id=? AND merged_into IS NULL',id||'');if(!row)throw Error('Contact not found.');return row;}
export async function saveContact(input){
 const row=await transaction(async()=>{
  await lockWorkspace();const old=input.id?await existingContact(input.id):null;
  if(old&&old.version!==input.version)throw Error('This contact changed. Reopen it before saving.');
  const row=old?{...old}:{id:uid(),name:'',email:'',role:'',tags:[],notes:'',tracked:false,cadence_days:30,paused:false,snoozed_until:null,do_not_contact:false,archived:false,confirmed:true,version:0};
  for(const k of ['name','role','notes'])if(k in input)row[k]=text(input[k],k==='notes'?12000:200);
  if('email' in input){row.email=emailAddress(input.email);if(input.email&&!row.email)throw Error('Enter a valid email address.');}
  if(row.email&&(!old||row.email!==old.email)&&(await exactEmailContacts(row.email)).some(c=>c.id!==row.id))throw Error('A contact with this email already exists. Open that profile to edit it.');
  if(!row.name)throw Error('Add a name for this contact.');
  for(const k of ['tracked','paused','do_not_contact','archived','confirmed'])if(k in input)row[k]=Boolean(input[k]);
  if('cadence_days' in input){row.cadence_days=Number(input.cadence_days);if(!Number.isInteger(row.cadence_days)||row.cadence_days<1||row.cadence_days>3650)throw Error('Choose a cadence between 1 and 3,650 days.');}
  if('snoozed_until' in input){if(input.snoozed_until&&!dateOK(input.snoozed_until))throw Error('Choose a valid snooze date.');row.snoozed_until=input.snoozed_until||null;}
  if('tags' in input){if(!Array.isArray(input.tags))throw Error('Tags must be a list.');row.tags=[...new Set(input.tags.map(t=>text(t,40)).filter(Boolean))].slice(0,20);}
  await run(`INSERT INTO contacts(id,name,email,role,tags,notes,tracked,cadence_days,paused,snoozed_until,do_not_contact,archived,confirmed) VALUES(?,?,?,?,?::jsonb,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,role=excluded.role,tags=excluded.tags,notes=excluded.notes,tracked=excluded.tracked,cadence_days=excluded.cadence_days,paused=excluded.paused,snoozed_until=excluded.snoozed_until,do_not_contact=excluded.do_not_contact,archived=excluded.archived,confirmed=excluded.confirmed,version=contacts.version+1,updated_at=now()`,row.id,row.name,row.email,row.role,JSON.stringify(row.tags),row.notes,row.tracked,row.cadence_days,row.paused,row.snoozed_until,row.do_not_contact,row.archived,row.confirmed);
  if(input.organization!==undefined&&text(input.organization,200)){
   for(const k of ['started_on','ended_on'])if(input[k]&&!dateOK(input[k]))throw Error('Choose valid affiliation dates.');
   if(input.started_on&&input.ended_on&&input.ended_on<input.started_on)throw Error('Affiliation end must follow its start.');
   const org=await one('INSERT INTO organizations(id,name) VALUES(?,?) ON CONFLICT(lower(name)) DO UPDATE SET name=organizations.name RETURNING id',uid(),text(input.organization,200));
   if(!await one('SELECT id FROM affiliations WHERE contact_id=? AND organization_id=? AND role=? AND started_on IS NOT DISTINCT FROM ?::date AND ended_on IS NOT DISTINCT FROM ?::date',row.id,org.id,row.role,input.started_on||null,input.ended_on||null))await run('INSERT INTO affiliations VALUES(?,?,?,?,?,?)',uid(),row.id,org.id,row.role,input.started_on||null,input.ended_on||null);
  }
  if(!old||old.notes!==row.notes||old.name!==row.name||old.role!==row.role)await upsertSource({provider:'manual',external_id:'contact-profile-'+row.id,title:'Contact profile: '+row.name,body:[row.name,row.role,row.notes].filter(Boolean).join('\n\n'),coverage:'document'}, {origin:'User maintained contact profile',contact_profile:row.id});
  return existingContact(row.id);
 });await evaluateContacts([row.id]);return row;
}
export async function saveAffiliation(input){return transaction(async()=>{await lockWorkspace();await existingContact(input.contact_id);const a=await one('SELECT * FROM affiliations WHERE id=? AND contact_id=?',input.id,input.contact_id);if(!a)throw Error('Affiliation not found.');for(const k of ['started_on','ended_on'])if(input[k]&&!dateOK(input[k]))throw Error('Choose valid affiliation dates.');if(input.started_on&&input.ended_on&&input.ended_on<input.started_on)throw Error('Affiliation end must follow its start.');await run('UPDATE affiliations SET role=?,started_on=?,ended_on=? WHERE id=?',text(input.role,200),input.started_on||null,input.ended_on||null,input.id);await run('UPDATE contacts SET version=version+1,updated_at=now() WHERE id=?',input.contact_id);return{saved:true};});}
export async function importContactsCsv(csv){
 if(typeof csv!=='string'||csv.length>2_000_000)throw Error('Choose a CSV smaller than 2 MB.');
 let rows;try{rows=parse(csv,{columns:headers=>headers.map(h=>h.trim().toLowerCase().replaceAll(' ','_')),bom:true,skip_empty_lines:true,trim:true});}catch{throw Error('Could not read this CSV. Check its headers and quoting.');}
 if(rows.length>5000)throw Error('Import up to 5,000 contacts at a time.');
 const records=rows.map((r,i)=>{const name=text(r.name||[r.first_name,r.last_name].filter(Boolean).join(' '),200),email=emailAddress(r.email);if(!name||r.email&&!email)throw Error('Row '+(i+2)+' needs a name and a valid email if supplied.');return{name,email,role:r.role||'',organization:r.organization||r.company||'',notes:r.notes||'',tags:(r.tags||'').split(';').filter(Boolean)};});
 let added=0,matched=0;await transaction(async()=>{await lockWorkspace();for(const r of records){const key=hash(r);if(await one("SELECT id FROM contact_identities WHERE provider='csv' AND account='workspace' AND external_key=?",key))continue;const existing=await resolveExactEmailContact(r.email);const c=await saveContact(existing?{...r,id:existing.id,version:existing.version,name:existing.name,email:existing.email,role:existing.role||r.role,notes:combinedNotes(existing.notes,r.notes),tags:[...new Set([...existing.tags,...r.tags])]}:r);await run("INSERT INTO contact_identities(id,contact_id,provider,account,external_key,display_name,address) VALUES(?,?,'csv','workspace',?,?,?)",uid(),c.id,key,r.name,r.email);if(existing)matched++;else{await suggestIdentityMatches(c.id,c.name,c.email);added++;}}});return{total:records.length,added,matched};
}
export async function suggestIdentityMatches(id,name,email){
 const matches=await all("SELECT id,email FROM contacts WHERE id<>? AND merged_into IS NULL AND archived=false AND ((?<>'' AND lower(email)=?) OR lower(name)=lower(?)) LIMIT 20",id,email,email,name);
 for(const other of matches){const [left,right]=[id,other.id].sort();await run("INSERT INTO identity_reviews(id,left_id,right_id,reason) VALUES(?,?,?,?) ON CONFLICT(left_id,right_id) DO NOTHING",uid(),left,right,email&&email===other.email?'Same address across different identity bindings.':'Same display name; may be different people.');}
}
export async function readInteractions(id,limit=300,offset=0){return all(`SELECT i.*,CASE WHEN p.role IN ('cc','mentioned','uncertain') THEN false ELSE i.qualified END AS qualified,COALESCE((SELECT jsonb_agg(jsonb_build_object('source_id',s.source_id,'source_version_id',s.source_version_id,'quote',s.quote)) FROM interaction_sources s JOIN source_versions v ON v.id=s.source_version_id JOIN sources src ON src.id=s.source_id WHERE s.interaction_id=i.id AND v.content_hash=src.content_hash),'[]'::jsonb) AS citations FROM interactions i JOIN interaction_participants p ON p.interaction_id=i.id WHERE p.contact_id=? ORDER BY occurred_at DESC NULLS LAST,i.id ${limit?'LIMIT '+Math.min(1000,Math.max(1,Number(limit)||300))+' OFFSET '+Math.max(0,Math.floor(Number(offset)||0)):''}`,id);}
export async function evaluateContacts(ids=null){
 if(!ids){const last=await getSetting('contacts_last_evaluation');if(last&&Date.now()-Date.parse(last)<900000)return;}
 await transaction(async()=>{
  await lockWorkspace();
  const contacts=ids?await all('SELECT * FROM contacts WHERE id=ANY(?::text[]) AND merged_into IS NULL',ids):await all('SELECT * FROM contacts WHERE merged_into IS NULL AND archived=false');
  if(!contacts.length)return;
  const contactIds=contacts.map(c=>c.id),oldStates=new Map((await all('SELECT * FROM contact_states WHERE contact_id=ANY(?::text[])',contactIds)).map(r=>[r.contact_id,r]));
  const events=await all("SELECT p.contact_id,i.*,CASE WHEN p.role IN ('cc','mentioned','uncertain') THEN false ELSE i.qualified END AS qualified FROM interactions i JOIN interaction_participants p ON p.interaction_id=i.id WHERE p.contact_id=ANY(?::text[])",contactIds);
  const byContact=new Map();for(const e of events){if(!byContact.has(e.contact_id))byContact.set(e.contact_id,[]);byContact.get(e.contact_id).push(e);}
  const syncs=new Map((await all('SELECT DISTINCT ON(provider) * FROM sync_runs ORDER BY provider,started_at DESC,id DESC')).map(r=>[r.provider,r]));
  const settings=new Map((await all('SELECT * FROM settings WHERE key=ANY(?::text[])',['gmail_query',...contactIds.map(id=>'contact_coverage:'+id)])).map(r=>[r.key,JSON.parse(r.value)]));
  const backlog=new Set((await all("SELECT DISTINCT s.provider FROM contact_queue q JOIN sources s ON s.id=q.source_id WHERE q.state<>'complete'")).map(r=>r.provider));
  const states=[],history=[];
  for(const contact of contacts){
   const interactions=byContact.get(contact.id)||[],manual=settings.get('contact_coverage:'+contact.id),providers=[...new Set(interactions.map(i=>i.source_id?.split(':')[0]).filter(p=>p&&p!=='manual'))];
   let coverage={fresh:true,reason:'Connected providers have complete recent imports.'};
   if(manual&&Date.now()-Date.parse(manual)<48*3600000)coverage={fresh:true,reason:'Timeline coverage confirmed by you.',checked_at:manual};
   else if(!providers.length)coverage={fresh:false,reason:'Confirm that this timeline is complete before inferring silence.'};
   else if(providers.includes('beeper'))coverage={fresh:false,reason:'Beeper includes selected conversations and locally available history. Confirm timeline coverage before inferring silence.'};
   else for(const p of providers){const sync=syncs.get(p);if(!sync||sync.state!=='complete'||!sync.finished_at||Date.now()-Date.parse(sync.finished_at)>48*3600000){coverage={fresh:false,reason:p+' has no complete import within 48 hours.'};break;}if(p==='gmail'&&(settings.get('gmail_query')||'-in:spam -in:trash')!=='-in:spam -in:trash'){coverage={fresh:false,reason:'Gmail search is filtered; relationship coverage is partial.'};break;}if(backlog.has(p)){coverage={fresh:false,reason:'Contact extraction is incomplete.'};break;}}
   const next=relationshipState(contact,interactions,{coverage}),old=oldStates.get(contact.id);
   states.push({contact_id:contact.id,state:next.state,basis:next.basis,rule_version:RULE_VERSION});
   if(old?.state!==next.state)history.push({id:uid(),contact_id:contact.id,from_state:old?.state||null,to_state:next.state,reason:next.basis.reason,basis:{...next.basis,reconnected:['Cooling','Dormant'].includes(old?.state)&&next.state==='Active'&&Date.parse(next.basis.last_meaningful_at)>Date.parse(old?.basis.last_meaningful_at||'1970-01-01')},rule_version:RULE_VERSION});
  }
  await run('INSERT INTO contact_states(contact_id,state,basis,rule_version) SELECT * FROM jsonb_to_recordset(?::jsonb) AS x(contact_id text,state text,basis jsonb,rule_version int) ON CONFLICT(contact_id) DO UPDATE SET state=excluded.state,basis=excluded.basis,evaluated_at=now(),rule_version=excluded.rule_version',JSON.stringify(states));
  if(history.length)await run('INSERT INTO contact_state_history(id,contact_id,from_state,to_state,reason,basis,rule_version) SELECT * FROM jsonb_to_recordset(?::jsonb) AS x(id text,contact_id text,from_state text,to_state text,reason text,basis jsonb,rule_version int)',JSON.stringify(history));
  if(!ids)await setSetting('contacts_last_evaluation',stamp());
 });
}
export async function confirmCoverage(id){await existingContact(id);await setSetting('contact_coverage:'+id,stamp());await evaluateContacts([id]);return{saved:true};}
export async function contactDetail(id,evaluate=true){
 const contact=await existingContact(id);if(evaluate)await evaluateContacts([id]);
 return{...contact,relationship:await one('SELECT * FROM contact_states WHERE contact_id=?',id),identities:await all('SELECT * FROM contact_identities WHERE contact_id=?',id),affiliations:await all('SELECT a.*,o.name AS organization FROM affiliations a JOIN organizations o ON o.id=a.organization_id WHERE contact_id=? ORDER BY ended_on NULLS FIRST,started_on DESC NULLS LAST',id),interactions:await readInteractions(id),history:await all('SELECT * FROM contact_state_history WHERE contact_id=? ORDER BY changed_at DESC LIMIT 40',id),items:await all('SELECT i.* FROM items i JOIN item_contacts c ON c.item_id=i.id WHERE c.contact_id=? ORDER BY i.created_at DESC',id),drafts:await all('SELECT * FROM message_drafts WHERE contact_id=? ORDER BY created_at DESC LIMIT 20',id),profile_source_id:'manual:contact-profile-'+id};
}
export async function listContacts({q='',segment='',tag='',archived=false,offset=0,limit=500,evaluate=true}={}){
 if(evaluate)await evaluateContacts();const where=['c.merged_into IS NULL','c.archived=?'],args=[archived===true||archived==='true'];
 if(q){where.push("(c.name ILIKE ? OR c.email ILIKE ? OR c.role ILIKE ? OR EXISTS(SELECT 1 FROM affiliations a JOIN organizations o ON o.id=a.organization_id WHERE a.contact_id=c.id AND o.name ILIKE ?) OR EXISTS(SELECT 1 FROM contact_identities i WHERE i.contact_id=c.id AND (i.display_name ILIKE ? OR i.address ILIKE ?)))");args.push(...Array(6).fill('%'+text(q,200)+'%'));}
 if(tag){where.push('c.tags @> ?::jsonb');args.push(JSON.stringify([tag]));}
 if(segment){if(!SEGMENTS.includes(segment))throw Error('Unknown relationship segment.');where.push("COALESCE(s.state,'Unclassified')=?");args.push(segment);}
 const from=' FROM contacts c LEFT JOIN contact_states s ON s.contact_id=c.id WHERE '+where.join(' AND ');
 const counts=await all("SELECT COALESCE(s.state,'Unclassified') AS state,count(*) AS n"+from+" GROUP BY COALESCE(s.state,'Unclassified')",...args);
 const records=await all(`SELECT c.*,COALESCE(s.state,'Unclassified') AS state,s.basis,(SELECT string_agg(o.name,', ' ORDER BY o.name) FROM affiliations a JOIN organizations o ON o.id=a.organization_id WHERE a.contact_id=c.id AND a.ended_on IS NULL) AS organization,(SELECT count(*) FROM item_contacts ic JOIN items i ON i.id=ic.item_id WHERE ic.contact_id=c.id AND i.status NOT IN ('done','dropped') AND i.checkpoint<>'' AND i.checkpoint<=CURRENT_DATE::text) AS promises_due,EXISTS(SELECT 1 FROM contact_state_history h WHERE h.contact_id=c.id AND h.from_state IN ('Cooling','Dormant') AND h.to_state='Active' AND h.basis->>'reconnected'='true' AND h.changed_at>now()-interval '14 days' AND (h.basis->>'last_meaningful_at')::timestamptz>now()-interval '14 days') AS reconnected`+from+' ORDER BY lower(c.name),c.id LIMIT ? OFFSET ?',...args,Math.min(500,Math.max(1,Math.floor(Number(limit)||500))),Math.max(0,Number(offset)||0));
 return{records,counts:Object.fromEntries(SEGMENTS.map(s=>[s,counts.find(c=>c.state===s)?.n||0])),total:counts.reduce((n,c)=>n+c.n,0),rule_version:RULE_VERSION};
}
export async function contactStatus(){return{queue:await all('SELECT state,count(*) AS n FROM contact_queue GROUP BY state'),runs:await all('SELECT * FROM contact_runs ORDER BY started_at DESC LIMIT 5'),reviews:await all("SELECT r.*,l.name AS left_name,rh.name AS right_name,l.email AS left_email,rh.email AS right_email FROM identity_reviews r JOIN contacts l ON l.id=r.left_id JOIN contacts rh ON rh.id=r.right_id WHERE r.status='pending' AND l.merged_into IS NULL AND rh.merged_into IS NULL ORDER BY r.created_at LIMIT 30"),duplicates:await all("SELECT i.*,d.title AS other_title,d.source_id AS other_source_id FROM interactions i JOIN interactions d ON d.id=i.duplicate_of WHERE i.duplicate_status='review' LIMIT 30"),exclusions:await all("SELECT exclusion,count(*) AS n FROM interactions WHERE exclusion<>'' GROUP BY exclusion"),last_evaluation:await getSetting('contacts_last_evaluation'),decisions:await all("SELECT d.id,d.kind,d.left_id,d.right_id,d.created_at,l.name AS left_name,r.name AS right_name FROM identity_decisions d JOIN contacts l ON l.id=d.left_id JOIN contacts r ON r.id=d.right_id WHERE d.undone_at IS NULL ORDER BY d.created_at DESC LIMIT 10")};}
export async function saveDraft(input){return transaction(async()=>{await lockWorkspace();const c=await existingContact(input.contact_id);if(c.do_not_contact||c.archived)throw Error('Drafting is disabled for this contact.');const old=input.id?await one('SELECT * FROM message_drafts WHERE id=? AND contact_id=?',input.id,c.id):null;if(input.id&&!old)throw Error('Draft not found.');if(old&&input.version!==old.version)throw Error('This draft changed. Reopen it.');const body=text(input.body,12000);if(!body)throw Error('Add text to the draft.');const id=old?.id||uid();await run('INSERT INTO message_drafts(id,contact_id,subject,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET subject=excluded.subject,body=excluded.body,version=message_drafts.version+1,updated_at=now()',id,c.id,text(input.subject,300),body);return one('SELECT * FROM message_drafts WHERE id=?',id);});}
export async function linkContactItem(input){return transaction(async()=>{await lockWorkspace();await existingContact(input.contact_id);if(!await one('SELECT id FROM items WHERE id=?',input.item_id))throw Error('Commitment not found.');if(input.remove)await run('DELETE FROM item_contacts WHERE item_id=? AND contact_id=?',input.item_id,input.contact_id);else await run('INSERT INTO item_contacts VALUES(?,?) ON CONFLICT DO NOTHING',input.item_id,input.contact_id);return{saved:true};});}
