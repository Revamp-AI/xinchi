const day=v=>String(v||'').slice(0,10);
const labels={candidate:'To decide',now:'Now',waiting:'Waiting',later:'Later',done:'Done',dropped:'Closed'};
const statusLabel=v=>labels[v]||v||'none';
export function buildUpdateDraft({items=[],events=[],since,today}){
 const shared=items.filter(i=>i.shared),byId=new Map(items.map(i=>[i.id,i]));
 const completed=shared.filter(i=>i.status==='done'&&day(i.updated_at)>=since).map(i=>({id:i.id,title:i.title,evidence:i.evidence,at:i.updated_at}));
 const changed=[];
 for(const e of events){
  const item=byId.get(e.item_id);
  if(day(e.created_at)<since||!e.before_json||!(item||e).shared)continue;
  const before=JSON.parse(e.before_json),after=JSON.parse(e.after_json);
  if(after.status==='done'&&before.status!=='done')continue;
  for(const [what,key] of [['status','status'],['checkpoint','checkpoint'],['scope','done_when']])if((before[key]||'')!==(after[key]||''))changed.push({id:e.id,title:item?.title||after.title,what,from:before[key]||'',to:after[key]||'',reason:e.reason||'',at:e.created_at});
 }
 const next=shared.filter(i=>i.status==='now').map(i=>({id:i.id,title:i.title,done_when:i.done_when,next_action:i.next_action,checkpoint:i.checkpoint,hard_deadline:i.hard_deadline}));
 const needs=[...shared.filter(i=>i.status==='waiting').map(i=>({id:i.id,title:i.title,dependency:i.dependency,checkpoint:i.checkpoint,last_action:i.last_action||''})),...shared.filter(i=>i.kind==='decision'&&['candidate','now'].includes(i.status)).map(i=>({id:i.id,title:i.title,next_action:i.next_action}))];
 return{since,today,completed,changed,next,needs};
}
const line=(...parts)=>'- '+parts.filter(Boolean).join(' — ');
const section=(title,rows)=>'## '+title+'\n'+(rows.length?rows.join('\n'):'Nothing to report.')+'\n';
function describe(c){
 if(c.what==='status')return `${statusLabel(c.from)} → ${statusLabel(c.to)}`;
 if(c.what==='checkpoint')return `checkpoint ${day(c.from)||'none'} → ${day(c.to)||'none'}`;
 return `scope: ${c.from||'none'} → ${c.to||'none'}`;
}
export function renderUpdateDraft(d){
 const completed=d.completed.map(c=>line(`${c.title} (${day(c.at)})`,c.evidence));
 const changed=d.changed.map(c=>line(`${c.title}: ${describe(c)} (${day(c.at)})`,c.reason));
 const next=d.next.map(n=>line(n.title,n.done_when&&`done when: ${n.done_when}`,n.next_action&&`next: ${n.next_action}`,n.checkpoint&&`checkpoint ${day(n.checkpoint)}`,n.hard_deadline&&`due ${day(n.hard_deadline)}`));
 const needs=d.needs.map(n=>'dependency' in n?line(n.title,`waiting on ${n.dependency||'a dependency'}`,n.checkpoint&&`check back ${day(n.checkpoint)}`,n.last_action&&`last action: ${n.last_action}`):line(n.title,'decision needed',n.next_action&&`next: ${n.next_action}`));
 return `Update ${day(d.today)} (changes since ${day(d.since)})\n\n`+[section('Completed',completed),section('Changed',changed),section('Next',next),section('Need from you',needs)].join('\n');
}
