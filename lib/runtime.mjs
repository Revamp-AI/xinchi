export function resolveAppOrigin(env=process.env){
 const value=env.XIN_APP_ORIGIN||(env.VERCEL_PROJECT_PRODUCTION_URL?'https://'+env.VERCEL_PROJECT_PRODUCTION_URL:'');
 if(!value&&env.VERCEL==='1')throw Error('Set XIN_APP_ORIGIN to the production HTTPS address.');
 const url=new URL(value||'http://127.0.0.1:3210');
 if(url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('XIN_APP_ORIGIN must be an origin without a path or credentials.');
 if(url.protocol!=='https:'&&url.origin!=='http://127.0.0.1:3210')throw Error('Hosted Focus requires HTTPS.');
 return url.origin;
}
export const APP_ORIGIN=resolveAppOrigin();
export const HOSTED=APP_ORIGIN.startsWith('https://');
export const SERVERLESS=process.env.VERCEL==='1';
export const CLOUD_JOBS=SERVERLESS||process.env.XIN_AGENT_MODE==='cloud';
export const REMOTE_WORKERS=CLOUD_JOBS;
export const POSTGRES_SECRETS=SERVERLESS||process.env.XIN_SECRET_STORAGE==='postgres';
