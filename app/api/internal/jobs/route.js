import {authorizedCron,drainCloudWork} from '../../../../lib/cloud-jobs.mjs';
import {start,getRun} from 'workflow/api';
import {ingestionWorkflow} from '../../../../workflows/ingestion.js';
import {scheduleProviderSyncs} from '../../../../lib/scheduled-sync.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=800;
export async function GET(req){
 if(!authorizedCron(req))return Response.json({error:'Unauthorized'},{status:401});
 try{const scheduled=await scheduleProviderSyncs();await drainCloudWork((...args)=>start(ingestionWorkflow,args),id=>getRun(id).status);return Response.json({processed:true,scheduled},{headers:{'Cache-Control':'no-store'}});}
 catch{return Response.json({error:'Worker interrupted; pending work will retry.'},{status:503});}
}
