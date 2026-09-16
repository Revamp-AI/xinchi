export const SEGMENTS=['New','Active','Cooling','Dormant','Paused','Unclassified'];
export const RULE_VERSION=3;
const day=86400000;
// Only verified inbound replies or attended meetings can renew warmth. Outbound notes stay on the timeline.
export function relationshipState(contact,interactions,{now=new Date(),coverage={fresh:false,reason:'Coverage has not been verified.'}}={}){
 const time=+new Date(now),eligible=interactions.filter(i=>i.qualified&&!i.exclusion&&!i.duplicate_of&&i.duplicate_status!=='review'&&i.occurred_at&&+new Date(i.occurred_at)<=time);
 const renewing=eligible.filter(i=>i.kind==='meeting'||i.direction==='inbound'||(i.kind==='note'&&i.direction==='mutual'));
 const latest=renewing.reduce((m,i)=>Math.max(m,+new Date(i.occurred_at)),0);
 const first=eligible.reduce((m,i)=>Math.min(m,+new Date(i.occurred_at)),Infinity);
 const outbound=eligible.some(i=>i.direction==='outbound');
 const reciprocal=eligible.some(i=>i.kind==='meeting'||i.direction==='mutual')||(outbound&&eligible.some(i=>i.direction==='inbound'));
 const age=latest?(time-latest)/day:null;
 const basis={last_meaningful_at:latest?new Date(latest).toISOString():null,age_days:age===null?null:Math.floor(age),cadence_days:contact.cadence_days,coverage,estimated:!!latest&&age>contact.cadence_days&&!coverage.fresh,reciprocal,rule_version:RULE_VERSION};
 const result=(state,reason)=>({state,basis:{...basis,reason}});
 if(contact.paused||contact.do_not_contact||(contact.snoozed_until&&new Date(contact.snoozed_until+'T23:59:59Z')>now))return result('Paused',contact.do_not_contact?'Do not contact is enabled.':'Relationship reminders are paused.');
 // Identity review and follow-up tracking are independent of recorded activity.
 if(!eligible.length)return result('Unclassified','No verified meaningful interaction is available.');
 if(!reciprocal&&time-first<=14*day)return result('New','First verified interaction within 14 days; no reciprocal exchange yet.');
 if(!latest)return result('Unclassified','Outbound outreach alone does not establish relationship warmth.');
 if(age<=contact.cadence_days)return result('Active','A meaningful exchange is within the chosen cadence.');
 const caveat=coverage.fresh?'':' This is an estimate from recorded activity; other conversations may be missing.';
 if(age<=3*contact.cadence_days)return result('Cooling','The last recorded meaningful exchange is beyond the chosen cadence.'+caveat);
 return result('Dormant','The last recorded meaningful exchange is beyond three cadence periods.'+caveat);
}
