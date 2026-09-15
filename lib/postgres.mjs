import pg from 'pg';
import {AsyncLocalStorage} from 'node:async_hooks';

// Counts and legacy millisecond timestamps fit safely in JS numbers. Refuse loss of precision.
pg.types.setTypeParser(20,value=>{const n=Number(value);if(!Number.isSafeInteger(n))throw Error('Database integer exceeds safe precision.');return n;});
pg.types.setTypeParser(1082,value=>value);
pg.types.setTypeParser(1184,value=>new Date(value).toISOString());
const context=new AsyncLocalStorage();
let pool;
export function getPool(){
 if(!pool){
  if(!process.env.DATABASE_URL)throw Error('Set DATABASE_URL to your Focus Postgres database and run npm run db:migrate.');
  pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:5,connectionTimeoutMillis:10000,idleTimeoutMillis:10000,allowExitOnIdle:true,application_name:'focus'});
  pool.on('error',()=>{}); // Request/worker operations report failures without logging connection credentials.
 }
 return pool;
}
// Existing parameterized queries use ?. Translate placeholders, never quoted text.
export function parameters(sql){
 let n=0,quote='',out='';
 for(let i=0;i<sql.length;i++){
  const c=sql[i];
  if(quote){out+=c;if(c===quote){if(sql[i+1]===quote)out+=sql[++i];else quote='';}}
  else if(c==="'"||c==='"'){quote=c;out+=c;}
  else if(c==='?')out+='$'+(++n);
  else out+=c;
 }
 if(/^INSERT OR IGNORE /i.test(out))out=out.replace(/^INSERT OR IGNORE /i,'INSERT ')+ ' ON CONFLICT DO NOTHING';
 return out;
}
export async function query(sql,args=[]){
 const tx=context.getStore();
 if(!tx)return getPool().query(parameters(sql),args);
 const result=tx.pending.then(()=>tx.client.query(parameters(sql),args));
 tx.pending=result.then(()=>undefined,()=>undefined);return result;
}
export async function all(sql,...args){return (await query(sql,args)).rows;}
export async function one(sql,...args){return (await query(sql,args)).rows[0];}
export async function run(sql,...args){const r=await query(sql,args);return {changes:r.rowCount,rows:r.rows};}
export async function transaction(fn){
 const parent=context.getStore();
 if(parent)return fn();
 const client=await getPool().connect(),tx={client,pending:Promise.resolve()};
 try{await client.query('BEGIN');const result=await context.run(tx,fn);await tx.pending;await client.query('COMMIT');return result;}
 catch(e){await tx.pending;await client.query('ROLLBACK');throw e;}finally{client.release();}
}
export async function lockWorkspace(){await one('SELECT id FROM workspace_lock WHERE id=1 FOR UPDATE');}
export async function closeDatabase(){if(pool){const old=pool;pool=undefined;await old.end();}}
export const db={close:closeDatabase};
