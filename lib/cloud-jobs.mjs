import {timingSafeEqual} from 'node:crypto';
import {queuedWork} from './workers.mjs';
import {expireLeases} from './leases.mjs';
import {takePendingImportReview} from './agent.mjs';
import {runCloudAgent} from './cloud-agent.mjs';
import {runSyncWorker} from '../scripts/sync-worker.mjs';
import {runContactWorker} from '../scripts/contact-worker.mjs';
import {withJobBudget} from './job-budget.mjs';
export function authorizedCron(req){const secret=process.env.CRON_SECRET;if(!secret)return false;const expected=Buffer.from('Bearer '+secret),actual=Buffer.from(req.headers.get('authorization')||'');return actual.length===expected.length&&timingSafeEqual(actual,expected);}
export async function drainCloudWork(){
 await Promise.all(['jobs','sync_runs','contact_runs'].map(expireLeases));
 await takePendingImportReview();
 await Promise.all([['jobs',runCloudAgent],['sync_runs',runSyncWorker],['contact_runs',runContactWorker]].map(async([table,work])=>{const row=await queuedWork(table);if(row)await withJobBudget(7*60*1000,()=>work(row.id));}));
}
