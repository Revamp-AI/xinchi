import {upsertSource,hash} from './db.mjs';
const textOf=v=>typeof v==='string'?v:(v?.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
const decode=t=>t.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&apos;/g,"'");
export function normalizeResearchArchive(archive,pasted=''){
 const docs=new Map();
 for(const r of archive.fireflies_records||[]){
  const summary=r.summary||{};
  const body=typeof summary==='string'?summary:Object.entries(summary).map(([k,v])=>v?`${k.replaceAll('_',' ')}\n${Array.isArray(v)?v.join('\n'):v}`:'').filter(Boolean).join('\n\n');
  docs.set('fireflies:'+r.id,{provider:'fireflies',external_id:r.id,title:r.title||'Untitled meeting',occurred_at:r.dateString||'',body,url:`https://app.fireflies.ai/view/${r.id}`,coverage:body?'summary':'metadata',raw:r});
 }
 for(const r of archive.granola_index||[])docs.set('granola:'+r.id,{provider:'granola',external_id:r.id,title:r.title,occurred_at:r.date,body:'',coverage:'metadata',raw:r});
 for(const [key,val] of Object.entries(archive.tool_responses||{})){
  const t=textOf(val);
  if(key.startsWith('ff_')){
   const id=t.match(/^Id: (\S+)/m)?.[1];const d=docs.get('fireflies:'+id);
   if(d){d.raw={metadata:d.raw,transcript_response:t};if(/\[\d\d:\d\d.*?\]/.test(t)){d.body+='\n\nTranscript\n'+t;d.coverage='transcript';}}
  }
  if(key.startsWith('granola_')){
   for(const m of t.matchAll(/<meeting id="([^"]+)" title="([^"]+)" date="([^"]+)">([\s\S]*?)<\/meeting>/g)){
    const d=docs.get('granola:'+m[1]);if(d){const body=decode(m[4].replace(/<\/?(?:known_participants|summary|notes)[^>]*>/g,''));d.body=body;d.coverage=/empty recording|transcript appears to be empty|no (?:notes|summary|transcript)|no content/i.test(body)&&body.length<600?'empty':'summary';d.raw={...d.raw,detail_response:m[0]};}
   }
   if(key.includes('_transcript')){
    try{const parsed=JSON.parse(t.slice(t.indexOf('{')));const d=docs.get('granola:'+parsed.id);if(d&&parsed.transcript){d.body+='\n\nTranscript\n'+parsed.transcript;d.coverage='transcript';d.raw={...d.raw,transcript:parsed.transcript};}}catch{}
   }
  }
 }
 if(pasted){const id='pasted-'+hash(pasted).slice(0,24);docs.set('manual:'+id,{provider:'manual',external_id:id,title:'Imported transcript',occurred_at:'',body:pasted,coverage:'transcript',raw:{text:pasted,origin:'User-provided transcript'}});}
 return [...docs.values()].map(({raw,...doc})=>({doc,raw}));
}
export async function importResearchArchive(archive,pasted=''){
 const records=normalizeResearchArchive(archive,pasted);
 let changed=0;for(const {doc,raw} of records)if((await upsertSource(doc,raw)).changed)changed++;return{total:records.length,changed};
}
export async function importDocuments(docs){if(!Array.isArray(docs)||docs.length>5000)throw Error('Import an array of up to 5,000 source records.');let changed=0;for(const d of docs)if((await upsertSource(d,d.raw||d)).changed)changed++;return{total:docs.length,changed};}
