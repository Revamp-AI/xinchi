import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
const argv=process.argv.slice(2),e2e=argv[0]==='--e2e';
let cluster;
const env={...process.env};delete env.DATABASE_URL;delete env.DATABASE_URL_UNPOOLED;
function command(bin,args){const r=spawnSync(bin,args,{encoding:'utf8',env});if(r.error)throw Error(bin+' is unavailable. Install PostgreSQL 16+ or set FOCUS_TEST_DATABASE_URL to a local test server.');if(r.status)throw Error(bin+' failed: '+r.stderr.slice(0,1200));}
try{
 if(!env.FOCUS_TEST_DATABASE_URL){
  cluster=mkdtempSync(join(tmpdir(),'focus-test-pg-'));
  const server=net.createServer();await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  command('initdb',['-D',cluster,'-A','trust','--encoding=UTF8','--no-locale']);
  command('pg_ctl',['-D',cluster,'-l',join(cluster,'server.log'),'-o',`-h 127.0.0.1 -p ${port} -c max_connections=100`,'start']);
  env.FOCUS_TEST_DATABASE_URL=`postgresql://127.0.0.1:${port}/postgres`;
 }
 if(e2e){const url=new URL(env.FOCUS_TEST_DATABASE_URL);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('Browser tests require loopback Postgres.');const pg=(await import('pg')).default;const admin=new pg.Client({connectionString:url.href});await admin.connect();const name='focus_e2e_'+Date.now();await admin.query('CREATE DATABASE '+name);await admin.end();url.pathname='/'+name;env.DATABASE_URL=url.href;env.FOCUS_E2E_DATABASE_NAME=name;}
 const args=e2e?['node_modules/@playwright/test/cli.js','test',...argv.slice(1)]:['--test',...(argv.length?argv:readdirSync('tests').filter(n=>n.endsWith('.test.mjs')).map(n=>'tests/'+n))];
 process.exitCode=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{env,stdio:'inherit'});child.once('error',reject);child.once('exit',code=>resolve(code??1));});
}catch(e){console.error(e.message);process.exitCode=1;}
finally{
 if(env.FOCUS_E2E_DATABASE_NAME){try{const pg=(await import('pg')).default;const admin=new pg.Client({connectionString:env.FOCUS_TEST_DATABASE_URL});await admin.connect();await admin.query('DROP DATABASE '+env.FOCUS_E2E_DATABASE_NAME+' WITH (FORCE)');await admin.end();}catch{}}
 if(cluster){try{command('pg_ctl',['-D',cluster,'-m','immediate','stop']);}catch{}rmSync(cluster,{recursive:true,force:true});}
}
