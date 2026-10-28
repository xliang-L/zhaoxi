import {localParts,validTimezone} from './domain.mjs';
const dayMs=86400000;
const dateNumber=date=>Date.parse(date+'T00:00:00Z');
const addDays=(date,days)=>new Date(dateNumber(date)+days*dayMs).toISOString().slice(0,10);
/** Refuse ambiguous/nonexistent wall times instead of silently changing a user's reminder. */
export function wallTime(date,time,zone){
 validTimezone(zone);const nominal=Date.parse(date+'T'+time+':00Z');
 const offsets=new Set([-dayMs,0,dayMs].map(delta=>{
  const sample=nominal+delta,p=localParts(sample,zone);return Date.parse(p.date+'T'+p.time+':00Z')-sample;
 }));
 const matches=[...offsets].map(offset=>nominal-offset).filter(ms=>{const p=localParts(ms,zone);return p.date===date&&p.time===time});
 if(matches.length!==1)throw Error('Ambiguous or nonexistent local time requires explicit correction');return matches[0];
}
export function occurrences(plan,from,to){
 if(plan.status!=='active')return [];
 const first=Date.parse(plan.dueAt);if(!plan.repeat)return first>=from&&first<=to?[first]:[];
 if(new Date(first).getUTCSeconds()||new Date(first).getUTCMilliseconds())throw Error('Repeating plans require minute precision');
 if(to-from>32*dayMs)throw Error('Projection window is bounded to 32 days');
 const origin=localParts(first,plan.timezone),start=localParts(from,plan.timezone).date,end=localParts(to,plan.timezone).date;
 const r=plan.repeat,interval=r.interval??1,until=r.until?Date.parse(r.until):Infinity,result=[];
 for(let date=start;date<=end;date=addDays(date,1)){
  const days=Math.round((dateNumber(date)-dateNumber(origin.date))/dayMs);if(days<0)continue;
  const weekday=((new Date(dateNumber(date)).getUTCDay()+6)%7)+1;
  if(r.frequency==='daily'&&days%interval)continue;
  if(r.frequency==='weekly'){
   const originWeekday=((new Date(dateNumber(origin.date)).getUTCDay()+6)%7)+1;
   const weeks=Math.floor((days+originWeekday-1)/7);if(weeks%interval)continue;
   if(!(r.weekdays??[originWeekday]).includes(weekday))continue;
  }
  if(r.weekParity&&r.weekParity!=='all'){
   const week=Math.floor((dateNumber(date)-dateNumber(r.termStart))/dayMs/7)+1;
   if(week<1||(r.weekParity==='odd'?week%2===0:week%2===1))continue;
  }
  const at=wallTime(date,origin.time,plan.timezone);if(at>=from&&at<=to&&at<=until)result.push(at);
 }
 return result;
}
export function projectReminders(state,now,horizon=7*dayMs){
 const jobs=[],errors=[];
 for(const plan of Object.values(state.plans)){
  try{for(const at of occurrences(plan,now,now+horizon))jobs.push({id:`${plan.id}:${plan.revision}:${at}`,planId:plan.id,revision:plan.revision,at,title:plan.title});}
  catch(error){errors.push({planId:plan.id,code:'schedule_requires_correction',message:error.message})}
 }
 return {jobs,errors};
}
