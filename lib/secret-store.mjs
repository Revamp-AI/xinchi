import {readFileSync,writeFileSync,existsSync,renameSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {dataDir,one,run,transaction} from './db.mjs';
import {POSTGRES_SECRETS} from './runtime.mjs';
const secretPath=resolve(dataDir,'connections.secret.json');
const aad=Buffer.from('focus-provider-secrets:v1');
export function localSecrets(){return existsSync(secretPath)?JSON.parse(readFileSync(secretPath,'utf8')):{};}
export function saveLocalSecrets(value){const tmp=secretPath+'.tmp';writeFileSync(tmp,JSON.stringify(value),{mode:0o600});renameSync(tmp,secretPath);}
function key(){const value=Buffer.from(process.env.XIN_SECRETS_KEY||'','base64url');if(value.length!==32)throw Error('Configure the private credential encryption key.');return value;}
export function encryptSecrets(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(),iv);cipher.setAAD(aad);const data=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return{v:1,iv:iv.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),data:data.toString('base64url')};}
export function decryptSecrets(value){if(value.v!==1)throw Error('Unknown credential storage version.');const decipher=createDecipheriv('aes-256-gcm',key(),Buffer.from(value.iv,'base64url'));decipher.setAAD(aad);decipher.setAuthTag(Buffer.from(value.tag,'base64url'));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data,'base64url')),decipher.final()]).toString('utf8'));}
export async function secrets(){if(!POSTGRES_SECRETS)return localSecrets();key();const row=await one('SELECT payload FROM focus_auth.provider_secrets WHERE id=1');return row?decryptSecrets(row.payload):{};}
export async function updateSecrets(update){
 if(!POSTGRES_SECRETS){const current=localSecrets();const result=update(current);saveLocalSecrets(current);return result;}
 return transaction(async()=>{await one("SELECT pg_advisory_xact_lock(hashtext('focus-provider-secrets'))");const current=await secrets(),result=update(current);await run('INSERT INTO focus_auth.provider_secrets(id,payload) VALUES(1,?::jsonb) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=now()',JSON.stringify(encryptSecrets(current)));return result;});
}
export async function saveSecrets(value){return updateSecrets(current=>{for(const k of Object.keys(current))delete current[k];Object.assign(current,value);});}
