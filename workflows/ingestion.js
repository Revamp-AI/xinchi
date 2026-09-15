import {sleep,getWorkflowMetadata} from 'workflow';

async function advance(kind,id,token,workflowId,revision){
 'use step';
 try{const {advanceDurableUnit}=await import('../lib/durable-ingestion.mjs');return await advanceDurableUnit(kind,id,token,workflowId,revision);}
 catch{throw Error('Ingestion step temporarily unavailable.');}
}
advance.maxRetries=5;
async function failed(kind,id,workflowId){
 'use step';
 const {failDurableRun}=await import('../lib/durable-ingestion.mjs');await failDurableRun(kind,id,workflowId);
}
export async function ingestionWorkflow(kind,id,token){
 'use workflow';
 const {workflowRunId}=getWorkflowMetadata();let revision=0;
 try{for(;;){const result=await advance(kind,id,token,workflowRunId,revision);if(result.done)return{completed:!result.failed};revision=result.revision;if(result.waitMs)await sleep(result.waitMs);}}
 catch{await failed(kind,id,workflowRunId);return{completed:false};}
}
