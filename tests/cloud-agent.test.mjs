import {setupTestDatabase} from './helpers/postgres.mjs';
await setupTestDatabase();
import test from 'node:test';
import assert from 'node:assert/strict';
import {MockLanguageModelV4} from 'ai/test';
import {runCloudAgent} from '../lib/cloud-agent.mjs';
import {createJob} from '../lib/agent.mjs';
import {upsertSource,one,all} from '../lib/db.mjs';
const usage={inputTokens:{total:10,noCache:10,cacheRead:0,cacheWrite:0},outputTokens:{total:20,text:20,reasoning:0}};
const answer={brief:'Review complete.',findings:[{text:'A clear next step.',citations:[{source_id:'manual:cloud-fixture',source_version_id:'',quote:'The next step is to review the fictional proposal.'}]}],proposals:[],drafts:[],questions:[],coverage_note:'One fictional source was reviewed.'};
function model({invalid=false,noTools=false}={}){let step=0;return new MockLanguageModelV4({doGenerate:async()=>{
 if(step++===0&&!noTools)return{content:[{type:'tool-call',toolCallId:'read-fixture',toolName:'read_source',input:JSON.stringify({id:'manual:cloud-fixture'})}],finishReason:{unified:'tool-calls',raw:undefined},usage,warnings:[]};
 const value=structuredClone(answer);if(invalid)value.findings[0].citations[0].quote='This quote was fabricated by the fixture.';
 return{content:[{type:'text',text:JSON.stringify(value)}],finishReason:{unified:'stop',raw:undefined},usage,warnings:[]};
}});}
test('cloud agent uses read-only context tools, verifies evidence, and records usage in Postgres',async()=>{
 await upsertSource({provider:'manual',external_id:'cloud-fixture',title:'Fictional context',body:answer.findings[0].citations[0].quote});
 const id=await createJob('Review the fictional context.');await runCloudAgent(id,{model:model()});
 const job=await one('SELECT * FROM jobs WHERE id=?',id);assert.equal(job.status,'complete',job.error);assert.equal(JSON.parse(job.usage_json).totalTokens,60);
 assert.ok(JSON.parse(job.result_json).findings[0].citations[0].source_version_id);
 assert.equal((await all('SELECT * FROM items')).length,0);
 assert.equal((await one("SELECT count(*) AS n FROM job_events WHERE job_id=? AND label LIKE 'Reading:%'",id)).n,1);
});
test('cloud agent refuses fabricated citations and outputs produced without reading evidence',async()=>{
 for(const options of [{invalid:true},{noTools:true}]){const id=await createJob('Check the fictional context again.');await runCloudAgent(id,{model:model(options)});const job=await one('SELECT * FROM jobs WHERE id=?',id);assert.equal(job.status,'failed');assert.equal(job.result_json,null);}
});
test('cloud agent persists an actionable model-access failure and logs only safe diagnostics',async t=>{
 const log=t.mock.method(console,'error',()=>{});
 const id=await createJob('Test the fictional model-access failure.');
 const failure=Object.assign(new Error('Free tier users do not have access to this model.'),{statusCode:403,requestBodyValues:{prompt:'private-fixture-prompt'}});
 await runCloudAgent(id,{model:new MockLanguageModelV4({doGenerate:async()=>{throw failure;}})});
 const job=await one('SELECT status,error,result_json FROM jobs WHERE id=?',id);
 assert.equal(job.status,'failed');assert.equal(job.result_json,null);
 assert.match(job.error,/requires paid AI Gateway credits/);
 assert.equal(log.mock.calls.length,1);
 const diagnostic=log.mock.calls[0].arguments[1];
 assert.equal(diagnostic.jobId,id);assert.equal(diagnostic.statusCode,403);assert.equal(diagnostic.reason,'model_requires_paid_credits');
 assert.equal(JSON.stringify(diagnostic).includes('private-fixture-prompt'),false);
});
