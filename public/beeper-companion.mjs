#!/usr/bin/env node
// Standalone Focus companion. Node 24+. No npm installation or inbound cloud access.
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile,rename,chmod,copyFile,unlink} from 'node:fs/promises';
import {homedir,hostname} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline/promises';

const base='http://127.0.0.1:23373',day=86400000;
const home=process.env.FOCUS_BEEPER_HOME||join(homedir(),'Library','Application Support','Focus Beeper');
const configPath=join(home,'config.json'),statePath=join(home,'state.json'),scriptPath=fileURLToPath(import.meta.url);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function readJson(path,fallback){try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
export async function savePrivate(path,value){await mkdir(dirname(path),{recursive:true,mode:0o700});const temp=path+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(value),{mode:0o600});await rename(temp,path);await chmod(path,0o600);}
export function focusOrigin(value){const u=new URL(value);if(u.username||u.password||u.pathname!=='/'||u.search||u.hash||!(u.protocol==='https:'||u.origin==='http://127.0.0.1:3210'))throw Error('Use your Focus HTTPS address.');return u.origin;}
export async function requestJson(url,{token,method='GET',body,form,allowEmpty=false}={}){
 const headers={};if(token)headers.Authorization='Bearer '+token;
 if(body)headers['Content-Type']='application/json';if(form)headers['Content-Type']='application/x-www-form-urlencoded';
 const r=await fetch(url,{method,headers,body:form?new URLSearchParams(form):body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000),redirect:'error'});
 const reader=r.body?.getReader();let size=0,chunks=[];if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8*1024*1024){await reader.cancel();throw Error('Response exceeded the import size limit.');}chunks.push(value);}
 if(r.ok&&allowEmpty&&!size)return null;
 let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('The service returned an unreadable response.');}
 if(!r.ok){const error=Error(new URL(url).origin===base?'Beeper request failed ('+r.status+').':data.error||'Focus request failed ('+r.status+').');error.status=r.status;error.service=new URL(url).origin===base?'beeper':'focus';throw error;}return data;
}
const cloud=(config,action,body={})=>requestJson(config.origin+'/api/beeper/device/'+action,{method:'POST',token:config.token,body});
const local=(config,path)=>requestJson(base+path,{token:config.beeperToken});
function openAuthorization(url){const opened=spawnSync(process.platform==='darwin'?'open':'xdg-open',[url],{stdio:'ignore'});if(opened.status!==0)console.log('Open this address on this Mac: '+url);}
export async function authorizeBeeper({request=requestJson,open=openAuthorization}={}){
 const state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');let receive,reject;
 const callback=new Promise((yes,no)=>{receive=yes;reject=no;});callback.catch(()=>{});
 const server=createServer((req,res)=>{const u=new URL(req.url,'http://127.0.0.1');if(u.pathname!=='/callback'||u.searchParams.get('state')!==state){res.writeHead(400);res.end('Invalid authorization callback.');return;}res.writeHead(200,{'Content-Type':'text/plain','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end('Beeper authorization received. Return to the Focus companion.');if(u.searchParams.get('code'))receive(u.searchParams.get('code'));else reject(Error('Beeper authorization was cancelled.'));});
 await new Promise((yes,no)=>server.once('error',no).listen(0,'127.0.0.1',yes));
 const redirect='http://127.0.0.1:'+server.address().port+'/callback';const timeout=setTimeout(()=>reject(Error('Beeper authorization expired. Run setup again.')),180000);
 try{
  const client=await request(base+'/oauth/register',{method:'POST',body:{client_name:'Focus Beeper (read only)',redirect_uris:[redirect],token_endpoint_auth_method:'none',grant_types:['authorization_code'],response_types:['code'],scope:'read'}});
  if(typeof client.client_id!=='string')throw Error('Beeper did not register the companion.');
  const u=new URL(base+'/oauth/authorize');for(const[k,v]of Object.entries({client_id:client.client_id,redirect_uri:redirect,response_type:'code',scope:'read',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}))u.searchParams.set(k,v);
  console.log('In the Beeper authorization window, turn OFF "Allow sensitive actions", then click Approve.');
  console.log('After authorization, all direct conversations are selected by default. You will enter your Focus pairing code here.');
  await open(u.href);
  const code=await callback;
  const grant=await request(base+'/oauth/token',{method:'POST',form:{grant_type:'authorization_code',client_id:client.client_id,redirect_uri:redirect,code,code_verifier:verifier}});
  if(typeof grant.access_token!=='string'||!grant.access_token)throw Error('Beeper did not return access.');
  if(grant.scope&&grant.scope.split(/\s+/).includes('write')){
   let revoked=false;
   try{await request(base+'/oauth/revoke',{method:'POST',form:{token:grant.access_token,token_type_hint:'access_token'},allowEmpty:true});revoked=true;}catch{}
   const error=Error('Beeper granted write access. Turn OFF "Allow sensitive actions" in the Beeper authorization window before clicking Approve. '+(revoked?'The rejected credential has been revoked.':'Revoke the rejected "Focus Beeper (read only)" connection in Beeper → Settings → Integrations → Approved connections before retrying.'));
   error.code='BEEPER_WRITE_ACCESS';throw error;
  }
  return grant.access_token;
 }finally{clearTimeout(timeout);server.closeAllConnections();await new Promise(r=>server.close(r));}
}
export async function authorizeBeeperWithRetry(question,{authorize=authorizeBeeper,log=console.log}={}){
 for(;;){
  try{return await authorize();}catch(error){
   if(error.code!=='BEEPER_WRITE_ACCESS')throw error;
   log(error.message);
   if((await question('Retry Beeper authorization with "Allow sensitive actions" off? [yes/no]: ')).trim().toLowerCase()!=='yes')throw Error('Setup cancelled before pairing.');
  }
 }
}
export function cleanChat(c){return{id:c.id,accountID:c.accountID,network:String(c.network||'Beeper').slice(0,100),title:String(c.title||'Direct conversation').slice(0,300),type:c.type,participants:{hasMore:c.participants?.hasMore===true,items:(c.participants?.items||[]).map(p=>({id:p.id,fullName:String(p.fullName||'').slice(0,300),email:String(p.email||'').slice(0,300),isSelf:p.isSelf===true,isNetworkBot:p.isNetworkBot===true}))}};}
export function cleanMessage(m){return{id:m.id,accountID:m.accountID,chatID:m.chatID,senderID:m.senderID,senderName:String(m.senderName||'').slice(0,300),timestamp:m.timestamp,isSender:m.isSender,text:m.text||'',type:m.type||'',isDeleted:m.isDeleted===true,isHidden:m.isHidden===true,linkedMessageID:m.linkedMessageID||''};}
export async function listDirectChats(config){
 let cursor,rows=[],seen=new Set();for(let page=0;page<1000;page++){
  const result=await local(config,'/v1/chats'+(cursor?'?cursor='+encodeURIComponent(cursor)+'&direction=before':''));if(!Array.isArray(result.items))throw Error('Beeper did not return a conversation list.');
  for(const c of result.items)if(c.type==='single'&&!seen.has(c.id)){seen.add(c.id);rows.push(cleanChat(c));}
  if(!result.hasMore)return rows;if(!result.oldestCursor||result.oldestCursor===cursor)throw Error('Beeper conversation pagination did not advance.');cursor=result.oldestCursor;
 }throw Error('Conversation list is too large. Contact Focus support.');
}
export function chooseChats(input,chats){
 if(!chats.length)throw Error('No direct conversations are available in Beeper.');
 if(!input.trim()||input.trim().toLowerCase()==='all')return chats;
 const numbers=[...new Set(input.split(',').map(s=>Number(s.trim())))];if(numbers.some(n=>!Number.isInteger(n)||n<1||n>chats.length))throw Error('Enter all or comma-separated conversation numbers.');return numbers.map(n=>chats[n-1]);
}
export async function selectChats(chats,{choose=false,question,log=console.log}={}){
 if(!choose){const selected=chooseChats('',chats);log(`\nAll ${selected.length} direct conversations selected.`);return selected;}
 log('\nChoose conversations on this Mac. Their messages have not been uploaded.');
 chats.forEach((c,i)=>log(`${i+1}. ${c.network}: ${c.title}`));
 return chooseChats(await question('\nConversation numbers, separated by commas [all]: '),chats);
}
export function splitRecords(records){const batches=[];let batch=[],bytes=2;for(const r of records){const n=Buffer.byteLength(JSON.stringify(r))+1;if(n>240000)throw Error('A message is too large to import without truncation.');if(batch.length&&(batch.length===25||bytes+n>240000)){batches.push(batch);batch=[];bytes=2;}batch.push(r);bytes+=n;}if(batch.length)batches.push(batch);return batches;}
export function pageProgress(page,previousCursor,cutoff){
 if(!Array.isArray(page.items))throw Error('Beeper did not return a message list.');
 if(page.items.some(m=>!Number.isFinite(Date.parse(m.timestamp))))throw Error('A message has no valid timestamp.');
 const oldest=Math.min(...page.items.map(m=>Date.parse(m.timestamp)));
 const done=!page.hasMore||oldest<cutoff;
 if(!done&&(!page.oldestCursor||page.oldestCursor===previousCursor))throw Error('Beeper message pagination did not advance.');
 return{done,cursor:done?null:page.oldestCursor};
}
export async function syncTick(config,state,{requestCloud=cloud,requestLocal=local,save=s=>savePrivate(statePath,s)}={}){
 const heart=await requestCloud(config,'heartbeat');
 if(state.run?.sealed){
  const result=await requestCloud(config,'start',{request_id:state.run.id});
  if(result.state==='complete'){state.lastSuccess=state.run.started_at;if(state.run.full)state.lastFull=state.run.started_at;state.run=null;await save(state);return 'Import complete';}
  if(result.state==='failed')throw Error('Cloud import paused. Use Retry import in Focus.');return 'Cloud processing';
 }
 if(!state.run){
  if(heart.active&&['queued','running'].includes(heart.active.state))return 'Cloud processing';
  if(heart.active?.state==='failed')throw Error('Cloud import paused. Use Retry import in Focus.');
  if(!heart.requested&&state.lastSuccess&&Date.now()-Date.parse(state.lastSuccess)<900000)return 'Up to date';
  // Persist the request ID before sending: a lost response cannot create a second run.
  state.run={id:heart.active?.state==='uploading'?heart.active.id:randomUUID(),chatIndex:0,cursor:null,part:heart.active?.part_count||0,full:!state.lastFull||Date.now()-Date.parse(state.lastFull)>day};await save(state);
 }
 const r=state.run;
 if(!r.started_at){const started=await requestCloud(config,'start',{request_id:r.id});if(started.state!=='uploading')throw Error('Cloud import state changed. Check Focus.');r.started_at=started.started_at;r.part=started.part_count;r.cutoff=Math.max(Date.parse(r.started_at)-90*day,r.full?0:Date.parse(state.lastSuccess||0)-2*day);await save(state);}
 if(r.pending){
  await requestCloud(config,'batch',{run_id:r.id,part:r.part,records:r.pending.batches[0]});r.part++;r.pending.batches.shift();
  if(!r.pending.batches.length){r.cursor=r.pending.cursor;if(r.pending.done){r.chatIndex++;r.cursor=null;r.chat=null;}r.pending=null;}await save(state);return 'Batch saved';
 }
 if(r.chatIndex>=config.selection.length){await requestCloud(config,'finish',{run_id:r.id,parts:r.part});r.sealed=true;await save(state);return 'Upload complete';}
 const selected=config.selection[r.chatIndex];
 if(!r.chat){r.chat=cleanChat(await requestLocal(config,'/v1/chats/'+encodeURIComponent(selected.id)));if(r.chat.id!==selected.id||r.chat.accountID!==selected.accountID||r.chat.type!=='single')throw Error('Selected conversation changed. Run setup again.');await save(state);return 'Conversation ready';}
 const page=await requestLocal(config,'/v1/chats/'+encodeURIComponent(selected.id)+'/messages'+(r.cursor?'?cursor='+encodeURIComponent(r.cursor)+'&direction=before':''));
 const progress=pageProgress(page,r.cursor,r.cutoff),records=page.items.filter(m=>Date.parse(m.timestamp)>=r.cutoff&&Date.parse(m.timestamp)<=Date.parse(r.started_at)+300000).map(m=>({chat:r.chat,message:cleanMessage(m)}));
 const batches=splitRecords(records);
 if(batches.length)r.pending={batches,...progress};else{r.cursor=progress.cursor;if(progress.done){r.chatIndex++;r.chat=null;}}
 await save(state);return 'Page saved locally';
}
const xml=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const service='ai.getrevamp.focus-beeper',plist=join(homedir(),'Library','LaunchAgents',service+'.plist');
export async function installMac(){
 if(process.platform!=='darwin')throw Error('Automatic startup currently supports macOS. Use the run command on other systems.');
 await mkdir(home,{recursive:true,mode:0o700});const target=join(home,'beeper-companion.mjs');if(resolve(scriptPath)!==resolve(target))await copyFile(scriptPath,target);await chmod(target,0o600);
 const log=join(home,'companion.log');await writeFile(log,'',{flag:'a',mode:0o600});await chmod(log,0o600);
 await mkdir(dirname(plist),{recursive:true});
 await writeFile(plist,`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${service}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(target)}</string><string>run</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>EnvironmentVariables</key><dict><key>FOCUS_BEEPER_HOME</key><string>${xml(home)}</string></dict><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>`,{mode:0o600});
 spawnSync('launchctl',['bootout','gui/'+process.getuid(),plist],{stdio:'ignore'});
 const result=spawnSync('launchctl',['bootstrap','gui/'+process.getuid(),plist],{stdio:'pipe'});if(result.status!==0)throw Error('Could not enable startup. Run the companion with the run command.');
 console.log('Focus Beeper is running and will start when you sign in to this Mac.');
}
async function setup({choose=false}={}){
 const rl=createInterface({input:process.stdin,output:process.stdout});
 try{
  console.log('Focus Beeper — all direct conversations by default, read-only access, last 90 days.');
  const origin=focusOrigin((await rl.question('Focus address [https://focus-revamp.vercel.app]: ')).trim()||'https://focus-revamp.vercel.app');
  const beeperToken=await authorizeBeeperWithRetry(prompt=>rl.question(prompt));const chats=await listDirectChats({beeperToken});
  const selected=await selectChats(chats,{choose,question:prompt=>rl.question(prompt)}),selection=selected.map(({id,accountID,title,network})=>({id,accountID,title,network}));
  console.log(`\nFocus will store messages from these ${selection.length} conversations in your cloud archive and use them for contacts and cloud reviews.`);
  if((await rl.question('Continue with this selection? [yes/no]: ')).trim().toLowerCase()!=='yes')throw Error('Setup cancelled before uploading.');
  const code=(await rl.question('Pairing code from Focus → Connections → Beeper: ')).trim();
  // Stop the previous login service before replacing its checkpoint and token.
  if(process.platform==='darwin')spawnSync('launchctl',['bootout','gui/'+process.getuid(),plist],{stdio:'ignore'});
  const paired=await requestJson(origin+'/api/beeper/device/pair',{method:'POST',body:{code,label:hostname().slice(0,100),selection}});
  await savePrivate(configPath,{origin,beeperToken,token:paired.token,id:paired.id,selection});await savePrivate(statePath,{});
  console.log('Paired. Your Beeper credential is stored only on this Mac.');
  await installMac();
 }finally{rl.close();}
}
async function runLoop(once=false){
 const config=await readJson(configPath);if(!config)throw Error('Run setup first.');focusOrigin(config.origin);
 const lockPath=join(home,'companion.pid');let lock;
 for(let attempt=0;attempt<2;attempt++){try{await writeFile(lockPath,String(process.pid),{flag:'wx',mode:0o600});lock=true;break;}catch(e){if(e.code!=='EEXIST')throw e;const pid=Number(await readFile(lockPath,'utf8'));try{process.kill(pid,0);throw Error('The companion is already running.');}catch(error){if(error.code!=='ESRCH')throw error;await unlink(lockPath);}}}
 if(!lock)throw Error('Could not acquire the companion lock.');
 let previous='',state=await readJson(statePath,{});
 try{do{
  let wait=250;
  try{const result=await syncTick(config,state);if(result!==previous&&['Import complete','Upload complete','Up to date'].includes(result))console.log(new Date().toISOString()+' '+result);previous=result;if(['Up to date','Cloud processing'].includes(result))wait=30000;}
  catch(e){state=await readJson(statePath,{});const issue=e.service==='beeper'&&e.status===401?'auth':e.cause?.code==='ECONNREFUSED'?'offline':'sync';try{await cloud(config,'heartbeat',{issue});}catch{}const message=e.service==='focus'&&e.status===401?'Pairing was revoked. Run setup again.':issue==='auth'?'Beeper access expired. Run setup again.':issue==='offline'?'Waiting for Beeper Desktop.':e.message;if(message!==previous)console.error(new Date().toISOString()+' '+message);previous=message;wait=30000;}
  if(!once)await delay(wait);
 }while(!once);}finally{await unlink(lockPath).catch(()=>{});}
}
export async function main(command=process.argv[2]){
 if(Number(process.versions.node.split('.')[0])<24)throw Error('Install Node.js 24 or newer first.');
 if(command==='setup')return setup({choose:process.argv.slice(3).includes('--choose')});
 if(command==='install')return installMac();
 if(command==='run'||command==='once')return runLoop(command==='once');
 if(command==='uninstall'){spawnSync('launchctl',['bootout','gui/'+process.getuid(),plist],{stdio:'ignore'});await unlink(plist).catch(e=>{if(e.code!=='ENOENT')throw e;});console.log('Automatic syncing stopped. Revoke this Mac in Focus → Connections → Beeper to remove cloud access.');return;}
 if(command==='status'){const c=await readJson(configPath),s=await readJson(statePath,{});console.log(JSON.stringify({paired:!!c,conversations:c?.selection?.length||0,last_success:s.lastSuccess||null,uploading:!!s.run},null,2));return;}
 console.log('Usage: node beeper-companion.mjs setup [--choose] | run | once | install | status | uninstall');
}
if(process.argv[1]&&resolve(process.argv[1])===scriptPath)main().catch(e=>{console.error(e.message);process.exitCode=1;});
