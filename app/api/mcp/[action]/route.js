import {checkLocalRequest,requireSession} from '../../../../lib/auth.mjs';
import {checkMcpOrigin,readMcpBody,registerMcpClient,exchangeMcpToken,authorizeMcp,revokeMcpToken,mcpAccessSettings,revokeMcpGrant,rateLimit} from '../../../../lib/mcp-auth.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=30;
const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','Pragma':'no-cache','X-Content-Type-Options':'nosniff'}});
function failure(error){return json({error:error.oauthCode||'invalid_request',error_description:error.code?'The database is unavailable. Try again.':error.message},error.status||400);}
export async function GET(req){try{checkLocalRequest(req);await requireSession(req);if(new URL(req.url).pathname.endsWith('/access'))return json(await mcpAccessSettings());return json({error:'not_found'},404);}catch(e){return failure(e);}}
export async function POST(req){try{
 checkMcpOrigin(req);
 const action=new URL(req.url).pathname.split('/').pop();
 let user;
 if(['authorize','disconnect'].includes(action)){checkLocalRequest(req,true);user=await requireSession(req);}
 else if(!['register','token','revoke'].includes(action))return json({error:'not_found'},404);
 const type=req.headers.get('content-type')||'';
 if(!type.startsWith('application/json')&&!type.startsWith('application/x-www-form-urlencoded'))return json({error:'invalid_request',error_description:'Use JSON or form encoding.'},415);
 const raw=await readMcpBody(req,16384);
 let data;try{data=type.startsWith('application/json')?JSON.parse(raw):Object.fromEntries(new URLSearchParams(raw));}catch{return json({error:'invalid_request',error_description:'Malformed request body.'},400);}
 if(!data||Array.isArray(data)||typeof data!=='object')return json({error:'invalid_request'},400);
 if(action==='register')return json(await registerMcpClient(data),201);
 if(action==='token')return json(await exchangeMcpToken(data));
 if(action==='revoke'){await rateLimit('revoke',120);return json(await revokeMcpToken(data));}
 if(action==='authorize')return json(await authorizeMcp(data.request,user,data.allow===true));
 if(action==='disconnect')return json(await revokeMcpGrant(data.id));
}catch(e){return failure(e);}}
