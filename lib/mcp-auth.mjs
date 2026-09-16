import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {all,one,run,transaction,uid} from './db.mjs';
import {APP_ORIGIN,allowedEmail} from './auth.mjs';

export const MCP_URL=APP_ORIGIN+'/mcp';
export const MCP_SCOPES=['focus:read','focus:write'];
export const randomToken=()=>randomBytes(32).toString('base64url');
export const tokenHash=value=>createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const error=(message,code='invalid_request',status=400)=>Object.assign(Error(message),{oauthCode:code,status});
export const protectedResourceMetadata=()=>({resource:MCP_URL,authorization_servers:[APP_ORIGIN],scopes_supported:MCP_SCOPES,bearer_methods_supported:['header'],resource_name:'Focus workspace'});
export const authorizationMetadata=()=>({issuer:APP_ORIGIN,authorization_endpoint:APP_ORIGIN+'/mcp/authorize',token_endpoint:APP_ORIGIN+'/api/mcp/token',registration_endpoint:APP_ORIGIN+'/api/mcp/register',revocation_endpoint:APP_ORIGIN+'/api/mcp/revoke',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none'],revocation_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256'],scopes_supported:MCP_SCOPES,authorization_response_iss_parameter_supported:true});

export function checkMcpOrigin(req){
 // Next may reconstruct request.url with its internal listening address.
 // Validate the HTTP Host instead, as the workspace's browser auth does.
 if((req.headers.get('host')||new URL(req.url).host)!==new URL(APP_ORIGIN).host)throw error('Use the configured Focus address.','invalid_request',403);
 const origin=req.headers.get('origin');
 if(origin&&origin!==APP_ORIGIN)throw error('This browser origin is not allowed.','invalid_request',403);
}
export async function rateLimit(key,limit=120){
 const row=await one("INSERT INTO focus_auth.mcp_rate_limits(key,count,expires_at) VALUES(?,1,now()+interval '1 minute') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN mcp_rate_limits.expires_at<=now() THEN 1 ELSE mcp_rate_limits.count+1 END,expires_at=CASE WHEN mcp_rate_limits.expires_at<=now() THEN now()+interval '1 minute' ELSE mcp_rate_limits.expires_at END RETURNING count",key);
 if(row.count>limit)throw error('Too many requests. Try again in one minute.','temporarily_unavailable',429);
}
export async function readMcpBody(req,limit=65536){
 if(Number(req.headers.get('content-length'))>limit)throw error('Request is too large.','invalid_request',413);
 const reader=req.body?.getReader();let size=0;const chunks=[];
 if(reader)try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw error('Request is too large.','invalid_request',413);}chunks.push(value);}}finally{reader.releaseLock();}
 return Buffer.concat(chunks).toString('utf8');
}
const loopback=u=>u.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(u.hostname);
function redirectUrl(value){
 if(typeof value!=='string'||value.length>2048)throw error('Invalid redirect URI.');
 let u;try{u=new URL(value);}catch{throw error('Invalid redirect URI.');}
 if(u.username||u.password||u.hash||!(u.protocol==='https:'||loopback(u)))throw error('Use HTTPS or a loopback HTTP callback.');
 return u;
}
export function redirectMatches(registered,requested){
 const actual=redirectUrl(requested);
 return registered.some(value=>{const expected=redirectUrl(value);if(expected.href===actual.href)return true;if(loopback(expected)&&loopback(actual)&&expected.hostname===actual.hostname){const normalized=new URL(actual);expected.port='';normalized.port='';return expected.href===normalized.href;}return false;});
}
function scopes(value=MCP_SCOPES.join(' ')){
 if(typeof value!=='string'||value.length>100)throw error('Invalid scope.','invalid_scope');
 const requested=[...new Set(value.split(' ').filter(Boolean))];
 if(!requested.length||requested.some(s=>!MCP_SCOPES.includes(s))||!requested.includes('focus:read'))throw error('Request focus:read, optionally with focus:write.','invalid_scope');
 return requested.sort().join(' ');
}
export async function registerMcpClient(input){
 await rateLimit('registration',30);
 if(!Array.isArray(input.redirect_uris)||input.redirect_uris.length<1||input.redirect_uris.length>5)throw error('Supply one to five redirect URIs.');
 const redirects=input.redirect_uris.map(value=>redirectUrl(value).href);
 if(input.token_endpoint_auth_method&&input.token_endpoint_auth_method!=='none')throw error('This server uses public clients with PKCE.','invalid_client_metadata');
 for(const [field,allowed] of [['grant_types',['authorization_code','refresh_token']],['response_types',['code']]])if(input[field]!==undefined&&(!Array.isArray(input[field])||!input[field].length||input[field].length>allowed.length||input[field].some(value=>!allowed.includes(value))))throw error('Unsupported grant or response type.','invalid_client_metadata');
 const name=String(input.client_name||'MCP client').trim().slice(0,100)||'MCP client',id=uid();
 await transaction(async()=>{
  await one("SELECT pg_advisory_xact_lock(hashtext('focus-mcp-registration'))");
  await run("DELETE FROM focus_auth.mcp_clients c WHERE created_at<now()-interval '1 day' AND NOT EXISTS(SELECT 1 FROM focus_auth.mcp_grants g WHERE g.client_id=c.id)");
  await run('DELETE FROM focus_auth.mcp_rate_limits WHERE expires_at<now()');
  if((await one('SELECT count(*) AS n FROM focus_auth.mcp_clients')).n>=1000)throw error('Client registration limit reached.','temporarily_unavailable',429);
  await run('INSERT INTO focus_auth.mcp_clients(id,name,redirect_uris) VALUES(?,?,?::jsonb)',id,name,JSON.stringify(redirects));
 });
 return{client_id:id,client_name:name,redirect_uris:redirects,grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none',client_id_issued_at:Math.floor(Date.now()/1000)};
}
export async function validateAuthorization(input){
 if(typeof input.client_id!=='string'||input.client_id.length>200)throw error('Unknown client.','invalid_client');
 const client=await one('SELECT * FROM focus_auth.mcp_clients WHERE id=?',input.client_id);
 if(!client)throw error('Unknown client.','invalid_client');
 if(!redirectMatches(client.redirect_uris,input.redirect_uri))throw error('Redirect URI does not match this client.');
 if(input.response_type!=='code'||input.code_challenge_method!=='S256'||!/^[A-Za-z0-9_-]{43}$/.test(input.code_challenge||''))throw error('Authorization requires code and PKCE S256.');
 if(input.resource!==MCP_URL)throw error('Request the Focus MCP resource.','invalid_target');
 if(typeof input.state!=='string'||input.state.length<1||input.state.length>2048)throw error('A client state value is required.');
 return{client,request:{client_id:client.id,redirect_uri:redirectUrl(input.redirect_uri).href,response_type:'code',resource:MCP_URL,scope:scopes(input.scope),state:input.state,code_challenge:input.code_challenge,code_challenge_method:'S256'}};
}
export async function authorizeMcp(input,user,allow=true){
 if(!user||user.email!==allowedEmail())throw error('Sign in to Focus first.','access_denied',401);
 const {client,request}=await validateAuthorization(input);
 const redirect=new URL(request.redirect_uri);redirect.searchParams.set('state',request.state);redirect.searchParams.set('iss',APP_ORIGIN);
 if(!allow){redirect.searchParams.set('error','access_denied');return{redirect:redirect.href};}
 const code=randomToken(),id=uid();
 await transaction(async()=>{
  await run('INSERT INTO focus_auth.mcp_grants(id,client_id,owner_sub,owner_email,scope,resource,expires_at) VALUES(?,?,?,?,?,?,now()+interval \'90 days\')',id,client.id,user.sub,user.email,request.scope,MCP_URL);
  await run('INSERT INTO focus_auth.mcp_codes(token_hash,grant_id,redirect_uri,challenge,expires_at) VALUES(?,?,?,?,now()+interval \'5 minutes\')',tokenHash(code),id,request.redirect_uri,request.code_challenge);
 });
 redirect.searchParams.set('code',code);return{redirect:redirect.href};
}
async function liveGrant(id,clientId){
 return one('SELECT g.* FROM focus_auth.mcp_grants g JOIN focus_auth.owner o ON o.sub=g.owner_sub AND o.email=g.owner_email WHERE g.id=? AND g.client_id=? AND g.resource=? AND g.owner_email=? AND g.revoked_at IS NULL AND g.expires_at>now() FOR UPDATE OF g',id,clientId,MCP_URL,allowedEmail());
}
async function issueTokens(grant,scope=grant.scope){
 const access=randomToken(),refresh=randomToken();
 await run('INSERT INTO focus_auth.mcp_tokens(token_hash,grant_id,kind,expires_at) VALUES(?,?,\'access\',now()+interval \'1 hour\'),(?,?,\'refresh\',?::timestamptz)',tokenHash(access),grant.id,tokenHash(refresh),grant.id,grant.expires_at);
 return{access_token:access,token_type:'Bearer',expires_in:3600,refresh_token:refresh,scope};
}
export async function exchangeMcpToken(input){
 await rateLimit('tokens',120);
 if(input.resource!==MCP_URL)throw error('Request the Focus MCP resource.','invalid_target');
 if(typeof input.client_id!=='string'||input.client_id.length>200)throw error('Unknown client.','invalid_client');
 const result=await transaction(async()=>{
  if(input.grant_type==='authorization_code'){
   if(!/^[A-Za-z0-9_-]{43}$/.test(input.code||''))throw error('Authorization code is invalid or expired.','invalid_grant');
   const code=await one('SELECT * FROM focus_auth.mcp_codes WHERE token_hash=? AND expires_at>now() FOR UPDATE',tokenHash(input.code));
   const grant=code&&await liveGrant(code.grant_id,input.client_id);
   if(!grant||code.redirect_uri!==input.redirect_uri||!/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier||'')||!equal(code.challenge,createHash('sha256').update(input.code_verifier).digest('base64url')))throw error('Authorization code or PKCE verifier is invalid.','invalid_grant');
   await run('DELETE FROM focus_auth.mcp_codes WHERE token_hash=?',tokenHash(input.code));
   return issueTokens(grant);
  }
  if(input.grant_type==='refresh_token'){
   if(!/^[A-Za-z0-9_-]{43}$/.test(input.refresh_token||''))throw error('Refresh token is invalid.','invalid_grant');
   const token=await one("SELECT * FROM focus_auth.mcp_tokens WHERE token_hash=? AND kind='refresh' FOR UPDATE",tokenHash(input.refresh_token));
   const grant=token&&await liveGrant(token.grant_id,input.client_id);
   if(!grant||token.expires_at<=new Date().toISOString())throw error('Refresh token is invalid or expired.','invalid_grant');
   if(token.used_at){await run('UPDATE focus_auth.mcp_grants SET revoked_at=now() WHERE id=?',grant.id);return{replay:true};}
   if(input.scope&&scopes(input.scope)!==grant.scope)throw error('Refresh must preserve the granted scope.','invalid_scope');
   await run('UPDATE focus_auth.mcp_tokens SET used_at=now() WHERE token_hash=?',tokenHash(input.refresh_token));
   return issueTokens(grant);
  }
  throw error('Use authorization_code or refresh_token.','unsupported_grant_type');
 });
 if(result.replay)throw error('Refresh token was already used. Reconnect Focus.','invalid_grant');
 return result;
}
export async function requireMcpAccess(req){
 checkMcpOrigin(req);
 const match=/^Bearer ([A-Za-z0-9_-]{43})$/i.exec(req.headers.get('authorization')||'');
 if(!match)throw error('Connect Focus with OAuth.','invalid_token',401);
 const grant=await one("SELECT g.*,c.name AS client_name FROM focus_auth.mcp_tokens t JOIN focus_auth.mcp_grants g ON g.id=t.grant_id JOIN focus_auth.mcp_clients c ON c.id=g.client_id JOIN focus_auth.owner o ON o.sub=g.owner_sub AND o.email=g.owner_email WHERE t.token_hash=? AND t.kind='access' AND t.expires_at>now() AND g.expires_at>now() AND g.revoked_at IS NULL AND g.resource=? AND g.owner_email=?",tokenHash(match[1]),MCP_URL,allowedEmail());
 if(!grant)throw error('Focus access expired or was revoked.','invalid_token',401);
 await rateLimit('mcp:'+grant.id,180);
 await run("UPDATE focus_auth.mcp_grants SET last_used_at=now() WHERE id=? AND (last_used_at IS NULL OR last_used_at<now()-interval '1 minute')",grant.id);
 return grant;
}
export async function revokeMcpToken(input){
 if(typeof input.token!=='string'||input.token.length>200)return{};
 await run('UPDATE focus_auth.mcp_grants SET revoked_at=now() WHERE client_id=? AND id IN (SELECT grant_id FROM focus_auth.mcp_tokens WHERE token_hash=?)',String(input.client_id||''),tokenHash(input.token));return{};
}
export async function mcpAccessSettings(){
 return{url:MCP_URL,grants:await all('SELECT g.id,c.name AS client_name,g.scope,g.created_at,g.expires_at,g.last_used_at,g.revoked_at,g.expires_at<=now() AS expired FROM focus_auth.mcp_grants g JOIN focus_auth.mcp_clients c ON c.id=g.client_id WHERE g.owner_email=? ORDER BY g.created_at DESC LIMIT 50',allowedEmail()),activity:await all('SELECT o.tool,o.created_at,c.name AS client_name FROM focus_auth.mcp_operations o JOIN focus_auth.mcp_grants g ON g.id=o.grant_id JOIN focus_auth.mcp_clients c ON c.id=g.client_id WHERE g.owner_email=? ORDER BY o.created_at DESC LIMIT 20',allowedEmail())};
}
export async function revokeMcpGrant(id){await run('UPDATE focus_auth.mcp_grants SET revoked_at=now() WHERE id=? AND owner_email=?',id,allowedEmail());return{revoked:true};}
