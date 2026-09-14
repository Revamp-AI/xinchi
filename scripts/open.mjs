import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
const url='http://127.0.0.1:3210';
const ready=async()=>{try{const r=await fetch(url+'/api/auth/status',{signal:AbortSignal.timeout(1000)});const s=await r.json();return r.ok&&typeof s.configured==='boolean';}catch{return false;}};
const open=()=>spawn('open',[url],{stdio:'ignore'}).unref();
if(await ready()){open();process.exit(0);}
const child=spawn(process.execPath,[resolve('node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port','3210'],{stdio:'inherit'});
let closed=false;child.on('exit',code=>{closed=true;process.exitCode=code||0;});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{child.kill(signal);});
for(let n=0;n<60&&!closed;n++){if(await ready()){open();break;}await new Promise(r=>setTimeout(r,500));}
