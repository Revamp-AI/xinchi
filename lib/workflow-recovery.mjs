import {all} from './db.mjs';
import {recoverStalledRun} from './durable-ingestion.mjs';

const terminalStatuses=new Set(['completed','failed','cancelled']);
export async function reconcileWorkflows(inspectStatus){
 const rows=await all("SELECT kind,run_id,workflow_id,revision FROM durable_runs WHERE completed=false AND workflow_id<>'' ORDER BY updated_at,kind,run_id LIMIT 20");
 // Network lookups do not hold locks. A resumed run can change owners while a
 // lookup is in flight; recovery checks both the owner and the saved revision before writing.
 const statuses=await Promise.allSettled(rows.map(async row=>inspectStatus(row.workflow_id)));
 for(let index=0;index<rows.length;index++){
  const status=statuses[index],row=rows[index];
  await recoverStalledRun(row.kind,row.run_id,row.workflow_id,row.revision,{terminal:status.status==='fulfilled'&&terminalStatuses.has(status.value)});
 }
 return rows.length;
}
