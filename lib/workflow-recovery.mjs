import {all} from './db.mjs';
import {failDurableRun} from './durable-ingestion.mjs';

const terminalStatuses=new Set(['completed','failed','cancelled']);
export async function reconcileWorkflows(inspectStatus){
 const rows=await all("SELECT kind,run_id,workflow_id FROM durable_runs WHERE completed=false AND workflow_id<>'' ORDER BY updated_at,kind,run_id LIMIT 20");
 // Network lookups do not hold locks. A resumed run can change owners while a
 // lookup is in flight; failDurableRun checks that owner again before writing.
 const statuses=await Promise.allSettled(rows.map(async row=>inspectStatus(row.workflow_id)));
 for(let index=0;index<rows.length;index++){
  const status=statuses[index];if(status.status!=='fulfilled'||!terminalStatuses.has(status.value))continue;
  const row=rows[index];await failDurableRun(row.kind,row.run_id,row.workflow_id);
 }
 return rows.length;
}
