import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setupTestDatabase} from './helpers/postgres.mjs';
const privateDir=mkdtempSync(join(tmpdir(),'focus-manual-ingestion-'));process.env.XIN_DATA_DIR=privateDir;
await setupTestDatabase();
const {one,run}=await import('../lib/db.mjs');
const {createManualUpload,appendManualChunk,finishManualUpload,cancelManualUpload,prepareManualRecords,advanceManual,MAX_IMPORT_BYTES,MAX_IMPORT_CHUNK_BYTES,MAX_IMPORT_RECORD_BYTES}=await import('../lib/manual-ingestion.mjs');
const {normalizeResearchArchive,importResearchArchive}=await import('../lib/imports.mjs');
const fictional=(id='fictional-1')=>({provider:'manual',external_id:id,title:'Fictional research note',body:'Taylor will review the fictional prototype.',coverage:'document'});
async function upload(text,{format='json',title='fictional.json'}={}){
 const {id}=await createManualUpload({format,title,bytes:Buffer.byteLength(text)});
 let parts=0;for(let offset=0;offset<text.length;offset+=128*1024)await appendManualChunk({id,part:parts++,content:text.slice(offset,offset+128*1024)});
 await finishManualUpload({id,parts});return id;
}
test.beforeEach(async()=>{
 await run('DELETE FROM import_records');await run('DELETE FROM import_uploads');await run('DELETE FROM sync_runs');
});
test.after(()=>rmSync(privateDir,{recursive:true,force:true}));

test('upload chunks replay safely, reject changes, and account for exact Unicode bytes',async()=>{
 const text='Hello 🙂 café 世界';
 const {id}=await createManualUpload({format:'text',title:'Fictional Unicode.txt',bytes:Buffer.byteLength(text)});
 const first=await appendManualChunk({id,part:0,content:text});
 assert.equal(first.received_bytes,Buffer.byteLength(text));
 assert.deepEqual(await appendManualChunk({id,part:0,content:text}),first);
 assert.equal((await one('SELECT count(*) AS n FROM import_chunks WHERE run_id=?',id)).n,1);
 await assert.rejects(appendManualChunk({id,part:0,content:'Different text'}),/differs from the saved part/);
 assert.deepEqual(await finishManualUpload({id,parts:1}),{id,queued:true});
 assert.deepEqual(await finishManualUpload({id,parts:1}),{id,queued:true});
 await assert.rejects(appendManualChunk({id,part:1,content:'late'}),/already closed/);
 const initial=await advanceManual(id,null);
 assert.equal(initial.records.length,0);
 const step=await advanceManual(id,initial.cursor);
 assert.equal(step.records[0].doc.body,text);assert.equal(step.complete,true);
 assert.deepEqual(await advanceManual(id,initial.cursor),step);
 assert.equal((await one('SELECT count(*) AS n FROM sources')).n,0);
});

test('finish rejects missing or mis-sized chunks without making the upload runnable',async()=>{
 const {id}=await createManualUpload({format:'text',title:'Fictional.txt',bytes:8});
 await appendManualChunk({id,part:1,content:'1234'});
 await assert.rejects(finishManualUpload({id,parts:1}),/incomplete/);
 await appendManualChunk({id,part:0,content:'🙂'});
 assert.deepEqual(await finishManualUpload({id,parts:2}),{id,queued:true});
 await run("UPDATE sync_runs SET state='complete' WHERE id=?",id);
 const second=await createManualUpload({format:'text',title:'Fictional second.txt',bytes:5});
 await appendManualChunk({id:second.id,part:0,content:'1234'});
 await assert.rejects(finishManualUpload({id:second.id,parts:1}),/size does not match/);
 await assert.rejects(appendManualChunk({id:second.id,part:1,content:'67'}),/exceeds its declared size/);
 assert.equal((await one('SELECT state FROM sync_runs WHERE id=?',second.id)).state,'uploading');
});

test('uploading holds the shared import slot and cancelling releases staging safely',async()=>{
 const request={format:'text',title:'Fictional.txt',bytes:4};
 const {id}=await createManualUpload(request);
 await appendManualChunk({id,part:0,content:'text'});
 await assert.rejects(createManualUpload(request),/already active/);
 assert.equal((await cancelManualUpload({id})).cancelled,true);
 assert.equal((await one('SELECT count(*) AS n FROM import_chunks WHERE run_id=?',id)).n,0);
 assert.equal((await cancelManualUpload({id})).cancelled,false);
 const queued=await upload('text',{format:'text'});
 assert.equal((await cancelManualUpload({id:queued})).cancelled,false);
 assert.equal((await one('SELECT state FROM sync_runs WHERE id=?',queued)).state,'queued');
});

