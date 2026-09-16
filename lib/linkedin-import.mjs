import {parse} from 'csv-parse/sync';
import {all,run,transaction,lockWorkspace,uid,hash,stamp,dateOK} from './db.mjs';
import {emailAddress,personalEmail} from './contact-email.mjs';
import {evaluateContacts} from './contacts.mjs';

const headers=['First Name','Last Name','URL','Email Address','Company','Position','Connected On'];
const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export function linkedinProfileUrl(value){
 try{
  const url=new URL(String(value).trim());
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.port||!/(^|\.)linkedin\.com$/i.test(url.hostname))return '';
  const parts=url.pathname.split('/').filter(Boolean);
  if(parts.length!==2||parts[0].toLowerCase()!=='in')return '';
  const slug=decodeURIComponent(parts[1]).normalize('NFC').toLowerCase();
  if(!slug||/[\s/?#\\]/.test(slug))return '';
  return 'https://www.linkedin.com/in/'+encodeURIComponent(slug);
 }catch{return '';}
}
function connectionDate(value){
 if(!value)return '';
 if(dateOK(value))return value;
 const match=/^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/.exec(value);
 const month=match?months.findIndex(m=>m.toLowerCase()===match[2].toLowerCase()):-1;
 const iso=match&&month>=0?`${match[3]}-${String(month+1).padStart(2,'0')}-${match[1].padStart(2,'0')}`:'';
 return dateOK(iso)?iso:null;
}
export function parseLinkedinConnections(csv){
 if(typeof csv!=='string'||Buffer.byteLength(csv)>5_000_000)throw Error('Choose a LinkedIn Connections.csv smaller than 5 MB.');
 let values;
 try{values=parse(csv,{bom:true,skip_empty_lines:true,trim:true,relax_column_count:true});}catch{throw Error('Could not read LinkedIn Connections.csv. Check the CSV quoting.');}
 const start=values.findIndex((row,i)=>i<10&&headers.every(h=>row.includes(h)));
 if(start<0)throw Error('Choose LinkedIn Connections.csv with First Name, Last Name, URL, Email Address, Company, Position and Connected On columns.');
 const columns=values[start];
 if(values.length-start-1>5000)throw Error('Import up to 5,000 LinkedIn connections at a time.');
 const records=[],skipped=[],seen=new Map();
 for(const [offset,valuesRow] of values.slice(start+1).entries()){
  const row=offset+start+2;
  if(valuesRow.length!==columns.length)throw Error('LinkedIn row '+row+' has the wrong number of columns.');
  const raw=Object.fromEntries(columns.map((key,i)=>[key,valuesRow[i]]));
  const name=[raw['First Name'],raw['Last Name']].filter(Boolean).join(' ').trim();
  const email=emailAddress(raw['Email Address']),profile_url=linkedinProfileUrl(raw.URL);
  if(raw['Email Address']&&!email)throw Error('LinkedIn row '+row+' has an invalid email.');
  if(raw.URL&&!profile_url)throw Error('LinkedIn row '+row+' has an invalid profile URL.');
  if(!name||(!profile_url&&!personalEmail(email))){skipped.push({row,reason:'No identifiable profile'});continue;}
  const connected_on=connectionDate(raw['Connected On']);
  if(connected_on===null)throw Error('LinkedIn row '+row+' has an invalid connection date.');
  const record={name:name.slice(0,200),email,profile_url,company:raw.Company.slice(0,200),position:raw.Position.slice(0,200),connected_on,raw};
  record.key=profile_url||'email:'+personalEmail(email);
  const content=hash(record);
  if(seen.has(record.key)){
   if(seen.get(record.key)!==content)throw Error('LinkedIn export contains conflicting rows for the same profile.');
   skipped.push({row,reason:'Duplicate export row'});continue;
  }
  seen.set(record.key,content);records.push(record);
 }
 return{total:values.length-start-1,records,skipped};
}
const normalizedName=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
function nameKey(value){
 if(emailAddress(value))return '';
 const name=normalizedName(value),parts=name.split(' ');
 // Name evidence only proposes a review, including reversed two-part names.
 return parts.length<2?'':parts.length===2?parts.sort().join(' '):name;
}
function indexAdd(index,key,id){if(!key)return;if(!index.has(key))index.set(key,new Set());index.get(key).add(id);}
function document(record){
 const external_id='linkedin-connection-'+hash(record.key),id='manual:'+external_id;
 const raw={origin:'LinkedIn Connections.csv export',linkedin_connection:record};
 const values={title:'LinkedIn connection: '+record.name,occurred_at:'',body:[record.name,record.position,record.company,record.email,record.profile_url,record.connected_on?'Connected on LinkedIn: '+record.connected_on:'','Profile data from an export; a connection is not evidence of a conversation.'].filter(Boolean).join('\n'),url:record.profile_url,coverage:'document'};
 return{id,external_id,...values,content_hash:hash({values,raw}),raw_json:JSON.stringify(raw)};
}
async function plan(records){
 const [contacts,identities,sources]=await Promise.all([
  all('SELECT * FROM contacts WHERE merged_into IS NULL'),
  all('SELECT i.* FROM contact_identities i JOIN contacts c ON c.id=i.contact_id WHERE c.merged_into IS NULL'),
  all('SELECT id,content_hash FROM sources WHERE id=ANY(?::text[])',records.map(r=>document(r).id)),
 ]);
 const byId=new Map(contacts.map(c=>[c.id,c])),byEmail=new Map(),byName=new Map(),byKey=new Map(),sourceHashes=new Map(sources.map(s=>[s.id,s.content_hash]));
 for(const c of contacts){indexAdd(byEmail,personalEmail(c.email),c.id);if(!c.archived)indexAdd(byName,nameKey(c.name),c.id);}
 for(const i of identities){indexAdd(byEmail,personalEmail(i.address),i.contact_id);if(!byId.get(i.contact_id).archived)indexAdd(byName,nameKey(i.display_name),i.contact_id);if(i.provider==='linkedin')indexAdd(byKey,linkedinProfileUrl(i.external_key)||i.external_key,i.contact_id);}
 const changed=[],newContacts=[],updates=new Map(),reviews=new Map(),summary={added:0,matched:0,unchanged:0,conflicts:0,review_pairs:0};
 const addReview=(a,b,reason)=>{if(a===b)return;const [left_id,right_id]=[a,b].sort();reviews.set(left_id+':'+right_id,{id:uid(),left_id,right_id,reason});};
 for(const record of records){
  const ids=byKey.get(record.key)||new Set(),emailIds=byEmail.get(personalEmail(record.email))||new Set();
  if(ids.size>1||emailIds.size>1||(ids.size===1&&emailIds.size===1&&[...ids][0]!==[...emailIds][0])){
   const conflicting=[...new Set([...ids,...emailIds])];
   for(let i=0;i<conflicting.length;i++)for(let j=i+1;j<conflicting.length;j++)addReview(conflicting[i],conflicting[j],'LinkedIn profile and email bindings conflict; verify the exported profile before merging.');
   summary.conflicts++;continue;
  }
  const found=[...ids][0]||[...emailIds][0],doc=document(record);
  if(found&&sourceHashes.get(doc.id)===doc.content_hash){summary.unchanged++;continue;}
  let contact=found?byId.get(found):null;
  if(contact){
   summary.matched++;
   // Fill missing fields without replacing chosen names, notes or relationship preferences.
   const email=contact.email||personalEmail(record.email),role=contact.role||record.position;
   if(email!==contact.email||role!==contact.role){contact={...contact,email,role};updates.set(contact.id,{id:contact.id,email,role});byId.set(contact.id,contact);}
  }else{
   contact={id:uid(),name:record.name,email:personalEmail(record.email),role:record.position,archived:false};
   newContacts.push(contact);byId.set(contact.id,contact);summary.added++;
  }
  indexAdd(byKey,record.key,contact.id);indexAdd(byEmail,personalEmail(record.email),contact.id);
  if(!contact.archived){
   for(const other of byName.get(nameKey(record.name))||[])addReview(contact.id,other,'Same name as a LinkedIn connection; verify the profile and organization before merging.');
   indexAdd(byName,nameKey(record.name),contact.id);
  }
  changed.push({record,doc,contact_id:contact.id});
 }
 summary.review_pairs=reviews.size;
 return{summary,changed,newContacts,updates:[...updates.values()],reviews:[...reviews.values()]};
}

export async function previewLinkedinConnections(parsed){
 const planned=await plan(parsed.records);
 return{total:parsed.total,identifiable:parsed.records.length,skipped:parsed.skipped.length,...planned.summary};
}

// The CLI commits bounded batches. Retrying the same export resumes through stable
// profile bindings and source hashes, without duplicating contacts or snapshots.
export async function importLinkedinBatch(records){
 if(!Array.isArray(records)||records.length>100)throw Error('Import at most 100 LinkedIn connections per batch.');
 return transaction(async()=>{
  await lockWorkspace();
  const {summary,changed,newContacts,updates,reviews}=await plan(records);
  if(newContacts.length)await run("INSERT INTO contacts(id,name,email,role,confirmed) SELECT id,name,email,role,false FROM jsonb_to_recordset(?::jsonb) AS x(id text,name text,email text,role text)",JSON.stringify(newContacts));
  if(updates.length)await run('UPDATE contacts c SET email=x.email,role=x.role,version=c.version+1,updated_at=now() FROM jsonb_to_recordset(?::jsonb) AS x(id text,email text,role text) WHERE c.id=x.id',JSON.stringify(updates));
  if(changed.length){
   const time=stamp(),docs=changed.map(({doc})=>({...doc,version_id:uid(),time}));
   await run("INSERT INTO sources(id,provider,external_id,title,occurred_at,body,url,coverage,content_hash,imported_at,updated_at) SELECT id,'manual',external_id,title,occurred_at,body,url,coverage,content_hash,time,time FROM jsonb_to_recordset(?::jsonb) AS x(id text,external_id text,title text,occurred_at text,body text,url text,coverage text,content_hash text,time text) ON CONFLICT(id) DO UPDATE SET title=excluded.title,body=excluded.body,url=excluded.url,content_hash=excluded.content_hash,updated_at=excluded.updated_at",JSON.stringify(docs));
   await run('INSERT INTO source_versions(id,source_id,content_hash,raw_json,fetched_at,normalized_body) SELECT version_id,id,content_hash,raw_json,time,body FROM jsonb_to_recordset(?::jsonb) AS x(version_id text,id text,content_hash text,raw_json text,time text,body text) ON CONFLICT(source_id,content_hash) DO NOTHING',JSON.stringify(docs));
   const bindings=changed.map(({record:r,doc,contact_id})=>({id:uid(),contact_id,key:r.key,name:r.name,email:personalEmail(r.email),source_id:doc.id}));
   await run("INSERT INTO contact_identities(id,contact_id,provider,account,external_key,display_name,address,source_id) SELECT id,contact_id,'linkedin','workspace',key,name,email,source_id FROM jsonb_to_recordset(?::jsonb) AS x(id text,contact_id text,key text,name text,email text,source_id text) ON CONFLICT(provider,account,external_key) DO UPDATE SET display_name=excluded.display_name,address=CASE WHEN excluded.address<>'' THEN excluded.address ELSE contact_identities.address END,source_id=excluded.source_id",JSON.stringify(bindings));
   const companies=[...new Set(changed.map(c=>c.record.company).filter(Boolean).map(c=>c.toLowerCase()))];
   const orgs=companies.map(key=>({id:uid(),name:changed.find(c=>c.record.company.toLowerCase()===key).record.company}));
   if(orgs.length){
    await run('INSERT INTO organizations(id,name) SELECT id,name FROM jsonb_to_recordset(?::jsonb) AS x(id text,name text) ON CONFLICT(lower(name)) DO NOTHING',JSON.stringify(orgs));
    const affiliations=[...new Map(changed.filter(c=>c.record.company).map(c=>[JSON.stringify([c.contact_id,c.record.company.toLowerCase(),c.record.position]),{id:uid(),contact_id:c.contact_id,company:c.record.company,role:c.record.position}])).values()];
    await run('INSERT INTO affiliations(id,contact_id,organization_id,role) SELECT x.id,x.contact_id,o.id,x.role FROM jsonb_to_recordset(?::jsonb) AS x(id text,contact_id text,company text,role text) JOIN organizations o ON lower(o.name)=lower(x.company) WHERE NOT EXISTS(SELECT 1 FROM affiliations a WHERE a.contact_id=x.contact_id AND a.organization_id=o.id AND a.role=x.role)',JSON.stringify(affiliations));
   }
   // Profile metadata is not an interaction and must never enter the activity queue.
   await evaluateContacts([...new Set(changed.map(c=>c.contact_id))]);
  }
  if(reviews.length){
   const inserted=await run('INSERT INTO identity_reviews(id,left_id,right_id,reason) SELECT id,left_id,right_id,reason FROM jsonb_to_recordset(?::jsonb) AS x(id text,left_id text,right_id text,reason text) ON CONFLICT(left_id,right_id) DO NOTHING',JSON.stringify(reviews));
   summary.review_pairs=inserted.changes;
  }
  return summary;
 });
}
