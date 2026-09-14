import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
process.env.XIN_DATA_DIR=mkdtempSync(join(tmpdir(),'focus-contact-agent-'));
import {upsertSource,one,run,saveItem} from '../lib/db.mjs';
import {saveContact,contactDetail,saveDraft} from '../lib/contacts.mjs';
import {createJob,saveResult,validateResult,schema,cancelJob} from '../lib/agent.mjs';
const c=await saveContact({name:'Agent Fixture',tracked:true}),source=await upsertSource({provider:'manual',external_id:'agent-contact',title:'Fictional follow-up',body:'We agreed to review the draft together next week.',coverage:'document'});
const citation={source_id:source.id,quote:'We agreed to review the draft together next week.'};
const result={brief:'There is a recorded next step.',findings:[],proposals:[{title:'Review the fictional draft',kind:'action',rationale:'A recorded agreement',done_when:'Draft reviewed',next_action:'Prepare the draft',existing_item_id:'',uncertainty:'Date is not confirmed.',confidence:'high',contact_ids:[c.id],citations:[citation]}],drafts:[{contact_id:c.id,subject:'Draft review',body:'Shall we compare notes on the draft?',citations:[citation]}],questions:[],coverage_note:'One fictional source.'};
test('cited contact drafts stay internal and linked proposals use the existing item model',async()=>{
 const id=await createJob('Draft a follow-up');await saveResult(id,result);
 const detail=await contactDetail(c.id);assert.equal(detail.drafts.length,1);assert.equal(detail.drafts[0].status,'draft');assert.equal(detail.items.length,0);
 const p=await one('SELECT * FROM proposals WHERE job_id=?',id),payload=JSON.parse(p.payload),item=await saveItem({...payload,source_id:source.id,source_quote:citation.quote,source_version_id:payload.citations[0].source_version_id,proposal_id:p.id});
 assert.equal((await contactDetail(c.id)).items[0].id,item.id);
 const fields=schema.properties.proposals.items.properties;assert.ok(fields.contact_ids);assert.ok(schema.properties.drafts);
});
test('do-not-contact, fabricated drafts, unknown contacts and stale workers are rejected',async()=>{
 const forbidden=await saveContact({name:'No outreach',do_not_contact:true});
 await assert.rejects(validateResult({...result,drafts:[{...result.drafts[0],contact_id:forbidden.id}]}),/unavailable for drafting/);
 await assert.rejects(saveDraft({contact_id:forbidden.id,body:'Should not be saved.'}),/disabled/);
 await assert.rejects(validateResult({...result,drafts:[{...result.drafts[0],citations:[{...citation,quote:'A fabricated line from nowhere.'}]}]}),/unverified/);
 await assert.rejects(validateResult({...result,proposals:[{...result.proposals[0],contact_ids:['unknown']}]}),/unknown contact/);
 const id=await createJob('Cancelled review');await cancelJob(id);await assert.rejects(saveResult(id,result),/no longer running/);assert.equal((await one('SELECT count(*) AS n FROM message_drafts WHERE job_id=?',id)).n,0);
});
test('context MCP exposes contact reads and rejects writes',async()=>{
 const child=spawn(process.execPath,['scripts/context-mcp.mjs'],{env:process.env,stdio:['pipe','pipe','pipe']});
 let text='';child.stdout.on('data',d=>text+=d);
 const commands=[{jsonrpc:'2.0',id:1,method:'tools/list'},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'read_contact',arguments:{id:c.id}}},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'send_message',arguments:{}}}];
 child.stdin.end(commands.map(c=>JSON.stringify(c)).join('\n')+'\n');await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
 const replies=text.trim().split('\n').map(s=>JSON.parse(s));assert.equal(replies.length,3);
 const tools=replies[0].result.tools;assert.ok(tools.some(t=>t.name==='search_contacts'));assert.ok(tools.every(t=>t.annotations.readOnlyHint));assert.equal(JSON.parse(replies[1].result.content[0].text).name,c.name);assert.equal(replies[2].result.isError,true);
});
