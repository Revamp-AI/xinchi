import {timingSafeEqual} from 'node:crypto';
import {queuedWork} from './workers.mjs';
import {expireLeases} from './leases.mjs';
import {takePendingImportReview} from './agent.mjs';
import {runCloudAgent} from './cloud-agent.mjs';
import {dispatchIngestion} from './workflow-dispatch.mjs';
import {reconcileWorkflows} from './workflow-recovery.mjs';
export function authorizedCron(req){const secret=process.env.CRON_SECRET;if(!secret)return false;const expected=Buffer.from('Bearer '+secret),actual=Buffer.from(req.headers.get('authorization')||'');return actual.length===expected.length&&timingSafeEqual(actual,expected);}
export async function drainCloudWork(startIngestion,inspectWorkflow){
 if(inspectWorkflow)await reconcileWorkflows(inspectWorkflow);
 await Promise.all(['jobs','sync_runs','contact_runs'].map(expireLeases));
 await takePendingImportReview();
 if(startIngestion)await dispatchIngestion(startIngestion);
 const review=await queuedWork('jobs');if(review)await runCloudAgent(review.id);
}
