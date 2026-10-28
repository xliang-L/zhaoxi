import {createHash} from 'node:crypto';
import {beijingParts} from './proactive-policy.mjs';
const minute=60000,hour=60*minute,day=24*hour;
function dailyWindow(now){
 const {date}=beijingParts(now),at=Date.parse(`${date}T09:00:00+08:00`);
 return {date,at,expiresAt:at+15*hour};
}
const consumed=new Set(['sent','sending','unknown','unknown_acknowledged']);
export function dailyContacts(state,now,exceptId){
 const date=beijingParts(now).date;
 return Object.values(state.candidates).filter(c=>c.id!==exceptId&&c.category!=='reminder'&&consumed.has(c.status)&&Number.isFinite(c.deliveryAttemptAt??c.sentAt)&&(c.deliveryAttemptAt??c.sentAt)<=now&&beijingParts(c.deliveryAttemptAt??c.sentAt).date===date);
}
function hourParts(at,zone){const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(at).map(x=>[x.type,x.value]));return {date:`${p.year}-${p.month}-${p.day}`,hour:Number(p.hour)};}
export function activityPattern(state,now){
 const zone=state.preferences.timezone??'Asia/Shanghai',hours=Array(24).fill(0),days=new Set();
 for(const at of state.interactions.activityHours??[]){
  if(!Number.isSafeInteger(at)||at>now||at<now-14*day)continue;
  const p=hourParts(at,zone);days.add(p.date);hours[p.hour]+=1+(14-(now-at)/day)/14;
 }
 return {days:days.size,hours};
}
/** Timing metadata is a preference, never a deadline that discards the day. */
export function greetingTiming(state,candidate,now){
 if(candidate.deferUntil>now)return {allow:false,reason:'greeting_deferred',nextAt:candidate.deferUntil};
 const activity=state.interactions.lastVerifiedActivityAt;
 if(activity+30*minute>now)return {allow:false,reason:'recent_chat',nextAt:activity+30*minute};
 const learned=activityPattern(state,now),p=hourParts(now,state.preferences.timezone??'Asia/Shanghai');
 const used=dailyContacts(state,now,candidate.id),anchor=Math.max(dailyWindow(now).at,...used.map(c=>c.deliveryAttemptAt??c.sentAt));
 if(learned.days>=3){
  const score=learned.hours[p.hour]+learned.hours[(p.hour+23)%24]*0.5+learned.hours[(p.hour+1)%24]*0.5;
  if(!score&&now-anchor<4*hour)return {allow:false,reason:'preferred_active_hours',nextAt:anchor+4*hour};
 }else{
  const local=beijingParts(now).time,reference=state.preferences.dailyGreetingTime??'18:30';
  const toMinutes=x=>Number(x.slice(0,2))*60+Number(x.slice(3,5));
  if(Math.abs(toMinutes(local)-toMinutes(reference))>120&&now-activity<90*minute)return {allow:false,reason:'learning_activity_hours',nextAt:activity+90*minute};
 }
 return {allow:true,reason:learned.days>=3?'learned_active_hours':'flexible_contact_window'};
}
const verifiedActivity=(s,now)=>Number.isFinite(s.interactions.lastVerifiedActivityAt)&&s.interactions.lastVerifiedActivityAt>0&&s.interactions.lastVerifiedActivityAt<=now;
const verifiedCompletion=p=>p.status==='completed'&&['verified-web-choice','verified-chat-confirmation'].includes(p.lastChangeSource?.consent);
/** Daily opportunities stay pending while busy; completed-plan follow-ups stay distinct. */
export function greetingCandidates(state,now){
 if(!state.preferences.enabled||state.preferences.paused)return [];
 if(!verifiedActivity(state,now))return [];
 const result=[];
 if(state.preferences.dailyGreetingEnabled===true){
  const window=dailyWindow(now),slot=dailyContacts(state,now).length;
  if(slot<Math.min(5,state.preferences.greetingLimit)&&now>=window.at&&now<window.expiresAt){
   const fingerprint=`daily-greeting:${window.date}:adaptive:${slot}`;
   result.push({id:fingerprint+':'+(state.preferencesRevision??0),fingerprint,category:'greeting',source:'daily-greeting',confidence:1,
    ...window,adaptive:true,slot,createdAt:now,preferencesRevision:state.preferencesRevision??0,status:'pending',deliveryMode:'business',generation:{status:'needed'}});
  }
 }
 if(!state.preferences.categories.greeting)return result;
 for(const plan of Object.values(state.plans)){
  if(!verifiedCompletion(plan)||!Number.isFinite(plan.updatedAt)||now<plan.updatedAt+20*minute||now>=plan.updatedAt+120*minute)continue;
  const fingerprint=createHash('sha256').update(JSON.stringify(['completed-plan',plan.id,plan.revision])).digest('hex');
  const id='greeting:'+fingerprint;
  result.push({id,fingerprint,planId:plan.id,revision:plan.revision,category:'greeting',at:plan.updatedAt+20*minute,source:'explicit-plan-completion',confidence:1,generation:{status:'needed'},createdAt:now,expiresAt:plan.updatedAt+120*minute,status:'pending',deliveryMode:'business'});
 }
 return result;
}
export function validGreeting(state,candidate,now){
 if(candidate.source==='daily-greeting'){
  const window=dailyWindow(now);
  return candidate.adaptive===true&&state.preferences.dailyGreetingEnabled===true&&verifiedActivity(state,now)&&candidate.preferencesRevision===(state.preferencesRevision??0)&&candidate.date===window.date&&candidate.slot===dailyContacts(state,now,candidate.id).length&&candidate.at===window.at&&now>=window.at&&now<window.expiresAt;
 }
 const p=state.plans[candidate.planId];
 return Boolean(p&&verifiedCompletion(p)&&p.revision===candidate.revision&&candidate.source==='explicit-plan-completion'&&candidate.expiresAt>now&&now>=p.updatedAt+20*minute&&now<p.updatedAt+120*minute&&verifiedActivity(state,now));
}
/** Only an attempt known not to have entered transport may be deferred and regenerated. */
export function deferGreeting(state,candidate,now,{retryAfterMinutes=30,reason='context_changed'}={}){
 if(candidate?.source!=='daily-greeting'||candidate.adaptive!==true||!state.preferences.enabled||state.preferences.paused||!validGreeting(state,candidate,now))return false;
 candidate.status='pending';candidate.deferUntil=now+Math.max(30,Math.min(240,retryAfterMinutes))*minute;
 candidate.generation={status:'needed',deferredReason:reason};delete candidate.text;delete candidate.deliveryAttemptAt;
 return true;
}
/** Only authenticated channel timing metadata enters this record; no message body is stored. */
export function activityTransition(current,phase,eventHash,now){
 const s=structuredClone(current);
 if(!['start','end'].includes(phase)||!/^([a-f0-9]{64})$/.test(eventHash))throw Error('Verified activity metadata required');
 const old=s.interactions.activeConversation;
 if(phase==='start'){
  if(old?.eventHash===eventHash)return {state:s,result:{recorded:true,duplicate:true}};
  s.interactions.activeConversation={eventHash,startedAt:now,expiresAt:now+60*minute};
 }else{
  if(old?.eventHash!==eventHash||old.endedAt)return {state:s,result:{recorded:false}};
  s.interactions.activeConversation={...old,endedAt:now,expiresAt:now+15*minute};
 }
 if(phase==='start'&&s.preferences.dailyGreetingEnabled&&s.preferences.enabled&&!s.preferences.paused){
  const bucket=Math.floor(now/hour)*hour;
  s.interactions.activityHours=[...new Set([...(s.interactions.activityHours??[]).filter(at=>Number.isSafeInteger(at)&&at>=now-14*day&&at<=now),bucket])].sort((a,b)=>a-b).slice(-336);
 }
 s.interactions.lastVerifiedActivityAt=now;s.revision++;return {state:s,result:{recorded:true}};
}
