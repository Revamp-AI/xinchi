import {readFile} from 'node:fs/promises';
import {parseLinkedinConnections,previewLinkedinConnections,importLinkedinBatch} from '../lib/linkedin-import.mjs';
import {closeDatabase} from '../lib/postgres.mjs';

try{
 const args=process.argv.slice(2),apply=args.includes('--apply'),paths=args.filter(a=>a!=='--apply');
 if(paths.length!==1||paths[0].startsWith('--'))throw Error('Usage: node scripts/import-linkedin.mjs /path/to/Connections.csv [--apply]');
 const parsed=parseLinkedinConnections(await readFile(paths[0],'utf8'));
 if(!apply)console.log(JSON.stringify({apply:false,...await previewLinkedinConnections(parsed)},null,2));
 else{
  const result={apply:true,total:parsed.total,identifiable:parsed.records.length,skipped:parsed.skipped.length,added:0,matched:0,unchanged:0,conflicts:0,review_pairs:0};
  for(let offset=0;offset<parsed.records.length;offset+=100){
   const batch=await importLinkedinBatch(parsed.records.slice(offset,offset+100));
   for(const key of Object.keys(batch))result[key]+=batch[key];
   console.log(JSON.stringify({processed:Math.min(offset+100,parsed.records.length),...result}));
  }
  console.log(JSON.stringify(result,null,2));
 }
}catch(error){console.error(error.code?'LinkedIn import failed ('+error.code+').':error.message);process.exitCode=1;}
finally{await closeDatabase();}
