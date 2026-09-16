import {lookup} from 'node:dns/promises';
import {request} from 'node:https';
import {isIP} from 'node:net';
import {personalEmail} from './contact-email.mjs';

// Deliberately conservative: subdomains, lookalike spellings and unknown
// multi-label suffixes remain reviewable instead of becoming identity proof.
const publicMail=new Set('gmail.com googlemail.com outlook.com hotmail.com live.com msn.com yahoo.com ymail.com aol.com icloud.com me.com mac.com proton.me protonmail.com pm.me fastmail.com hey.com mail.com gmx.com gmx.de qq.com 163.com 126.com yandex.com tutanota.com tuta.com zoho.com example.com example.org example.net'.split(' '));
const multiSuffix=new Set('co.uk org.uk com.au co.nz com.sg co.in co.jp co.za com.br com.hk com.cn co.kr com.tw'.split(' '));
export const companyKey=value=>String(value||'').normalize('NFKC').toLowerCase().trim().replace(/\.(com|ai|io|co|dev|app)$/,'').replace(/(?:[,\s]+(?:incorporated|corporation|limited|inc|corp|ltd|llc|llp|pte|plc)\.?)+$/g,'').replace(/[^a-z0-9]/g,'');
export function corporateDomain(address){
 const email=personalEmail(address),domain=email.split('@')[1]||'';
 if(publicMail.has(domain)||!domain||domain.includes('xn--')||!/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}$/.test(domain))return '';
 const parts=domain.split('.');
 return parts.length===2||parts.length===3&&multiSuffix.has(parts.slice(1).join('.'))?domain:'';
}
export function plausibleEmployerDomain(company,domain){
 const key=companyKey(company);
 return key.length>=4&&corporateDomain('person@'+domain)===domain&&domain.split('.')[0]===key;
}
export function publicIPv4(address){
 if(isIP(address)!==4)return false;
 const [a,b,c]=address.split('.').map(Number);
 return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
}
export function employerWebsiteUrl(value,domain){
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.port||![domain,'www.'+domain].includes(url.hostname))throw Error('Employer website changed domain; manual review is needed.');
 return url;
}
async function downloadPage(url,signal){
 const addresses=await Promise.race([
  lookup(url.hostname,{all:true,family:4}),
  new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('Employer website timed out.')),{once:true})),
 ]);
 signal.throwIfAborted();
 if(!addresses.length||addresses.some(a=>!publicIPv4(a.address)))throw Error('Employer website does not resolve to a public address.');
 // Pin the checked addresses to the TLS request, preventing DNS rebinding.
 return new Promise((resolve,reject)=>{
  const req=request(url,{method:'GET',agent:false,signal,headers:{'User-Agent':'FocusContactMatcher/1.0','Accept':'text/html','Accept-Encoding':'identity'},lookup:(_host,options,callback)=>options.all?callback(null,addresses):callback(null,addresses[0].address,4)},res=>{
   const status=res.statusCode||0;
   if(status>=300&&status<400){res.destroy();resolve({redirect:res.headers.location});return;}
   if(status!==200||!String(res.headers['content-type']||'').includes('text/html')||res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'){res.destroy();reject(Error('Employer website could not be read.'));return;}
   let size=0;const chunks=[];
   res.on('data',chunk=>{const remaining=1024*1024-size;chunks.push(chunk.subarray(0,remaining));size+=Math.min(chunk.length,remaining);if(size>=1024*1024){resolve({html:Buffer.concat(chunks).toString('utf8')});res.destroy();}});
   res.on('error',reject);res.on('end',()=>resolve({html:Buffer.concat(chunks).toString('utf8')}));
  });req.on('error',reject);req.end();
 });
}
export async function fetchEmployerWebsite(domain){
 const signal=AbortSignal.timeout(8000);let url=employerWebsiteUrl('https://'+domain+'/',domain);
 for(let n=0;n<4;n++){
  const result=await downloadPage(url,signal);
  if(result.html!==undefined)return{html:result.html,url:url.href};
  if(!result.redirect)throw Error('Employer website redirect is unavailable.');
  url=employerWebsiteUrl(new URL(result.redirect,url).href,domain);
 }
 throw Error('Employer website redirected too many times.');
}
const decode=value=>String(value||'').replace(/&(?:amp|quot|apos|lt|gt|nbsp);|&#(?:x[0-9a-f]+|\d+);/gi,s=>{
 if(s.startsWith('&#')){const n=s[2].toLowerCase()==='x'?parseInt(s.slice(3,-1),16):Number(s.slice(2,-1));return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';}
 return {'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>','&nbsp;':' '}[s.toLowerCase()]||s;
});
export function websiteCompanyEvidence(company,domain,page){
 if(!plausibleEmployerDomain(company,domain))return null;
 const url=employerWebsiteUrl(page.url,domain).href,key=companyKey(company),html=String(page.html||'').slice(0,1024*1024);
 const labels=[];
 for(const tag of html.match(/<meta\s[^>]*>/gi)||[]){
  const attributes=Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map(m=>[m[1].toLowerCase(),decode(m[2]??m[3]??m[4])]));
  if(['og:site_name','application-name'].includes((attributes.property||attributes.name||'').toLowerCase()))labels.push(attributes.content||'');
 }
 for(const script of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
  try{const walk=(v,depth=0)=>{if(depth>5||!v||typeof v!=='object')return;if(Array.isArray(v)){v.slice(0,100).forEach(x=>walk(x,depth+1));return;}if(['Organization','Corporation','WebSite'].includes(v['@type']))labels.push(v.name,v.legalName);if(v['@graph'])walk(v['@graph'],depth+1);};walk(JSON.parse(script[1]));}catch{}
 }
 // A full branded title segment is acceptable; an employer mentioned in prose
 // or a substring in a marketing headline is not sufficient.
 const title=decode(html.match(/<title\b[^>]*>([^<]*)<\/title>/i)?.[1]||'');
 labels.push(...title.split(/\s*[|:–—]\s*|\s+-\s+/));
 const label=labels.find(v=>typeof v==='string'&&companyKey(v)===key);
 return label?{company,domain,url,label:label.slice(0,200),method:'employer-website',verified_at:new Date().toISOString()}:null;
}
export async function verifyEmployerDomain(company,domain){
 if(!plausibleEmployerDomain(company,domain))return null;
 return websiteCompanyEvidence(company,domain,await fetchEmployerWebsite(domain));
}