test('a malformed archive or invalid later record stages nothing and never partially ingests',async()=>{
 for(const text of ['[{"title":"private fixture detail"}',JSON.stringify([fictional(),{body:'Invalid later private fixture record'}]),JSON.stringify([fictional(),{...fictional('bad-unicode'),body:'bad\u0000text'}])]){
  const id=await upload(text);
  await assert.rejects(prepareManualRecords(id),error=>error.permanent&&!error.message.includes('private fixture'));
  assert.equal((await one('SELECT count(*) AS n FROM import_records WHERE run_id=?',id)).n,0);
  assert.equal((await one('SELECT count(*) AS n FROM sources')).n,0);
  await run("UPDATE sync_runs SET state='failed' WHERE id=?",id);
 }
});

test('staging replays once and each advance returns a single ordered source record',async()=>{
 const id=await upload(JSON.stringify([fictional('one'),fictional('two'),fictional('three')]));
 assert.deepEqual(await prepareManualRecords(id),{total:3});
 assert.deepEqual(await prepareManualRecords(id),{total:3});
 let result=await advanceManual(id);assert.equal(result.records.length,0);
 for(const externalId of ['one','two','three']){
  result=await advanceManual(id,result.cursor);assert.equal(result.records.length,1);assert.equal(result.records[0].doc.external_id,externalId);
 }
 assert.equal(result.complete,true);assert.deepEqual((await advanceManual(id,result.cursor)).records,[]);
 assert.equal((await one('SELECT count(*) AS n FROM import_records WHERE run_id=?',id)).n,3);
});

test('server size, record-count, normalized-record, and Unicode limits are enforced',async()=>{
 await assert.rejects(createManualUpload({format:'text',title:'Fictional.txt',bytes:MAX_IMPORT_BYTES+1}),/up to 64 MiB/);
 const {id}=await createManualUpload({format:'text',title:'Fictional.txt',bytes:MAX_IMPORT_CHUNK_BYTES+1});
 await assert.rejects(appendManualChunk({id,part:0,content:'x'.repeat(MAX_IMPORT_CHUNK_BYTES+1)}),/512 KiB/);
 await assert.rejects(appendManualChunk({id,part:0,content:'\uD800'}),/valid text/);
 await cancelManualUpload({id});
 const tooMany=await upload(JSON.stringify(Array.from({length:5001},(_,i)=>fictional('fixture-'+i))));
 await assert.rejects(prepareManualRecords(tooMany),/5,000/);
 await run("UPDATE sync_runs SET state='failed' WHERE id=?",tooMany);
 const tooLarge=await upload('x'.repeat(MAX_IMPORT_RECORD_BYTES/2+1),{format:'text'});
 await assert.rejects(prepareManualRecords(tooLarge),/20 MiB after normalization/);
 assert.equal((await one('SELECT count(*) AS n FROM import_records')).n,0);
});

test('special research archives share the existing pure normalization and transcript fidelity',async()=>{
 const archive={fireflies_records:[{id:'fictional-meeting',title:'Fictional planning meeting',summary:{overview:'A summary'}}],tool_responses:{ff_details:'Id: fictional-meeting\n[00:01] Taylor: Preserve this exact fictional sentence.'}};
 const normalized=normalizeResearchArchive(archive);
 assert.equal(normalized.length,1);assert.equal(normalized[0].doc.coverage,'transcript');assert.match(normalized[0].doc.body,/Preserve this exact fictional sentence/);
 const id=await upload(JSON.stringify(archive));
 await prepareManualRecords(id);
 const staged=(await one('SELECT payload FROM import_records WHERE run_id=?',id)).payload;
 for(const key of ['provider','external_id','title','body','coverage'])assert.equal(staged.doc[key],normalized[0].doc[key]);
 assert.deepEqual(staged.raw,normalized[0].raw);
 const imported=await importResearchArchive(archive);assert.deepEqual(imported,{total:1,changed:1});
 assert.deepEqual(await importResearchArchive(archive),{total:1,changed:0});
});
