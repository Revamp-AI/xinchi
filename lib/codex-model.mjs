import {CODEX_ORIGIN,codexError,httpFailure} from './codex-http.mjs';
import {codexSession} from './review-settings.mjs';

// A server-only Responses adapter. OAuth tokens never pass through AI Gateway.
function requestBody(model,options){
 const instructions=[],input=[];
 for(const message of options.prompt){
  if(message.role==='system'){instructions.push(message.content);continue;}
  for(const part of message.content){
   if(part.type==='text')input.push({role:message.role,content:[{type:message.role==='assistant'?'output_text':'input_text',text:part.text}]});
   else if(part.type==='tool-call')input.push({type:'function_call',call_id:part.toolCallId,name:part.toolName,arguments:JSON.stringify(part.input)});
   else if(part.type==='tool-result'){
    const output=part.output;
    if(!['text','json','error-text','error-json'].includes(output.type))throw codexError('invalid_response');
    input.push({type:'function_call_output',call_id:part.toolCallId,output:typeof output.value==='string'?output.value:JSON.stringify(output.value)});
   }else if(part.type!=='reasoning')throw codexError('invalid_response');
  }
 }
 // Codex does not expose every general Responses API parameter. Request JSON
 // in instructions and let the SDK validate the schema before saving a review.
 if(options.responseFormat?.type==='json')instructions.push('When you have finished using tools, return only valid JSON matching this schema: '+JSON.stringify(options.responseFormat.schema||{}));
 const tools=(options.tools||[]).map(tool=>{if(tool.type!=='function')throw codexError('invalid_response');return{type:'function',name:tool.name,description:tool.description,parameters:tool.inputSchema};});
 const choice=options.toolChoice;
 return{model,instructions:instructions.join('\n\n')||'You are a helpful assistant.',input,store:false,stream:true,...(tools.length?{tools,tool_choice:choice?.type==='tool'?{type:'function',name:choice.toolName}:choice?.type||'auto'}:{})};
}
function eventFailure(event){
 const code=String(event.error?.code||event.response?.error?.code||'');
 return codexError(/usage_limit|rate_limit|quota/.test(code)?'rate_limited':/auth|token/.test(code)?'authentication':/server|overload/.test(code)?'unavailable':'invalid_response');
}
async function readResponse(response){
 if(!response.body)throw codexError('invalid_response');
 const reader=response.body.getReader(),decoder=new TextDecoder(),items=new Map();let buffer='',bytes=0,completed=null;
 function event(block){
  const data=block.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
  if(!data||data==='[DONE]')return;
  let value;try{value=JSON.parse(data);}catch{throw codexError('invalid_response');}
  if(['error','response.failed','response.incomplete'].includes(value.type))throw eventFailure(value);
  if(value.type==='response.output_item.done'&&value.item)items.set(value.output_index??value.item.id, value.item);
  if(value.type==='response.completed'){if(value.response?.status&&value.response.status!=='completed')throw eventFailure(value);completed=value.response;}
 }
 try{
  while(!completed){
   const {done,value}=await reader.read();if(done)break;
   bytes+=value.length;if(bytes>8*1024*1024)throw codexError('invalid_response');
   buffer+=decoder.decode(value,{stream:true});buffer=buffer.replaceAll('\r\n','\n');
   let end;while((end=buffer.indexOf('\n\n'))!==-1){event(buffer.slice(0,end));buffer=buffer.slice(end+2);if(completed)break;}
  }
  if(!completed)throw codexError('invalid_response');
  const output=completed.output?.length?completed.output:[...items.values()];
  const content=output.flatMap(item=>item.type==='function_call'?[{type:'tool-call',toolCallId:item.call_id,toolName:item.name,input:item.arguments}]:item.type==='message'&&!['analysis','commentary'].includes(item.phase)?(item.content||[]).filter(p=>p.type==='output_text').map(p=>({type:'text',text:p.text})):[]);
  if(!content.length)throw codexError('invalid_response');
  const usage=completed.usage||{},cached=usage.input_tokens_details?.cached_tokens,reasoning=usage.output_tokens_details?.reasoning_tokens;
  return{content,finishReason:{unified:content.some(p=>p.type==='tool-call')?'tool-calls':'stop',raw:'completed'},
   usage:{inputTokens:{total:usage.input_tokens,noCache:usage.input_tokens==null?undefined:usage.input_tokens-(cached||0),cacheRead:cached,cacheWrite:undefined},outputTokens:{total:usage.output_tokens,text:usage.output_tokens==null?undefined:usage.output_tokens-(reasoning||0),reasoning}},warnings:[],response:{id:completed.id,modelId:completed.model}};
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function createCodexModel(model,{fetcher=fetch,getSession=codexSession}={}){
 return{specificationVersion:'v4',provider:'chatgpt-subscription',modelId:model,supportedUrls:{},
  async doGenerate(options){
   const body=JSON.stringify(requestBody(model,options));if(Buffer.byteLength(body)>2*1024*1024)throw codexError('invalid_response');
   const signal=AbortSignal.any([AbortSignal.timeout(120000),...(options.abortSignal?[options.abortSignal]:[])]);
   let session=await getSession();
   for(let attempt=0;attempt<2;attempt++){
    let response;try{response=await fetcher(CODEX_ORIGIN+'/responses',{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+session.accessToken,'ChatGPT-Account-Id':session.accountId,'Content-Type':'application/json',Accept:'text/event-stream'},body,signal});}catch{throw codexError('unavailable');}
    if(!response.ok){await response.body?.cancel().catch(()=>{});if(response.status===401&&attempt===0){session=await getSession({rejectedToken:session.accessToken});continue;}throw httpFailure(response.status);}
    try{return await readResponse(response);}catch(error){if(error.provider==='chatgpt')throw error;throw codexError('unavailable');}
   }
   throw codexError('authentication',401);
  },
  async doStream(){throw codexError('invalid_response');},
 };
}
