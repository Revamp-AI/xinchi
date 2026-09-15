import {McpServer,createMcpHandler} from '@modelcontextprotocol/server';
import {z} from 'zod';
import {mcpTools,mcpInstructions,executeMcpTool,toolByName} from './mcp-tools.mjs';
import {requireMcpAccess,readMcpBody} from './mcp-auth.mjs';
import {APP_ORIGIN} from './runtime.mjs';

const content=value=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:{data:value}});
const publicMessage=error=>error.code?'The database could not complete this request. Retry or check the connection.':error.message;
export function createFocusMcpServer(grant,options={}){
 const server=new McpServer({name:'Focus',version:'1.0.0'},{instructions:mcpInstructions});
 for(const tool of mcpTools)server.registerTool(tool.name,{description:tool.description,inputSchema:tool.inputSchema,annotations:{readOnlyHint:!tool.write,destructiveHint:tool.destructive,idempotentHint:true,openWorldHint:tool.external}},async args=>{
  try{return content(await executeMcpTool(tool.name,args,grant,options));}
  catch(error){return{isError:true,content:[{type:'text',text:publicMessage(error)}]};}
 });
 server.registerResource('Focus usage guide','focus://guide',{mimeType:'text/plain',description:'How to work safely with Focus.'},async uri=>({contents:[{uri:uri.href,mimeType:'text/plain',text:mcpInstructions+'\n\nStart with focus_get_workspace. Read records before updating them. Use focus_submit_review to save a review you prepare, or focus_start_review to run the configured cloud reviewer. All mutations use idempotency_key and appear in Focus settings. Contact and commitment updates require current versions. Use paginated tools to inspect the complete archive. Manage access at '+APP_ORIGIN+'/#settings.'}]}));
 server.registerResource('Focus workspace overview','focus://workspace',{mimeType:'application/json',description:'Current workspace focus, counts, coverage, and connections.'},async uri=>({contents:[{uri:uri.href,mimeType:'application/json',text:JSON.stringify(await executeMcpTool('focus_get_workspace',{},grant))}]}));
 server.registerPrompt('review_workspace',{description:'Review current Focus context and prepare evidence-backed proposals.',argsSchema:z.object({focus:z.string().max(2000).optional()})},({focus})=>({messages:[{role:'user',content:{type:'text',text:'Review my Focus workspace'+(focus?' with attention to '+focus:'')+'. Read focus_get_workspace, existing commitments and pending proposals, then search recent source evidence. Separate confirmed obligations from possible follow-ups. Prepare a review with exact citations and save it with focus_submit_review. Leave proposed commitments pending for my decision.'}}]}));
 return server;
}
export async function handleMcpRequest(req,options={}){
 try{
  const grant=await requireMcpAccess(req);
  if(!['POST','GET','DELETE'].includes(req.method))return new Response(null,{status:405,headers:{Allow:'POST, GET, DELETE'}});
  let parsedBody;
  if(req.method==='POST'){
   if(!req.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return Response.json({error:'Use application/json.'},{status:415});
   try{parsedBody=JSON.parse(await readMcpBody(req,1024*1024));}catch(error){if(error.status)throw error;return Response.json({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON.'}},{status:400});}
   if(Array.isArray(parsedBody))return Response.json({jsonrpc:'2.0',id:null,error:{code:-32600,message:'JSON-RPC batches are not supported.'}},{status:400});
   if(parsedBody?.method==='tools/call'&&toolByName(parsedBody.params?.name)?.write&&!grant.scope.split(' ').includes('focus:write'))return Response.json({error:'Permission to make changes is required.'},{status:403,headers:{'WWW-Authenticate':`Bearer error="insufficient_scope", scope="focus:read focus:write", resource_metadata="${APP_ORIGIN}/.well-known/oauth-protected-resource/mcp"`,'Cache-Control':'no-store'}});
  }
  const handler=createMcpHandler(()=>createFocusMcpServer(grant,options),{legacy:'stateless'});
  const response=await handler.fetch(req,{parsedBody});
  response.headers.set('Cache-Control','no-store');response.headers.set('X-Content-Type-Options','nosniff');
  return response;
 }catch(error){
  const status=error.status||500;
  return Response.json({error:status===500?'Focus is temporarily unavailable.':publicMessage(error)},{status,headers:{'Cache-Control':'no-store',...(status===401?{'WWW-Authenticate':`Bearer resource_metadata="${APP_ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="focus:read focus:write"`}:{})}});
 }
}
