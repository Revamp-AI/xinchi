import {migrateDatabase} from '../../lib/migrations.ts';
import pg from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {after} from 'node:test';
import {closeDatabase} from '../../lib/postgres.ts';

function serverUrl(){
 const url=new URL(process.env.FOCUS_TEST_DATABASE_URL||'postgresql://127.0.0.1:55439/postgres');
 if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('Tests require an isolated local Postgres server; FOCUS_TEST_DATABASE_URL must be loopback.');
 return url;
}
export async function setupTestDatabase(){
 const url=serverUrl();
 const name='focus_test_'+randomUUID().replaceAll('-','');
 const admin=new pg.Client({connectionString:url.href});await admin.connect();
 await admin.query('CREATE DATABASE '+name);
 url.pathname='/'+name;process.env.DATABASE_URL=url.href;delete process.env.DATABASE_URL_UNPOOLED;
 await migrateDatabase(url.href);
 after(async()=>{await closeDatabase();await admin.query('DROP DATABASE '+name+' WITH (FORCE)');await admin.end();});
 return url.href;
}
// An unmigrated database that is dropped when the test t finishes.
export async function createEmptyDatabase(t){
 const url=serverUrl(),name='focus_test_'+randomUUID().replaceAll('-','');
 const admin=new pg.Client({connectionString:url.href});await admin.connect();
 await admin.query('CREATE DATABASE '+name);
 t.after(async()=>{await admin.query('DROP DATABASE '+name+' WITH (FORCE)');await admin.end();});
 url.pathname='/'+name;return url.href;
}
// Builds a database the way the pre-Drizzle runner did, so adoption is tested against real legacy history.
export async function applyLegacyMigrations(url,through=Infinity){
 const dir=fileURLToPath(new URL('../../migrations/',import.meta.url));
 const client=new pg.Client({connectionString:url});await client.connect();
 try{
  await client.query('CREATE TABLE IF NOT EXISTS focus_schema_migrations(name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  for(const name of readdirSync(dir).filter(n=>/^\d+_[a-z_]+\.sql$/.test(n)&&parseInt(n,10)<=through).sort()){
   const sql=readFileSync(dir+name,'utf8');
   await client.query(sql);await client.query('INSERT INTO focus_schema_migrations(name,checksum) VALUES($1,$2)',[name,createHash('sha256').update(sql).digest('hex')]);
  }
 }finally{await client.end();}
}
// Statements drizzle-kit would run to make the database match lib/schema; empty means no drift.
export async function schemaDrift(url){
 const {drizzle}=await import('drizzle-orm/node-postgres');const {pushSchema}=await import('drizzle-kit/api-postgres');
 const schema=await import('../../lib/schema/index.ts');
 // Introspection reads int8 catalog values such as sequence maxima, which the app's parser rejects as unsafe.
 const pool=new pg.Pool({connectionString:url}),int8=pg.types.getTypeParser(20);pg.types.setTypeParser(20,v=>v);
 // pool.end() resolves before sockets close, so a test's forced DROP DATABASE can still reach them; without a listener that error would be uncaught.
 pool.on('error',()=>{});
 try{return (await pushSchema(schema,drizzle({client:pool}),{schemas:['public','focus_auth'],tables:['!focus_schema_migrations'],entities:undefined,extensions:undefined})).sqlStatements;}
 finally{pg.types.setTypeParser(20,int8);await pool.end();}
}
