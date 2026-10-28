import {greetingCandidates,validGreeting,deferGreeting} from '../proactive/greetings.mjs';
import {randomUUID} from 'node:crypto';
import {defaults,candidateDecision,hasExplicitReminders,explicitReminderPlan} from './domain.mjs';
import {projectReminders} from './scheduling.mjs';
import {proactiveCandidates,validProactive} from '../proactive/proactive.mjs';
import {generationCurrent,acceptCharacterLife} from '../proactive/character-life.mjs';
const day=86400000;
const valid=(s,c,now)=>c.category==='greeting'?validGreeting(s,c,now):c.category==='reminder'?s.plans[c.planId]?.status==='active'&&s.plans[c.planId]?.revision===c.revision:validProactive(s,c,now);
const eligible=(s,c,now)=>valid(s,c,now)&&candidateDecision(s,{...c,source:c.category==='reminder'?'confirmed-plan':c.source,confidence:c.category==='reminder'?1:c.confidence,expiresAt:c.expiresAt??c.at+day,fingerprint:c.fingerprint??c.id},now).allow;
function message(s,due){return due[0].category!=='reminder'?due[0].text:'到时间了，提醒你一下：\n'+due.map(c=>{const p=s.plans[c.planId],m=s.matters?.[p.matterId];return m?`• ${m.title}：${p.reminderText}${m.deadlineAt?'\n  截止：'+new Intl.DateTimeFormat('zh-CN',{timeZone:m.timezone,dateStyle:'medium',timeStyle:'short',hourCycle:'h23'}).format(new Date(m.deadlineAt)):''}${m.submitTo?'\n  提交到：'+m.submitTo:''}`:`• ${p.title}${p.location?'（'+p.location+'）':''}`}).join('\n');}
export function dispatchEligibility(s,c,now){return valid(s,c,now)?candidateDecision(s,{...c,source:c.category==='reminder'?'confirmed-plan':c.source,confidence:c.category==='reminder'?1:c.confidence,expiresAt:c.expiresAt??c.at+day,fingerprint:c.fingerprint??c.id},now):{allow:false,reason:'source_dependency_changed'};}
/** Same scheduler, store and lease ledger. validate is the final transport admission. */
export function schedulerTransition(current,action,params={},now=Date.now(),{proactiveTransportReady=true,availableCategories={}}={}){
 if(Object.keys(params).some(k=>!['attemptId','lease','outcome'].includes(k)))throw Error('Unknown scheduler fields');
 if(action==='claim'&&!current?.businessScheduler?.enabled&&!hasExplicitReminders(current))return {state:current??defaults(),result:{ready:false}};
 const s=structuredClone(current??defaults());s.businessScheduler??={enabled:false,attempts:{},lastDispatchAt:0};const scheduler=s.businessScheduler;
 for(const a of Object.values(scheduler.attempts))if(a.status==='sending'&&a.startedAt+120000<now){
  const unsentGreeting=!a.transportAdmittedAt&&a.ids.every(id=>s.candidates[id]?.category==='greeting');
  if(unsentGreeting&&a.ids.every(id=>generationCurrent(s,s.candidates[id],now)))continue;
  a.status=unsentGreeting?'cancelled':'unknown';a.finishedAt=now;
  for(const id of a.ids){const c=s.candidates[id];if(c?.status==='sending'){if(!unsentGreeting)c.status='unknown';else if(!deferGreeting(s,c,now,{reason:'generation_interrupted'})){c.status='cancelled';delete c.text;}}}
 }
 for(const a of Object.values(scheduler.attempts))if(a.status==='claimed'&&a.createdAt+60000<now){a.status='expired';for(const id of a.ids)if(s.candidates[id]?.status==='claimed')s.candidates[id].status='pending';}
 let result={ready:false};
 if(action==='claim'){
  if(Object.keys(scheduler.attempts).length>=1000)throw Error('Reminder attempt capacity reached; no send');
  if(!scheduler.lastCheckAt||now-scheduler.lastCheckAt>=60000)scheduler.lastCheckAt=now;
  for(const job of projectReminders(s,now-day,8*day).jobs)if(!s.candidates[job.id])s.candidates[job.id]={...job,category:'reminder',status:'pending',createdAt:now,deliveryMode:'business'};
  for(const c of [...greetingCandidates(s,now),...proactiveCandidates(s,[],now).candidates])if(!s.candidates[c.id])s.candidates[c.id]=c;
  for(const c of Object.values(s.candidates))if(c.status==='pending'&&(!valid(s,c,now)||(c.expiresAt??c.at+day)<=now||(c.category==='greeting'&&!c.generation))){c.status='cancelled';if(c.category==='memory'||c.category==='greeting')delete c.text;}
  if((scheduler.enabled||hasExplicitReminders(s))&&!Object.values(scheduler.attempts).some(a=>['claimed','sending'].includes(a.status))){
   const due=Object.values(s.candidates).filter(c=>c.category==='reminder'&&c.status==='pending'&&c.at<=now&&(now-scheduler.lastDispatchAt>=60000||explicitReminderPlan(s.plans[c.planId]))&&eligible(s,c,now)).sort((a,b)=>a.at-b.at).slice(0,10);
   if(!due.length&&now-scheduler.lastDispatchAt>=60000){const c=Object.values(s.candidates).filter(c=>c.category!=='reminder'&&availableCategories[c.category]!==false&&(proactiveTransportReady||c.category==='greeting')&&c.status==='pending'&&c.at<=now&&eligible(s,c,now)).sort((a,b)=>a.expiresAt-b.expiresAt)[0];if(c)due.push(c);}
  if(due.length){const attemptId=randomUUID(),lease=randomUUID();scheduler.attempts[attemptId]={id:attemptId,lease,ids:due.map(c=>c.id),status:'claimed',createdAt:now};for(const c of due)c.status='claimed';result={ready:true,attemptId,lease,needsGeneration:due.some(c=>c.category==='greeting'),requiresGuard:due.some(c=>['weather','interest','memory','greeting'].includes(c.category))};}
  }
 }else if(action==='begin'||action==='validate'){
  const a=scheduler.attempts[params.attemptId];if(!a||a.lease!==params.lease)throw Error('Unknown dispatch lease');
  if(action==='validate'&&a.transportAdmittedAt)return {state:s,result:{ready:false,reason:'transport_already_admitted'}};
  if(a.status==='cancelled'){if(JSON.stringify(s)!==JSON.stringify(current??defaults()))s.revision++;return {state:s,result:{ready:false,reason:'attempt_no_longer_sendable'}};}
  if(a.status!==(action==='begin'?'claimed':'sending'))throw Error('Unknown or consumed dispatch lease');
  const due=a.ids.map(id=>s.candidates[id]);
  const budgetState=structuredClone(s);if(action==='validate')for(const id of a.ids)delete budgetState.candidates[id];
  if((!scheduler.enabled&&!hasExplicitReminders(s))||(action==='begin'&&a.createdAt+60000<now)||due.some(c=>!c||availableCategories[c.category]===false||c.status!==(action==='begin'?'claimed':'sending')||!valid(s,c,now)||!eligible(budgetState,c,now)||(action==='validate'&&c.category==='greeting'&&!generationCurrent(s,c,now)))){a.status='cancelled';a.finishedAt=now;for(const c of due)if(c&&['claimed','sending'].includes(c.status)){if(c.category==='greeting'&&!a.transportAdmittedAt&&availableCategories[c.category]!==false&&deferGreeting(s,c,now,{reason:'context_changed'}))continue;c.status='cancelled';if(c.category==='memory'||c.category==='greeting')delete c.text;}result={ready:false,reason:'changed_or_expired'};}
  else{if(action==='begin'){a.status='sending';a.startedAt=now;scheduler.lastDispatchAt=now;for(const c of due){c.status='sending';c.deliveryAttemptAt=now;}}else a.transportAdmittedAt=now;const body=message(s,due);if(action==='validate'&&(typeof body!=='string'||!body))throw Error('Missing current message');result={ready:true,attemptId:a.id,needsGeneration:due.some(c=>c.category==='greeting'),requiresGuard:due.some(c=>['weather','interest','memory','greeting'].includes(c.category)),...(body?{message:body}:{})};}
 }else if(action==='abort'){
  const a=scheduler.attempts[params.attemptId];if(!a||a.lease!==params.lease||a.status!=='sending'||a.transportAdmittedAt)throw Error('Cannot abort admitted transport');
  a.status='cancelled';a.finishedAt=now;for(const id of a.ids){const c=s.candidates[id];if(c&&!deferGreeting(s,c,now,{retryAfterMinutes:60,reason:'transport_not_ready'})){c.status='cancelled';if(c.category==='memory'||c.category==='greeting')delete c.text;}}result={ready:false,reason:'transport_not_started'};
 }else if(action==='settle'){
  const a=scheduler.attempts[params.attemptId];if(!a||a.lease!==params.lease)throw Error('Unknown dispatch lease');
  if(!['accepted','unknown'].includes(params.outcome))throw Error('Unverified delivery outcome');
  if(a.status!=='sending'){if(a.status===params.outcome)return {state:s,result:{status:a.status}};throw Error('Dispatch already settled');}
  a.status=params.outcome;a.finishedAt=now;for(const id of a.ids){const c=s.candidates[id];c.status=params.outcome==='accepted'?'sent':'unknown';if(params.outcome==='accepted'){c.sentAt=now;acceptCharacterLife(s,c,now);}}
  if(params.outcome==='accepted'&&a.ids.some(id=>s.plans[s.candidates[id]?.planId]?.matterId)){
   const matterIds=a.ids.map(id=>s.plans[s.candidates[id]?.planId]?.matterId),unique=new Set(matterIds),m=unique.size===1?s.matters?.[matterIds[0]]:null;
   if(m?.status==='active')s.matterFocus={id:m.id,revision:m.revision,createdAt:now,expiresAt:now+3*3600000};else delete s.matterFocus;
  }
  result={status:a.status};
 }else throw Error('Unsupported scheduler action');
 if(Buffer.byteLength(JSON.stringify(s))>900000)throw Error('Reminder storage capacity reached; no send');
 if(JSON.stringify(s)!==JSON.stringify(current??defaults()))s.revision++;return {state:s,result};
}
export async function schedulerOperation(store,tenant,assertCurrent,action,params,now=Date.now(),options={}){
 for(let n=0;n<8;n++){assertCurrent();const observed=await store.observe(tenant.id);assertCurrent();const change=schedulerTransition(observed.value,action,params,now,options);if(JSON.stringify(change.state)===JSON.stringify(observed.value??defaults()))return change.result;assertCurrent();const result=await store.compareAndApply(tenant.id,observed.comparison,{operation:'update',action:'set',value:change.state});assertCurrent();if(result.status==='applied')return change.result;if(result.status!=='conflict')throw Error('Scheduler commit outcome unknown; do not send');}throw Error('Scheduler contention; no send');
}
