import {migrateDatabase} from '../lib/migrations.mjs';
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdirSync,existsSync,chmodSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {all,one,run,transaction,lockWorkspace,exportTables,hash,stamp} from '../lib/db.mjs';
import {closeDatabase} from '../lib/postgres.mjs';
const legacyTables=['sources','source_versions','items','events','settings','jobs','proposals','job_events','sync_runs'];
const read=(db,table)=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)?db.prepare('SELECT * FROM '+table).all():[];
// Source files are read-only; callers stop all old writers before taking the cutover snapshot.
export async function migrateSqlite({sourceDir,backupDir,apply=false,writersStopped=false}){
 if(!sourceDir||!backupDir)throw Error('Choose a source data directory and a new private backup directory.');
 if(apply&&!writersStopped)throw Error('Stop the app and workers, then pass --writers-stopped.');
 if(resolve(sourceDir)===resolve(backupDir)||existsSync(backupDir))throw Error('Use a new backup directory separate from the source.');
 mkdirSync(backupDir,{recursive:true,mode:0o700});
 const snapshots={};
 for(const filename of ['xin.sqlite3','auth.secret.sqlite3']){
  const file=join(sourceDir,filename);if(!existsSync(file)){if(filename==='xin.sqlite3')throw Error('SQLite workspace not found.');continue;}
  const original=new DatabaseSync(file,{readOnly:true});try{await backup(original,join(backupDir,filename));}finally{original.close();}
  chmodSync(join(backupDir,filename),0o400);snapshots[filename]=new DatabaseSync(join(backupDir,filename),{readOnly:true});
 }
 try{
  const tables=Object.fromEntries(legacyTables.map(t=>[t,read(snapshots['xin.sqlite3'],t)]));
  if(snapshots['auth.secret.sqlite3'])for(const t of ['owner','auth_events'])tables['focus_auth.'+t]=read(snapshots['auth.secret.sqlite3'],t);
  const report={applied:false,counts:Object.fromEntries(Object.entries(tables).map(([t,r])=>[t,r.length])),source_digest:hash(tables.sources.map(r=>[r.id,r.body,r.content_hash])),version_digest:hash(tables.source_versions.map(r=>[r.id,r.raw_json,r.content_hash])),sessions_invalidated:true};
  if(!apply)return report;
  await migrateDatabase();
  await transaction(async()=>{
   await lockWorkspace();
   for(const table of [...exportTables,'focus_auth.owner','focus_auth.auth_events','focus_auth.sessions','focus_auth.oauth_attempts'])if((await one('SELECT count(*) AS n FROM '+table)).n)throw Error('Destination must be empty. Use a fresh database or restore into a new branch.');
   for(const [table,rows] of Object.entries(tables)){
    const [schema,name]=table.includes('.')?table.split('.'):['public',table];
    const columns=new Set((await all('SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=?',schema,name)).map(r=>r.column_name));
    for(const original of rows){
     const row={...original};
     if(table==='jobs'&&['running','queued'].includes(row.status))Object.assign(row,{status:'failed',error:'Interrupted at Postgres cutover. Start a new review.',pid:null});
     if(table==='sync_runs'&&['running','queued'].includes(row.state))Object.assign(row,{state:'failed',message:'Interrupted at Postgres cutover. Retry the import.',finished_at:stamp(),pid:null});
     const keys=Object.keys(row);if(keys.some(k=>!columns.has(k)))throw Error('Unsupported legacy column in '+table+'. Migration stopped.');
     await run(`INSERT INTO ${table} (${keys.map(k=>'"'+k+'"')}) VALUES (${keys.map(()=>'?')})`,...keys.map(k=>row[k]));
     const pk=keys.includes('id')?'id':keys.includes('key')?'key':null;
     if(pk){const copy=await one(`SELECT * FROM ${table} WHERE "${pk}"=?`,row[pk]);if(hash(Object.fromEntries(keys.map(k=>[k,copy[k]])))!==hash(row))throw Error('Row verification failed in '+table);}
    }
    if((await one('SELECT count(*) AS n FROM '+table)).n!==rows.length)throw Error('Count verification failed in '+table);
   }
   await run('UPDATE source_versions v SET normalized_body=s.body FROM sources s WHERE s.id=v.source_id AND s.content_hash=v.content_hash AND v.normalized_body IS NULL');
   for(const table of ['job_events','focus_auth.auth_events'])await one(`SELECT setval(pg_get_serial_sequence('${table}','id'),COALESCE((SELECT max(id) FROM ${table}),1),(SELECT count(*)>0 FROM ${table}))`);
  });
  return {...report,applied:true};
 }finally{for(const db of Object.values(snapshots))db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const args=process.argv.slice(2),value=flag=>args[args.indexOf(flag)+1];
 try{const report=await migrateSqlite({sourceDir:args.includes('--source-dir')?value('--source-dir'):null,backupDir:args.includes('--backup-dir')?value('--backup-dir'):null,apply:args.includes('--apply'),writersStopped:args.includes('--writers-stopped')});console.log(JSON.stringify(report,null,2));}
 catch(e){console.error(e.code?'Database migration failed; no imported records were committed.':e.message);process.exitCode=1;}finally{await closeDatabase();}
}
