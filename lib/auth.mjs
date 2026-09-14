import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {createRemoteJWKSet,jwtVerify} from 'jose';
import {all,one,run,transaction,lockWorkspace} from './db.mjs';
import {googleClient,request,saveGoogleGrant,recordGmailIssue} from './connectors.mjs';

import {signInFailureCode} from './auth-messages.mjs';
export const APP_ORIGIN='http://127.0.0.1:3210';
export const CALLBACK=APP_ORIGIN+'/api/auth/google/callback';
export const SESSION_COOKIE='xin_session';
export const FLOW_COOKIE='xin_google_flow';
export const SESSION_SECONDS=12*60*60;
const flowSeconds=10*60;
// Authentication lives in a restricted schema and is never part of workspace exports.
const authSQL=sql=>sql.replace(/\b(owner|sessions|oauth_attempts|auth_events)\b/g,'focus_auth.$1');
export const authDb={prepare(sql){return{get:async (...args)=>(await one(authSQL(sql),...args)),all:async (...args)=>(await all(authSQL(sql),...args)),run:async (...args)=>(await run(authSQL(sql),...args))};},exec:async sql=>(await run(authSQL(sql))),close:async()=>{}};
const digest=value=>createHash('sha256').update(value).digest('hex');
const random=()=>randomBytes(32).toString('base64url');
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export const allowedEmail=()=>String(process.env.XIN_ALLOWED_EMAIL||'').trim().toLowerCase();
export function cookie(name,value,age){return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}`;}
export function readCookie(req,name){
 const matches=(req.headers.get('cookie')||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(name+'='));
 return matches.length===1?matches[0].slice(name.length+1):'';
}
export function checkLocalRequest(req,write=false){
 if(req.headers.get('host')!=='127.0.0.1:3210')throw Object.assign(Error('Open Focus at http://127.0.0.1:3210.'),{status:403});
 if(write&&(req.headers.get('origin')!==APP_ORIGIN||req.headers.get('x-xin-request')!=='1'))throw Object.assign(Error('Requests must come from this app.'),{status:403});
}
export async function sessionFor(token){
 if(!/^[A-Za-z0-9_-]{43}$/.test(token||''))return null;
 const row=(await authDb.prepare('SELECT o.sub,o.email,o.name,s.expires_at FROM sessions s JOIN owner o ON o.sub=s.sub WHERE s.token_hash=? AND s.expires_at>?').get(digest(token),Date.now()));
 return row&&row.email===allowedEmail()?row:null;
}
export async function requireSession(req){const user=(await sessionFor(readCookie(req,SESSION_COOKIE)));if(!user)throw Object.assign(Error('Sign in to open your workspace.'),{status:401});return user;}
export async function endSession(token){if(token)(await authDb.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token)));}
async function cleanExpired(){(await authDb.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now()));(await authDb.prepare('DELETE FROM oauth_attempts WHERE expires_at<=?').run(Date.now()));}
export async function beginGoogle(oldBrowser=''){
 if(!allowedEmail())throw Error('Set XIN_ALLOWED_EMAIL in .env.local and restart Focus before signing in.');
 const client=googleClient();if(!client)throw Error('Set up Google sign-in first.');
 (await cleanExpired());
 if(oldBrowser)(await authDb.prepare('DELETE FROM oauth_attempts WHERE browser_hash=?').run(digest(oldBrowser)));
 const state=random(),browser=random(),verifier=randomBytes(48).toString('base64url'),nonce=random();
 (await authDb.prepare('INSERT INTO oauth_attempts VALUES(?,?,?,?,?,?)').run(digest(state),digest(browser),verifier,nonce,client.client_id,Date.now()+flowSeconds*1000));
 const u=new URL('https://accounts.google.com/o/oauth2/v2/auth');
 for(const [k,v] of Object.entries({client_id:client.client_id,redirect_uri:CALLBACK,response_type:'code',scope:'openid email profile https://www.googleapis.com/auth/gmail.readonly',access_type:'offline',prompt:'select_account consent',include_granted_scopes:'true',state,nonce,login_hint:allowedEmail(),code_challenge:digestBase64(verifier),code_challenge_method:'S256'}))u.searchParams.set(k,v);
 return {url:u.href,cookie:cookie(FLOW_COOKIE,browser,flowSeconds)};
}
function digestBase64(value){return createHash('sha256').update(value).digest('base64url');}
const googleKeys=createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'),{timeoutDuration:10000});
export async function verifyGoogleIdentity(token,clientId,nonce,keys=googleKeys){
 const {payload:p}=await jwtVerify(token,keys,{issuer:['https://accounts.google.com','accounts.google.com'],audience:clientId,algorithms:['RS256'],requiredClaims:['sub','email','email_verified','nonce','iat','exp'],maxTokenAge:'10m',clockTolerance:5});
 if(!same(p.nonce,nonce)||p.email_verified!==true||typeof p.sub!=='string'||!p.sub||typeof p.email!=='string'||(p.azp&&p.azp!==clientId))throw Error('Google identity could not be verified.');
 if(p.email.toLowerCase()!==allowedEmail())throw Object.assign(Error('This Google account is not allowed to open this workspace.'),{authCode:'account'});
 const owner=(await authDb.prepare('SELECT * FROM owner WHERE id=1').get());
 if(owner&&owner.sub!==p.sub)throw Object.assign(Error('This Google identity does not own the workspace.'),{authCode:'account'});
 return {sub:p.sub,email:p.email.toLowerCase(),name:typeof p.name==='string'?p.name:'You'};
}
export async function recordAuthEvent(stage,outcome,code='',error={}){
 const reasons=['SERVICE_DISABLED','accessNotConfigured','ACCESS_TOKEN_SCOPE_INSUFFICIENT','invalid_client','invalid_grant','unauthorized_client','ERR_JWT_EXPIRED','ERR_JWT_CLAIM_VALIDATION_FAILED','ERR_JWS_SIGNATURE_VERIFICATION_FAILED','ERR_JWKS_NO_MATCHING_KEY','ERR_JWKS_TIMEOUT','ERR_JWS_INVALID','ERR_JWT_INVALID'];
 const reason=[error.providerReason,error.providerCode,error.code].find(x=>reasons.includes(x))||null;
 (await authDb.prepare('INSERT INTO auth_events(created_at,stage,outcome,code,http_status,provider_reason) VALUES(?,?,?,?,?,?)').run(new Date().toISOString(),stage,outcome,code,Number.isInteger(error.status)?error.status:null,reason));
 (await authDb.prepare('DELETE FROM auth_events WHERE id NOT IN (SELECT id FROM auth_events ORDER BY id DESC LIMIT 200)').run());
}
export async function finishGoogle(code,state,browser,keys=googleKeys){
 let stage='state';
 try{
 if(!state||!browser)throw Error('Google sign-in expired. Try again.');
 const pending=(await authDb.prepare('DELETE FROM oauth_attempts WHERE state_hash=? AND browser_hash=? AND expires_at>? RETURNING *').get(digest(state),digest(browser),Date.now()));
 if(!pending||pending.expires_at<=Date.now()||!same(pending.browser_hash,digest(browser)))throw Error('Google sign-in expired or belongs to another browser.');
 // Consume before the token exchange: a callback can never be replayed.

 const client=googleClient();if(!code||!client||client.client_id!==pending.client_id)throw Error('Google sign-in was cancelled or configuration changed.');
 (await recordAuthEvent(stage,'complete'));stage='token_exchange';
 const tokens=await request('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...client,code,code_verifier:pending.verifier,grant_type:'authorization_code',redirect_uri:CALLBACK})});
 (await recordAuthEvent(stage,'complete'));stage='identity';
 const identity=await verifyGoogleIdentity(tokens.id_token,client.client_id,pending.nonce,keys);
 (await recordAuthEvent(stage,'complete'));stage='gmail';
 let gmail=false,gmailIssue='';
 try{gmail=await saveGoogleGrant(tokens,identity);(await recordAuthEvent(stage,gmail?'complete':'not_granted'));}
 catch(error){if(error.authCode==='account')throw error;gmailIssue=recordGmailIssue(error);(await recordAuthEvent(stage,'warning',gmailIssue,error));}
 stage='session';
 const token=random();
 await transaction(async()=>{
 await lockWorkspace();
  const current=(await authDb.prepare('SELECT sub FROM owner WHERE id=1').get());if(current&&current.sub!==identity.sub)throw Error('Workspace owner changed during sign-in.');
  (await authDb.prepare('INSERT INTO owner VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name').run(identity.sub,identity.email,identity.name));
  (await authDb.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(digest(token),identity.sub,Date.now(),Date.now()+SESSION_SECONDS*1000));
 });
 (await recordAuthEvent(stage,'complete'));
 return {identity,gmail,token,gmailIssue};
 }catch(error){error.authCode=signInFailureCode(error,stage);(await recordAuthEvent(stage,'failed',error.authCode,error));throw error;}
}
