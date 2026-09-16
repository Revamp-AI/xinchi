import {prepareDispatches,acknowledgeDispatch,releaseDispatch} from './durable-ingestion.mjs';
export async function dispatchIngestion(startRun){
 const rows=await prepareDispatches();
 for(const row of rows){try{const result=await startRun(row.kind,row.id,row.token);await acknowledgeDispatch(row.kind,row.id,row.token,result.runId);}catch{await releaseDispatch(row.kind,row.id,row.token);}}
 return rows.length;
}
