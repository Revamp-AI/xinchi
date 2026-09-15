import {reconcileEmailContacts} from '../lib/contact-identity.mjs';
import {closeDatabase} from '../lib/postgres.mjs';

try{
 if(process.argv.slice(2).some(arg=>arg!=='--apply'))throw Error('Use --apply to reconcile contacts, or omit it for a dry run.');
 const {affected,...result}=await reconcileEmailContacts({apply:process.argv.includes('--apply')});
 console.log(JSON.stringify(result,null,2));
}catch(error){console.error(error.code?'Contact reconciliation failed ('+error.code+').':error.message);process.exitCode=1;}
finally{await closeDatabase();}
