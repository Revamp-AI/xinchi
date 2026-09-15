const DAY=86400000;
const rank={overdue:0,due:1,checkback:2,review:3};
const utc=v=>/^\d{4}-\d{2}-\d{2}$/.test(v||'')?Date.UTC(+v.slice(0,4),+v.slice(5,7)-1,+v.slice(8,10)):NaN;
const days=(date,today)=>{const n=Math.round((utc(date)-utc(today))/DAY);return Number.isNaN(n)?null:n;};
const within=n=>n===0?'today':n===1?'in 1 day':'in '+n+' days';
const parse=v=>{if(v&&typeof v==='object')return v;try{return JSON.parse(v||'{}')||{};}catch{return{};}};
export function attention(item,today){
 if(!item||['done','dropped'].includes(item.status))return null;
 const hard=days(item.hard_deadline,today),cp=days(item.checkpoint,today);
 if(hard!==null&&hard<0)return{level:'overdue',label:'Hard deadline passed',days:hard,field:'hard_deadline'};
 if(hard!==null&&hard<=7)return{level:'due',label:'Hard deadline '+within(hard),days:hard,field:'hard_deadline'};
 if(cp===null)return null;
 if(item.status==='now'&&cp<0)return{level:'overdue',label:'Checkpoint passed',days:cp,field:'checkpoint'};
 if(item.status==='now'&&cp<=2)return{level:'due',label:'Checkpoint '+within(cp),days:cp,field:'checkpoint'};
 if(item.status==='waiting'&&cp<=0)return{level:'checkback',label:'Check back due',days:cp,field:'checkpoint'};
 if(item.status==='later'&&cp<=0)return{level:'review',label:'Review date reached',days:cp,field:'checkpoint'};
 return null;
}
export function sortByAttention(items,today){
 return items.map((item,index)=>({item,index,signal:attention(item,today)})).sort((a,b)=>{
  const ra=a.signal?rank[a.signal.level]:4,rb=b.signal?rank[b.signal.level]:4;
  if(ra!==rb)return ra-rb;
  if(a.signal&&b.signal&&a.signal.days!==b.signal.days)return a.signal.days-b.signal.days;
  return a.index-b.index;
 }).map(x=>x.item);
}
export function carryoverCount(events){
 return events.filter(e=>{if(e.action!=='updated')return false;const before=parse(e.before_json),after=parse(e.after_json);return !!before.checkpoint&&before.checkpoint!==after.checkpoint&&after.status==='now';}).length;
}
export function localToday(date=new Date(),timeZone){if(timeZone)return new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(date);const pad=n=>String(n).padStart(2,'0');return date.getFullYear()+'-'+pad(date.getMonth()+1)+'-'+pad(date.getDate());}
