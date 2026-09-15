import {randomUUID} from 'node:crypto';
import {secrets,updateSecrets} from './secret-store.mjs';
import {authRequest,AUTH_ORIGIN,CODEX_CLIENT_ID,codexError,httpFailure} from './codex-http.mjs';
const fallbackModel=()=>String(process.env.XIN_AGENT_MODEL||'openai/gpt-6-astra');
const stateOf=s=>s.review_provider||(s.review_provider={active:'gateway',model:'gpt-6-astra'});
const validModel=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value);
function claims(token){try{return JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());}catch{return {};}}
function connectionFrom(data,previous){
 if(typeof data.access_token!=='string'||!data.access_token||typeof(data.refresh_token||previous?.refreshToken)!=='string')throw codexError('invalid_response');
 const payload=claims(data.access_token),identity=claims(data.id_token||data.access_token),auth=payload['https://api.openai.com/auth']||identity['https://api.openai.com/auth']||{};
 const accountId=auth.chatgpt_account_id||previous?.accountId;
 if(typeof accountId!=='string'||!accountId||accountId.length>200)throw codexError('invalid_response');
 return{id:previous?.id||randomUUID(),accessToken:data.access_token,refreshToken:data.refresh_token||previous?.refreshToken,accountId,
  expiresAt:Number(payload.exp)*1000||Date.now()+Math.max(60,Number(data.expires_in)||3600)*1000,
  email:typeof identity.email==='string'?identity.email.slice(0,200):previous?.email||'',plan:typeof auth.chatgpt_plan_type==='string'?auth.chatgpt_plan_type.slice(0,60):previous?.plan||'',connectedAt:previous?.connectedAt||new Date().toISOString(),needsLogin:false};
}
export async function reviewSettings(){
 const state=stateOf(await secrets()),connection=state.connection,login=state.login?.expiresAt>Date.now()?state.login:null;
 return{provider:state.active||'gateway',model:state.model||'gpt-6-astra',gatewayModel:fallbackModel(),
  chatgpt:{connected:!!connection&&!connection.needsLogin,needsLogin:!!connection?.needsLogin,email:connection?.email||'',plan:connection?.plan||'',connectedAt:connection?.connectedAt||null},
  test:state.test?{ok:state.test.ok,model:state.test.model,at:state.test.at,message:state.test.message}:null,
  login:login?{id:login.id,userCode:login.userCode,verificationUrl:AUTH_ORIGIN+'/codex/device',expiresAt:login.expiresAt,interval:login.interval}:null};
}
export async function startChatGPTLogin(){
 await updateSecrets(async s=>{const state=stateOf(s);if(state.login?.createdAt>Date.now()-30000)throw Error('A sign-in request was just started. Use its code or wait a moment.');
 const r=await authRequest('/api/accounts/deviceauth/usercode',{client_id:CODEX_CLIENT_ID});if(!r.ok)throw httpFailure(r.status);
 if(typeof r.data.user_code!=='string'||typeof r.data.device_auth_id!=='string')throw codexError('invalid_response');
 state.login={id:randomUUID(),deviceAuthId:r.data.device_auth_id,userCode:r.data.user_code,createdAt:Date.now(),expiresAt:Date.now()+Math.max(30,Math.min(900,Number(r.data.expires_in)||900))*1000,interval:Math.max(3,Math.min(30,Number(r.data.interval)||5)),nextPollAt:0};});
 return reviewSettings();
}
export async function pollChatGPTLogin(id){
 const result=await updateSecrets(async s=>{
  const state=stateOf(s),login=state.login;if(!login||login.id!==id||login.expiresAt<=Date.now())return{error:codexError('login_expired')};
  if(login.nextPollAt>Date.now())return{};login.nextPollAt=Date.now()+login.interval*1000;
  let r;try{r=await authRequest('/api/accounts/deviceauth/token',{device_auth_id:login.deviceAuthId,user_code:login.userCode});}catch(error){return{error};}
  if([403,404].includes(r.status))return{};
  if(r.status===429){login.interval=Math.min(60,login.interval+5);login.nextPollAt=Date.now()+login.interval*1000;return{};}
  if(!r.ok){delete state.login;return{error:httpFailure(r.status)};}
  if(!r.data.authorization_code||!r.data.code_verifier){delete state.login;return{error:codexError('invalid_response')};}
  try{
   const tokens=await authRequest('/oauth/token',{grant_type:'authorization_code',code:r.data.authorization_code,code_verifier:r.data.code_verifier,redirect_uri:AUTH_ORIGIN+'/deviceauth/callback',client_id:CODEX_CLIENT_ID},{form:true});
   if(!tokens.ok)throw httpFailure(tokens.status);
   state.connection=connectionFrom(tokens.data);state.test=null;delete state.login;return{};
  }catch(error){delete state.login;return{error};}
 });
 if(result.error)throw result.error;return reviewSettings();
}
export async function cancelChatGPTLogin(id){await updateSecrets(s=>{const state=stateOf(s);if(state.login?.id===id)delete state.login;});return reviewSettings();}
export async function disconnectChatGPT(){await updateSecrets(s=>{const state=stateOf(s);delete state.connection;delete state.login;state.test=null;});return reviewSettings();}
export async function codexSession({rejectedToken}={}){
 const result=await updateSecrets(async s=>{
  const state=stateOf(s),c=state.connection;if(!c)return{error:codexError('not_connected')};if(c.needsLogin)return{error:codexError('authentication',401)};
  if(c.expiresAt>Date.now()+120000&&(!rejectedToken||rejectedToken!==c.accessToken))return{connection:c};
  let r;try{r=await authRequest('/oauth/token',{grant_type:'refresh_token',refresh_token:c.refreshToken,client_id:CODEX_CLIENT_ID},{form:true});}catch(error){return{error};}
  if(!r.ok){if([400,401,403].includes(r.status)){c.needsLogin=true;state.test=null;return{error:codexError('authentication',401)};}return{error:httpFailure(r.status)};}
  try{state.connection=connectionFrom(r.data,c);return{connection:state.connection};}catch(error){c.needsLogin=true;return{error};}
 });if(result.error)throw result.error;return result.connection;
}
export async function saveReviewProvider({provider,model}){
 if(!['gateway','chatgpt'].includes(provider))throw Error('Choose a supported review provider.');
 if(!validModel(model))throw Error('Enter a valid Codex model ID, such as gpt-6-astra.');
 await updateSecrets(s=>{const state=stateOf(s);if(provider==='chatgpt'&&(!state.connection||state.connection.needsLogin||!state.test?.ok||state.test.model!==model||state.test.connectionId!==state.connection.id))throw Error('Connect ChatGPT and successfully test this model before using it for reviews.');state.active=provider;state.model=model;});return reviewSettings();
}
export async function testChatGPTConnection(model){
 if(!validModel(model))throw Error('Enter a valid Codex model ID.');
 const connection=await codexSession();
 const {createCodexModel}=await import('./codex-model.mjs');
 const {generateText}=await import('ai');
 let result;
 try{const response=await generateText({model:createCodexModel(model),prompt:'Reply with the single word OK.',maxRetries:0,abortSignal:AbortSignal.timeout(45000)});if(!response.text.trim())throw codexError('invalid_response');result={ok:true,message:'ChatGPT responded successfully. This model is ready for reviews.'};}
 catch(error){result={ok:false,message:error.provider==='chatgpt'?error.message:'The connection test did not complete. Try again.'};}
 await updateSecrets(s=>{const state=stateOf(s);if(state.connection?.id!==connection.id)throw Error('The ChatGPT connection changed. Test the current connection again.');state.test={...result,model,connectionId:connection.id,at:new Date().toISOString()};});return reviewSettings();
}
export async function selectedReviewModel(){const state=stateOf(await secrets());if(state.active==='chatgpt'){const {createCodexModel}=await import('./codex-model.mjs');return createCodexModel(state.model||'gpt-6-astra');}return fallbackModel();}
