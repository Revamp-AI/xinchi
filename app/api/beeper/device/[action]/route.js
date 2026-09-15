import {after} from 'next/server.js';
import {start,getRun} from 'workflow/api';
import {ingestionWorkflow} from '../../../../../workflows/ingestion.js';
import {drainCloudWork} from '../../../../../lib/cloud-jobs.mjs';
import {handleBeeperRequest} from '../../../../../lib/beeper-route.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=800;
export async function POST(req,{params}){
 const {action}=await params;
 return handleBeeperRequest(req,action,()=>after(async()=>{try{await drainCloudWork((...args)=>start(ingestionWorkflow,args),id=>getRun(id).status);}catch{console.error('Beeper dispatch interrupted; saved import will retry.');}}));
}
