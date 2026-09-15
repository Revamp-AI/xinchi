import {after} from 'next/server.js';
import {start,getRun} from 'workflow/api';
import {handleMcpRequest} from '../../lib/mcp-server.mjs';
import {drainCloudWork} from '../../lib/cloud-jobs.mjs';
import {ingestionWorkflow} from '../../workflows/ingestion.js';
import {CLOUD_JOBS} from '../../lib/runtime.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=800;
function schedule(){if(CLOUD_JOBS)after(async()=>{try{await drainCloudWork((...args)=>start(ingestionWorkflow,args),id=>getRun(id).status);}catch{console.error('MCP background dispatch deferred to the next worker check.');}});}
export const POST=req=>handleMcpRequest(req,{schedule});
export const GET=req=>handleMcpRequest(req);
export const DELETE=req=>handleMcpRequest(req);
