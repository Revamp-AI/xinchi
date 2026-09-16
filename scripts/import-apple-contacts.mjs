import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {importAppleContacts,normalizeAppleContacts} from '../lib/apple-contacts.mjs';
import {closeDatabase} from '../lib/postgres.mjs';

try{
 const args=process.argv.slice(2),path=args.find(a=>!a.startsWith('--'));
 if(!path||args.some(a=>a!==path&&a!=='--apply'))throw Error('Use: node scripts/import-apple-contacts.mjs /path/to/Contacts.abbu [--apply]');
 const records=normalizeAppleContacts(JSON.parse(execFileSync('python3',[fileURLToPath(new URL('./read-apple-contacts.py',import.meta.url)),path],{encoding:'utf8',maxBuffer:16*1024*1024})));
 const totals={apply:args.includes('--apply'),total:0,added:0,matched:0,unchanged:0,conflicts:0,skipped_owner:0};
 for(let i=0;i<records.length;i+=50){const result=await importAppleContacts(records.slice(i,i+50),{apply:totals.apply});for(const key of Object.keys(result))totals[key]+=result[key];if(totals.apply)console.log(JSON.stringify({processed:Math.min(i+50,records.length),...totals}));}
 console.log(JSON.stringify(totals,null,2));
}catch(error){console.error(error.code?'Apple contact import failed ('+error.code+').':error.message);process.exitCode=1;}
finally{await closeDatabase();}
