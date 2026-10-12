import {repairBeeperContactNames} from '../lib/beeper-contact-repair.mjs';
import {closeDatabase,databaseErrorCode} from '../lib/postgres.ts';

try{
 if(process.argv.slice(2).some(a=>a!=='--apply'))throw Error('Use --apply to save the repair, or omit it for a dry run.');
 const {changes,...summary}=await repairBeeperContactNames({apply:process.argv.includes('--apply')});
 console.log(JSON.stringify(summary,null,2));
}catch(e){const code=databaseErrorCode(e);console.error(code?'Beeper contact repair failed ('+code+').':e.message);process.exitCode=1;}
finally{await closeDatabase();}
