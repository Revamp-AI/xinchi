import readline from 'node:readline';
import {contextTools as tools,callContextTool} from '../lib/context-tools.mjs';
const reply=(id,result,error)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,...(error?{error}:{result})})+'\n');
for await(const line of readline.createInterface({input:process.stdin})){
 let m;try{m=JSON.parse(line);}catch{continue;}
 if(m.id===undefined)continue;
 try{
 if(m.method==='initialize')reply(m.id,{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'Focus stored context',version:'1.0'}});
 else if(m.method==='tools/list')reply(m.id,{tools});
 else if(m.method==='ping')reply(m.id,{});
 else if(m.method==='tools/call'){
  const {name,arguments:a={}}=m.params;const result=await callContextTool(name,a,{jobId:process.env.XIN_JOB_ID});
  reply(m.id,{content:[{type:'text',text:JSON.stringify(result)}]});
 }else reply(m.id,null,{code:-32601,message:'Method not found'});
 }catch(e){reply(m.id,{isError:true,content:[{type:'text',text:e.code?'The context database is unavailable.':e.message}]});}
}
