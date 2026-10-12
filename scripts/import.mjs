import {readFileSync} from 'node:fs';
import {importDocuments,importResearchArchive} from '../lib/imports.mjs';
import {databaseErrorCode} from '../lib/postgres.ts';
const path=process.argv[2];
if(!path){console.error('Usage: npm run import -- /path/to/sources.json');process.exit(1);}
try{
 const input=JSON.parse(readFileSync(path,'utf8'));
 const result=input.fireflies_records?(await importResearchArchive(input)):(await importDocuments(Array.isArray(input)?input:input.sources||[input]));
 console.log(JSON.stringify(result));
}catch(e){const code=databaseErrorCode(e);console.error(code?'Import failed ('+code+').':e.message);process.exitCode=1;}
