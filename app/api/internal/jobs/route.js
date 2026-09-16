import {authorizedCron,drainCloudWork} from '../../../../lib/cloud-jobs.mjs';
import {start,getRun} from 'workflow/api';
import {ingestionWorkflow} from '../../../../workflows/ingestion.js';
import {scheduleProviderSyncs} from '../../../../lib/scheduled-sync.mjs';
import {runAutoContactMatching} from '../../../../lib/contact-auto-match.mjs';
import {scheduleContactHistory} from '../../../../lib/contact-jobs.mjs';
import {runContactIntelligence} from '../../../../lib/contact-intelligence.mjs';
import {evaluateContacts} from '../../../../lib/contacts.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=800;
export async function GET(req){
 if(!authorizedCron(req))return Response.json({error:'Unauthorized'},{status:401});
 try{const scheduled=await scheduleProviderSyncs();let autoMatch;try{autoMatch=await runAutoContactMatching();}catch{autoMatch={error:'Automatic contact matching will retry.'};}const history=await scheduleContactHistory();await evaluateContacts();const [work,intelligence]=await Promise.allSettled([drainCloudWork((...args)=>start(ingestionWorkflow,args),id=>getRun(id).status),runContactIntelligence()]);if(work.status==='rejected')throw work.reason;return Response.json({processed:true,scheduled,autoMatch,history,intelligence:intelligence.status==='fulfilled'?intelligence.value:{error:'Contact analysis will retry.'}},{headers:{'Cache-Control':'no-store'}});}
 catch{return Response.json({error:'Worker interrupted; pending work will retry.'},{status:503});}
}
