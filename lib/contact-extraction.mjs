import addresses from 'email-addresses';
import {all,one,run,transaction,lockWorkspace,uid,stamp,hash,getSetting,upsertSource} from './db.mjs';
import {emailAddress,suggestIdentityMatches,evaluateContacts,existingContact} from './contacts.mjs';
import {resolveExactEmailContact} from './contact-identity.mjs';
const shared=/^(no-?reply|do-?not-?reply|notifications?|support|info|hello|team|billing|newsletter|sales|admin|contact|help|office|accounts?|calendar)([.+_-]|@)/i;
export function mailboxes(value){const parsed=addresses.parseAddressList(String(value||''))||[];return parsed.flatMap(p=>p.type==='group'?p.addresses:[p]).filter(p=>p.type==='mailbox').map(p=>({name:p.name||p.address,address:p.address.toLowerCase()}));}
const validTime=value=>value&&!isNaN(Date.parse(value))?new Date(value).toISOString():null;
export function extractInteraction(source,raw,ownerAddresses){
 const owners=new Set(ownerAddresses.filter(Boolean).map(e=>e.toLowerCase()));
 if(raw.contact_profile)return null;
 if(source.provider==='manual'){
  const e=raw.contact_event;if(!e)return null;
  return{kind:e.kind||'note',occurred_at:validTime(e.occurred_at),direction:e.direction||'mutual',qualified:e.meaningful===true,exclusion:'',thread_key:'',participants:[{contact_id:e.contact_id,role:'participant'}]};
 }
 if(source.provider==='gmail'){
  const headers=Object.fromEntries((raw.payload?.headers||[]).map(h=>[h.name.toLowerCase(),h.value]));
  const from=mailboxes(headers.from),to=mailboxes(headers.to),cc=mailboxes(headers.cc),sender=from[0],outbound=sender&&owners.has(sender.address),incoming=to.some(p=>owners.has(p.address));
  const automated=!!headers['list-id']||!!headers['list-unsubscribe']||/bulk|list|junk/i.test(headers.precedence||'')||!!headers['auto-submitted']&&headers['auto-submitted'].toLowerCase()!=='no'||shared.test(sender?.address||'');
  const occurred_at=Number(raw.internalDate)>0?validTime(new Date(Number(raw.internalDate)).toISOString()):validTime(headers.date);
  const exclusion=raw.deleted||source.coverage==='deleted upstream'?'Deleted upstream':automated?'Automated or shared mailbox':from.length!==1?'Sender could not be verified':!outbound&&!incoming?'Owner was copied or absent':!occurred_at?'Event date unavailable':!source.body||source.coverage!=='email body'?'Email body unavailable':'';
  const participants=[...from.map(p=>({...p,role:'sender'})),...to.map(p=>({...p,role:outbound?'recipient':'cc'})),...cc.map(p=>({...p,role:'cc'}))].filter(p=>!owners.has(p.address)&&!shared.test(p.address));
  return{kind:'email',occurred_at,direction:outbound?'outbound':incoming?'inbound':'unknown',qualified:!exclusion,exclusion,thread_key:raw.threadId||'',participants:automated?[]:participants};
 }
 if(source.provider==='beeper'){
  const c=raw.chat||{},m=raw.message||{},people=c.participants?.items||[],peers=people.filter(p=>!p.isSelf),occurred_at=validTime(m.timestamp);
  const verified=c.type==='single'&&!c.participants?.hasMore&&peers.length===1&&people.some(p=>p.isSelf)&&people.some(p=>p.id===m.senderID&&p.isSelf===m.isSender);
  const exclusion=m.isDeleted||m.isHidden?'Deleted upstream':!verified?'Direct conversation participants need confirmation':peers.some(p=>p.isNetworkBot)?'Automated account':!occurred_at?'Event date unavailable':source.coverage!=='message body'||!m.text?.trim()||['NOTICE','REACTION','STICKER'].includes(m.type)?'Message content unavailable or not a conversation':'';
  return{kind:'message',account:c.accountID||'',occurred_at,direction:m.isSender===true?'outbound':m.isSender===false?'inbound':'unknown',qualified:!exclusion,exclusion,thread_key:c.id||'',participants:peers.filter(p=>!p.isNetworkBot).map(p=>({name:p.fullName||m.senderName||'Beeper contact',address:emailAddress(p.email),external_id:p.id,role:verified?'participant':'uncertain'}))};
 }
 const meta=raw.metadata||raw;
 const entries=Array.isArray(meta.participants)?meta.participants:Array.isArray(meta.attendees)?meta.attendees:Array.isArray(meta.calendar_event?.attendees)?meta.calendar_event.attendees:[];
 const people=entries.flatMap(p=>typeof p==='string'?mailboxes(p):p.email?[{name:p.name||p.displayName||p.email,address:emailAddress(p.email)}]:p.name?[{name:p.name,address:'',external_id:p.id||''}]:[]);
 const ownerPresent=people.some(p=>owners.has(p.address));
 const participants=people.filter(p=>!owners.has(p.address)&&!shared.test(p.address)).map(p=>({...p,role:p.address&&ownerPresent?'participant':'uncertain'}));
 // A speaker name alone is an observation scoped to this recording, never a global identity.
 if(!participants.length){const names=[...new Set((meta.sentences||raw.transcript||[]).filter?.(p=>typeof p==='object').map(p=>p.speaker_name||p.speaker?.name).filter(Boolean)||[])];for(const name of names)participants.push({name,address:'',role:'uncertain'});}
 const occurred_at=validTime(meta.dateString||meta.calendar_event?.start_time||meta.start_time||source.occurred_at);
 const exclusion=!ownerPresent?'Attendance needs confirmation':!occurred_at?'Event date unavailable':!['transcript','summary'].includes(source.coverage)?'Meeting content unavailable':'';
 return{kind:'meeting',occurred_at,direction:'mutual',qualified:!exclusion,exclusion,thread_key:'',participants};
}
async function bindIdentity(source,person,account){
 if(person.contact_id){let id=person.contact_id;for(let n=0;n<50;n++){const c=await one('SELECT id,merged_into FROM contacts WHERE id=?',id);if(!c)throw Error('Contact not found.');if(!c.merged_into)return c.id;id=c.merged_into;}throw Error('Identity merge chain is invalid.');}
 const address=emailAddress(person.address),external=(source.provider==='beeper'?person.external_id:'')||address||person.external_id||source.id+':speaker:'+hash(person.name||'unknown').slice(0,20);
 const old=await one('SELECT contact_id,address FROM contact_identities WHERE provider=? AND account=? AND external_key=?',source.provider,account,external);
 if(old){
  const contact=await one('SELECT * FROM contacts WHERE id=?',old.contact_id);
  if(address&&!old.address&&!contact.email){
   await run('UPDATE contact_identities SET address=? WHERE provider=? AND account=? AND external_key=?',address,source.provider,account,external);
   await run('UPDATE contacts SET email=? WHERE id=?',address,contact.id);contact.email=address;
  }
  await resolveExactEmailContact(contact.email);
  return bindIdentity(source,{contact_id:old.contact_id},account);
 }
 const match=await resolveExactEmailContact(address),id=match?.id||uid(),name=String(person.name||address||'Unknown participant').slice(0,200);
 if(!match)await run('INSERT INTO contacts(id,name,email,confirmed) VALUES(?,?,?,false)',id,name,address);
 else if(!match.confirmed&&match.version===1&&[match.email,match.email.split('@')[0],'unknown participant'].includes(match.name.toLowerCase())&&!emailAddress(name)&&name.toLowerCase()!==address.split('@')[0])await run('UPDATE contacts SET name=?,version=version+1,updated_at=now() WHERE id=?',name,id);
 await run('INSERT INTO contact_identities(id,contact_id,provider,account,external_key,display_name,address,source_id) VALUES(?,?,?,?,?,?,?,?)',uid(),id,source.provider,account,external,name,address,source.id);
 if(!match)await suggestIdentityMatches(id,name,address);return id;
}
export async function projectSource(sourceId,guard=async()=>{}){
 const result=await transaction(async()=>{
  await lockWorkspace();await guard();
  const source=await one('SELECT * FROM sources WHERE id=?',sourceId);if(!source)return{contacts:[]};
  const snapshot=await one('SELECT * FROM source_versions WHERE source_id=? AND content_hash=?',sourceId,source.content_hash);if(!snapshot)throw Error('Matching source snapshot is unavailable.');
  const raw=JSON.parse(snapshot.raw_json),owner=await getSetting('gmail_email',process.env.XIN_ALLOWED_EMAIL||''),aliases=await getSetting('contact_owner_aliases',[]);
  const event=extractInteraction(source,raw,[owner,process.env.XIN_ALLOWED_EMAIL,...aliases]);
  const old=await one('SELECT * FROM interactions WHERE source_id=?',sourceId),previous=old?await all('SELECT contact_id,role FROM interaction_participants WHERE interaction_id=?',old.id):[];
  const contacts=previous.map(p=>p.contact_id);
  if(event){
   if(raw.deleted&&old){event.participants=previous;event.occurred_at=old.occurred_at;event.direction=old.direction;}
   const id=old?.id||uid();let duplicate=old?.duplicate_of||null,status=old?.duplicate_status||'';
   if(!old&&event.kind==='meeting'&&event.occurred_at){const match=await one("SELECT i.id FROM interactions i JOIN sources s ON s.id=i.source_id WHERE i.kind='meeting' AND s.provider<>? AND i.duplicate_of IS NULL AND lower(regexp_replace(i.title,'[^[:alnum:]]','','g'))=lower(regexp_replace(?,'[^[:alnum:]]','','g')) AND abs(extract(epoch FROM(i.occurred_at-?::timestamptz)))<=600 ORDER BY i.id LIMIT 1",source.provider,source.title,event.occurred_at);if(match){duplicate=match.id;status='review';}}
   const correction=await getSetting('interaction_review:'+id);
   if(correction?.action==='exclude'){event.qualified=false;event.exclusion='Excluded by you';}
   if(correction?.action==='include'&&correction.content_hash===source.content_hash){event.qualified=true;event.exclusion='';for(const p of event.participants)if(p.role==='uncertain')p.role='participant';}
   await run('INSERT INTO interactions(id,source_id,kind,title,occurred_at,direction,qualified,exclusion,thread_key,duplicate_of,duplicate_status) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET title=excluded.title,occurred_at=excluded.occurred_at,direction=excluded.direction,qualified=excluded.qualified,exclusion=excluded.exclusion,thread_key=excluded.thread_key,version=interactions.version+1',id,sourceId,event.kind,source.title,event.occurred_at,event.direction,event.qualified,event.exclusion,event.thread_key,duplicate,status);
   await run('DELETE FROM interaction_participants WHERE interaction_id=?',id);
   for(const person of event.participants){const contact=await bindIdentity(source,person,event.account||owner||'workspace');contacts.push(contact);await run('INSERT INTO interaction_participants VALUES(?,?,?) ON CONFLICT DO NOTHING',id,contact,person.role);}
   await run('INSERT INTO interaction_sources VALUES(?,?,?,?) ON CONFLICT DO NOTHING',id,snapshot.id,sourceId,source.body.slice(0,700));
  }else if(old){await run("UPDATE interactions SET qualified=false,exclusion='No current interaction evidence',version=version+1 WHERE id=?",old.id);}
  await run("UPDATE contact_queue SET state='complete',error='',updated_at=now() WHERE source_id=? AND content_hash=?",sourceId,source.content_hash);
  return{contacts:[...new Set(contacts)]};
 });if(result.contacts.length)await evaluateContacts(result.contacts);return result;
}
export async function logInteraction(input){
 const c=await existingContact(input.contact_id),time=validTime(input.occurred_at);
 if(!time||Date.parse(time)>Date.now()+300000)throw Error('Choose the actual past interaction date.');
 if(!['meeting','note','email'].includes(input.kind)||!['mutual','inbound','outbound'].includes(input.direction))throw Error('Choose a valid interaction type and direction.');
 const body=String(input.body||'').trim().slice(0,12000);if(!body)throw Error('Describe the interaction.');
 const doc=await upsertSource({provider:'manual',external_id:'contact-event-'+uid(),title:input.title||'Interaction with '+c.name,occurred_at:time,body,coverage:'document'},{contact_event:{contact_id:c.id,kind:input.kind,direction:input.direction,occurred_at:time,meaningful:input.meaningful===true}});
 await projectSource(doc.id);return{saved:true};
}
export async function reviewInteraction(input){
 await transaction(async()=>{await lockWorkspace();const i=await one('SELECT * FROM interactions WHERE id=? FOR UPDATE',input.id);if(!i)throw Error('Interaction not found.');if(input.version!==i.version)throw Error('This interaction changed. Reopen it.');
 if(input.action==='duplicate'||input.action==='separate'){if(!i.duplicate_of)throw Error('This interaction has no duplicate candidate.');await run('UPDATE interactions SET duplicate_of=?,duplicate_status=?,version=version+1 WHERE id=?',input.action==='duplicate'?i.duplicate_of:null,input.action==='duplicate'?'confirmed':'separate',i.id);}
 else if(input.action==='include'||input.action==='exclude'){if(!i.occurred_at)throw Error('An interaction needs an actual date before it can affect the map.');await run('UPDATE interactions SET qualified=?,exclusion=?,version=version+1 WHERE id=?',input.action==='include',input.action==='include'?'':'Excluded by you',i.id);if(input.action==='include')await run("UPDATE interaction_participants SET role='participant' WHERE interaction_id=? AND role='uncertain'",i.id);}
 else throw Error('Choose a valid review action.');
 await run('INSERT INTO interaction_decisions(id,interaction_id,action,before_snapshot,after_snapshot) VALUES(?,?,?,?::jsonb,?::jsonb)',uid(),i.id,input.action,JSON.stringify(i),JSON.stringify(await one('SELECT * FROM interactions WHERE id=?',i.id)));
 await run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value','interaction_review:'+i.id,JSON.stringify({action:input.action,at:stamp(),content_hash:(await one('SELECT content_hash FROM sources WHERE id=?',i.source_id))?.content_hash}));
 });await evaluateContacts((await all('SELECT contact_id FROM interaction_participants WHERE interaction_id=?',input.id)).map(p=>p.contact_id));return{saved:true};
}
