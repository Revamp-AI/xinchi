import {agentPolicy} from '../lib/agent-policy.mjs';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {and,eq,gt,like,or,sql} from 'drizzle-orm';
import {stamp,dataDir,root} from '../lib/db.ts';
import {schema,saveResult,addProgress,takePendingImportReview,launchJob} from '../lib/agent.ts';
import {claimLease,heartbeatLease} from '../lib/leases.ts';
import {closeDatabase,databaseErrorCode,db} from '../lib/postgres.ts';
import {job_events,jobs} from '../lib/schema/index.ts';
const id=process.argv[2]||'',claim=await claimLease('jobs',id);
if(!claim)process.exit(0);
const {row:job,token}=claim;
const dir=resolve(dataDir,'runs',id);mkdirSync(dir,{recursive:true,mode:0o700});
const schemaPath=resolve(dir,'schema.json'),output=resolve(dir,'result.json');writeFileSync(schemaPath,JSON.stringify(schema));
const policy=agentPolicy();
const prompt=policy+'\n\nThe user asks:\n'+job.prompt;
const args=['exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--config','approval_policy="never"','--config','web_search="disabled"','--config','model_reasoning_effort="medium"','--config','project_doc_max_bytes=0','--config',`mcp_servers.context.command=${JSON.stringify(process.execPath)}`,'--config',`mcp_servers.context.args=${JSON.stringify([resolve(root,'scripts/context-mcp.mjs')])}`,'--config',`mcp_servers.context.env.XIN_APP_ROOT=${JSON.stringify(root)}`,'--config',`mcp_servers.context.env.XIN_DATA_DIR=${JSON.stringify(dataDir)}`,'--config',`mcp_servers.context.env.XIN_JOB_ID=${JSON.stringify(id)}`,'--config','mcp_servers.context.env_vars=["DATABASE_URL"]','--output-schema',schemaPath,'--output-last-message',output,'--json','-'];
for(const feature of ['shell_tool','apps','plugins','browser_use','computer_use','in_app_browser','multi_agent','hooks','skill_search','image_generation'])args.push('--disable',feature);
(await addProgress(id,'Agent is connecting to your stored context'));
const child=spawn(process.env.XIN_CODEX_BIN||'codex',args,{cwd:dir,env:process.env,stdio:['pipe','pipe','pipe']});
child.stdin.on('error',()=>{});child.stdin.end(prompt);let diagnostics='',eventBuffer='';
child.stdout.on('data',b=>{eventBuffer+=b.toString();for(;;){const n=eventBuffer.indexOf('\n');if(n<0)break;const line=eventBuffer.slice(0,n);eventBuffer=eventBuffer.slice(n+1);try{const e=JSON.parse(line);if(e.type==='error'||e.type==='turn.failed')diagnostics+=JSON.stringify(e).slice(0,2000)+'\n';}catch{}}});
child.stderr.on('data',b=>{diagnostics=(diagnostics+b.toString()).slice(-8000);});
let timedOut=false;const timeout=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),3000).unref();},8*60*1000);
let lostLease=false,checking=false;
const stop=()=>{child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),3000).unref();};
const heartbeat=setInterval(async()=>{if(checking)return;checking=true;try{if(!await heartbeatLease('jobs',id,token)){lostLease=true;stop();}}catch{lostLease=true;stop();}finally{checking=false;}},10000);
const onSignal=()=>{lostLease=true;stop();};process.on('SIGTERM',onSignal);
try{
 const code=await new Promise((resolve,reject)=>{child.once('error',e=>reject(Error((e as NodeJS.ErrnoException).code==='ENOENT'?'Codex is not installed. Install and sign into Codex on this Mac.':'Could not start the agent.')));child.once('close',resolve);});
 if(lostLease)throw Error('This review was cancelled or interrupted.');
 if(code!==0)throw Error(timedOut?'The review timed out. Try a narrower question.':'The agent could not finish. Check Codex sign-in and retry.');
 if(!(await db.select({id:job_events.id}).from(job_events).where(and(eq(job_events.job_id,id),or(like(job_events.label,'Reading:%'),like(job_events.label,'Checking your commitments%')))).limit(1)).length)throw Error('The agent could not read the stored context. Check the work log and retry.');
 await saveResult(id,JSON.parse(readFileSync(output,'utf8')),token);
 await addProgress(id,'Review ready — proposals await your decision');
}catch(caught){const e=caught as Error;await db.update(jobs).set({status:'failed',error:databaseErrorCode(e)?'The review could not be saved. Check the database connection and retry.':e.message.slice(0,2000),updated_at:stamp()}).where(and(eq(jobs.id,id),eq(jobs.status,'running'),eq(jobs.lease_owner,token),gt(jobs.lease_until,sql`now()`)));}
finally{clearTimeout(timeout);clearInterval(heartbeat);process.off('SIGTERM',onSignal);const pending=await takePendingImportReview();if(pending)await launchJob(pending);await closeDatabase();}
