import pg from 'pg';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
export async function migrateDatabase(url=process.env.DATABASE_URL_UNPOOLED||process.env.DATABASE_URL){
 if(!url)throw Error('Set DATABASE_URL (and optionally DATABASE_URL_UNPOOLED) before migrating.');
 const client=new pg.Client({connectionString:url,application_name:'focus-migrations',connectionTimeoutMillis:10000});
 await client.connect();
 try{
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('focus-schema'))");
  await client.query('CREATE TABLE IF NOT EXISTS focus_schema_migrations(name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const dir=fileURLToPath(new URL('../migrations/',import.meta.url));
  for(const name of (await readdir(dir)).filter(n=>/^\d+_[a-z_]+\.sql$/.test(n)).sort()){
   const sql=await readFile(dir+'/'+name,'utf8'),checksum=createHash('sha256').update(sql).digest('hex');
   const old=(await client.query('SELECT checksum FROM focus_schema_migrations WHERE name=$1',[name])).rows[0];
   if(old){if(old.checksum!==checksum)throw Error('An applied migration was changed: '+name);continue;}
   await client.query(sql);await client.query('INSERT INTO focus_schema_migrations(name,checksum) VALUES($1,$2)',[name,checksum]);
  }
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e;}finally{await client.end();}
}
