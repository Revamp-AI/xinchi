import {readFileSync} from 'node:fs';
import {configureGoogleClient} from '../lib/connectors.mjs';
import {authDb} from '../lib/auth.mjs';
const path=process.argv[2];
if(!path){console.error('Usage: node scripts/configure-google.mjs /path/to/google-client.json');process.exit(1);}
try{
 configureGoogleClient(JSON.parse(readFileSync(path,'utf8')));
 (await authDb.exec('DELETE FROM sessions; DELETE FROM oauth_attempts;'));
 console.log('Google sign-in configured. Existing sessions were signed out. Open http://127.0.0.1:3210/login.');
}catch(e){console.error(e.message);process.exitCode=1;}
