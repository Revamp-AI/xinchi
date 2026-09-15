import {pairBeeper,requireBeeperDevice,beeperHeartbeat,beginBeeperUpload,appendBeeperBatch,finishBeeperUpload} from './beeper.mjs';
import {APP_ORIGIN} from './runtime.mjs';
const respond=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}});
export async function handleBeeperRequest(req,action,schedule=()=>{}){
 try{
  if(req.headers.get('host')!==new URL(APP_ORIGIN).host||req.headers.has('origin'))return respond({error:'Use the Focus companion to connect.'},403);
  if(!['pair','heartbeat','start','batch','finish'].includes(action))return respond({error:'Not found'},404);
  if(!req.headers.get('content-type')?.startsWith('application/json'))return respond({error:'JSON is required.'},415);
  const id=action==='pair'?null:await requireBeeperDevice(req),limit=512*1024;
  if(Number(req.headers.get('content-length'))>limit)return respond({error:'Batch is too large.'},413);
  const reader=req.body?.getReader();let bytes=0,chunks=[];if(reader)for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>limit){await reader.cancel();return respond({error:'Batch is too large.'},413);}chunks.push(value);}
  const data=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Provide a JSON object.');
  if(action==='pair')return respond(await pairBeeper(data),201);
  const operations={heartbeat:beeperHeartbeat,start:beginBeeperUpload,batch:appendBeeperBatch,finish:finishBeeperUpload};
  const result=await operations[action](id,data);if(action==='finish')schedule();return respond(result);
 }catch(e){return respond({error:e.code?'The database could not save this batch. Retry shortly.':e.message},e.status||400);}
}
