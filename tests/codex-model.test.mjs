import test from 'node:test';
import assert from 'node:assert/strict';
import {generateText} from 'ai';
import {createCodexModel} from '../lib/codex-model.mjs';
import {cloudReviewFailure} from '../lib/cloud-errors.mjs';
const session={accessToken:'fictional-access-token',accountId:'fictional-account'};
const message=text=>({type:'message',content:[{type:'output_text',text}]});
export function stream(events,{split=false}={}){
 const text=events.map(e=>'data: '+JSON.stringify(e)+'\r\n\r\n').join(''),bytes=new TextEncoder().encode(text);
 return new Response(new ReadableStream({start(controller){if(split)for(const byte of bytes)controller.enqueue(Uint8Array.of(byte));else controller.enqueue(bytes);controller.close();}}),{headers:{'Content-Type':'text/event-stream'}});
}
export const completed=output=>({type:'response.completed',response:{id:'fictional-response',status:'completed',output,usage:{input_tokens:10,output_tokens:20,input_tokens_details:{cached_tokens:2},output_tokens_details:{reasoning_tokens:3}}}});
test('subscription adapter streams over HTTP, maps usage, and omits unsupported general API options',async()=>{
 let request;
 const model=createCodexModel('gpt-6-astra',{getSession:async()=>session,fetcher:async(url,options)=>{request={url,...options};return stream([completed([message('OK')])],{split:true});}});
 const result=await generateText({model,prompt:'A fictional test.',maxOutputTokens:100});
 assert.equal(result.text,'OK');assert.equal(result.totalUsage.totalTokens,30);assert.equal(result.totalUsage.inputTokenDetails.cacheReadTokens,2);
 assert.equal(request.url,'https://chatgpt.com/backend-api/codex/responses');assert.equal(request.headers.Authorization,'Bearer fictional-access-token');
 const body=JSON.parse(request.body);assert.equal(body.stream,true);assert.equal(body.store,false);assert.ok(!('max_output_tokens' in body));assert.ok(!('temperature' in body));
});
test('subscription adapter handles tool results and null completed output',async()=>{
 let body;
 const model=createCodexModel('fixture',{getSession:async()=>session,fetcher:async(url,options)=>{body=JSON.parse(options.body);return stream([{type:'response.output_item.done',output_index:0,item:message('Finished')},completed(null)]);}});
 const result=await model.doGenerate({prompt:[{role:'system',content:'Review.'},{role:'assistant',content:[{type:'tool-call',toolCallId:'call',toolName:'read_source',input:{id:'manual:fixture'}}]},{role:'tool',content:[{type:'tool-result',toolCallId:'call',toolName:'read_source',output:{type:'json',value:{body:'fictional context'}}}]}],responseFormat:{type:'json',schema:{type:'object'}},tools:[{type:'function',name:'read_source',inputSchema:{type:'object'}}],toolChoice:{type:'none'}});
 assert.equal(result.content[0].text,'Finished');assert.match(body.instructions,/schema/);assert.equal(body.tool_choice,'none');
 assert.equal(body.input[0].arguments,'{"id":"manual:fixture"}');assert.equal(body.input[1].output,'{"body":"fictional context"}');
});
test('truncated streams and failed terminal events cannot become successful reviews or leak raw errors',async()=>{
 for(const events of [[{type:'response.output_item.done',output_index:0,item:message('Partial')}],[{type:'response.failed',response:{error:{code:'usage_limit_reached',message:'private-provider-detail'}}}]]){
  const model=createCodexModel('fixture',{getSession:async()=>session,fetcher:async()=>stream(events)});
  await assert.rejects(model.doGenerate({prompt:[]}),error=>{const failure=cloudReviewFailure(error);assert.match(failure.diagnostic.reason,/^chatgpt_/);assert.ok(!JSON.stringify(failure).includes('private-provider-detail'));return true;});
 }
});
test('Codex commentary does not corrupt the final structured answer',async()=>{
 const model=createCodexModel('fixture',{getSession:async()=>session,fetcher:async()=>stream([completed([{...message('Let me check.'),phase:'commentary'},{...message('{"ok":true}'),phase:'final_answer'}])])});
 assert.deepEqual((await model.doGenerate({prompt:[]})).content,[{type:'text',text:'{"ok":true}'}]);
});
test('401 refreshes once, 429 does not fall back to Gateway',async()=>{
 const calls=[];let attempts=0;
 const model=createCodexModel('fixture',{getSession:async options=>{calls.push(options);return{...session,accessToken:options?'refreshed-token':session.accessToken};},fetcher:async()=>++attempts===1?new Response('',{status:401}):stream([completed([message('OK')])])});
 assert.equal((await model.doGenerate({prompt:[]})).content[0].text,'OK');assert.deepEqual(calls,[undefined,{rejectedToken:session.accessToken}]);
 const limited=createCodexModel('fixture',{getSession:async()=>session,fetcher:async()=>new Response('private quota response',{status:429})});
 await assert.rejects(limited.doGenerate({prompt:[]}),error=>error.reason==='rate_limited'&&!error.message.includes('private quota'));
});
test('abort cancels a hung response instead of accepting partial text',async()=>{
 const controller=new AbortController();let cancelled=false;
 const model=createCodexModel('fixture',{getSession:async()=>session,fetcher:async(url,options)=>{
  return new Response(new ReadableStream({start(stream){options.signal.addEventListener('abort',()=>{cancelled=true;stream.error(options.signal.reason);});}}));
 }});
 const pending=model.doGenerate({prompt:[],abortSignal:controller.signal});setTimeout(()=>controller.abort(),10);
 await assert.rejects(pending);assert.equal(cancelled,true);
});
