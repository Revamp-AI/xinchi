'use client';
import {useState,useEffect} from 'react';
import {LockKeyhole,Mail,ArrowRight,AlertCircle} from 'lucide-react';
const callback='http://127.0.0.1:3210/api/auth/google/callback';
import {authMessages as messages} from '../../lib/auth-messages.mjs';
async function post(path,data){const r=await fetch('/api/auth/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Xin-Request':'1'},body:JSON.stringify(data)});const body=await r.json();if(!r.ok)throw Error(body.error||'Could not continue. Try again.');return body;}
export default function Login({configured,ownerConfigured}){
 const [ready,setReady]=useState(configured),[client,setClient]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{const q=new URLSearchParams(location.search);setError(messages[q.get('error')]||'');if(q.has('error'))history.replaceState(null,'','/login');},[]);
 async function signIn(){setBusy(true);setError('');try{if(!ready){await post('setup',client);setReady(true);}const flow=await post('google/start',{});window.location.assign(flow.url);}catch(e){setError(e.message);setBusy(false);}}
 return <main className="login-shell"><section className="login-card">
  <div className="login-brand"><span className="mark">f</span><strong>focus.</strong><span className="login-private"><LockKeyhole size={14}/>Private workspace</span></div>
  <h1>Sign in to Focus</h1>
  <p className="login-intro">Use your Google account to open your workspace and connect Gmail.</p>
  <div className="login-permission"><Mail size={22}/><div><strong>Gmail, included</strong><p>Allow read-only access to bring your email into context. The first import starts after sign-in.</p></div></div>
  {!ownerConfigured&&<div className="login-error" role="alert"><span>Set the workspace owner in <code>XIN_ALLOWED_EMAIL</code> in your local <code>.env.local</code> file, then restart Focus. See the setup guide in the repository.</span></div>}
  {!ready&&<details className="google-setup" open><summary>One-time Google setup</summary><p>Create a Google OAuth client for a <strong>Web application</strong> with the Gmail API enabled. Add this authorized redirect URI:</p><code>{callback}</code><p>Set the consent screen audience to your Workspace organization, or add your account as a test user.</p><a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Open Google Cloud setup <ArrowRight size={14}/></a><label>Upload the downloaded client JSON<input type="file" accept=".json,application/json" onChange={async e=>{setError('');setClient(null);try{const file=e.target.files?.[0];if(!file)return;if(file.size>32768)throw Error('Choose the small OAuth client JSON downloaded from Google Cloud.');setClient(JSON.parse(await file.text()));}catch{setError('Choose a valid Google OAuth client JSON file.');}}}/></label><p className="small muted">This configuration is stored only on this Mac. You only need to do this once.</p></details>}
  {error&&<div className="login-error" role="alert"><AlertCircle size={19}/><span>{error}</span></div>}
  <button className="google-signin" disabled={busy||!ownerConfigured||!ready&&!client} onClick={signIn}><span aria-hidden="true" className="google-letter">G</span>{busy?'Opening Google…':'Continue with Google'}</button>
  <p className="login-footnote">Your archive stays on this Mac. Google confirms your identity; Gmail permission lets Focus read your mail. You can decline Gmail access and still sign in.</p>
 </section></main>;
}
