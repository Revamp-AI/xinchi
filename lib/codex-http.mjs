export const CODEX_ORIGIN='https://chatgpt.com/backend-api/codex';
export const AUTH_ORIGIN='https://auth.openai.com';
// Public Codex OAuth client used by the device-code protocol, not an API secret.
export const CODEX_CLIENT_ID='app_EMoamEEZ73f0CkXaXp7hrann';
const messages={
 authentication:'Your ChatGPT connection needs sign-in again. Open Settings → AI reviews to reconnect.',
 access_denied:'Your ChatGPT account cannot access this Codex model. Check the model and subscription in Settings → AI reviews.',
 rate_limited:'Your ChatGPT usage limit was reached or requests are temporarily rate limited. Try again after the limit resets.',
 unavailable:'ChatGPT is temporarily unavailable. Try again shortly.',
 invalid_response:'ChatGPT returned an incomplete or unsupported response. Try again or choose another model in Settings → AI reviews.',
 login_expired:'This sign-in request expired or was cancelled. Start a new ChatGPT connection.',
 not_connected:'Connect ChatGPT in Settings → AI reviews before using subscription reviews.',
};
export function codexError(reason,statusCode){return Object.assign(Error(messages[reason]||messages.invalid_response),{name:'FocusCodexError',provider:'chatgpt',reason,statusCode});}
export function httpFailure(status){return codexError(status===401?'authentication':status===403?'access_denied':status===429?'rate_limited':status>=500?'unavailable':'invalid_response',status);}
export async function boundedText(response,limit=1024*1024){
 if(!response.body)return '';const reader=response.body.getReader(),decoder=new TextDecoder();let text='',bytes=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>limit)throw codexError('invalid_response');text+=decoder.decode(value,{stream:true});}return text+decoder.decode();}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function authRequest(path,body,{form=false,fetcher=fetch}={}){
 let response;
 try{response=await fetcher(AUTH_ORIGIN+path,{method:'POST',redirect:'error',headers:{'Content-Type':form?'application/x-www-form-urlencoded':'application/json','Accept':'application/json'},body:form?new URLSearchParams(body).toString():JSON.stringify(body),signal:AbortSignal.timeout(15000)});}catch{throw codexError('unavailable');}
 let data={};try{data=JSON.parse(await boundedText(response));}catch{if(response.ok)throw codexError('invalid_response');}
 return{status:response.status,ok:response.ok,data};
}
