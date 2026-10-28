import {hour,nonSensitive,topicAllowed,consentKinds,invalidateFactCandidates,currentProactiveReference,sharedProactiveDecision,withinWindow,recentlyDiscussed} from '../proactive/proactive-policy.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {autoFactCommand,tombstoneFact,blockFactReplay} from '../memory/fact-memory.mjs';
import {knownFact} from '../memory/fact-rules.mjs';
import {applyMatterCommand} from '../matters/matters.mjs';
import {greetingTiming} from '../proactive/greetings.mjs';
export const identityId=(account,sender)=>'wx-'+createHash('sha256').update(JSON.stringify([account,sender])).digest('hex').slice(0,32);
const clone=x=>structuredClone(x);
const check=(condition,message)=>{if(!condition)throw Error(message)};
const redactFactReceipts=(s,id)=>{for(const receipt of Object.values(s.receipts))if(receipt.result?.fact?.id===id||receipt.result?.factDraft?.id===id)receipt.result={id,redacted:true};};
const text=(value,max=500)=>{check(typeof value==='string'&&value.trim()&&value.length<=max,'Invalid bounded text');return value.trim()};
export function resolveTenant(ctx,config){
 check(typeof ctx.assertInvocationCurrent==='function','Live invocation authority required');ctx.assertInvocationCurrent();
 const account=ctx.agentAccountId,sender=ctx.requesterSenderId;
 check(ctx.messageChannel==='openclaw-weixin'&&typeof account==='string'&&typeof sender==='string','Verified Weixin identity required');
 const id=identityId(account,sender);
 check(ctx.agentId===id&&ctx.sessionKey?.toLowerCase()===`agent:${id}:openclaw-weixin:${account}:direct:${sender}`.toLowerCase(),'Private agent/session binding required');
 check(config.bindings?.some(b=>b.agentId===id&&b.match?.channel==='openclaw-weixin'&&b.match.accountId===account&&b.match.peer?.kind==='direct'&&b.match.peer.id===sender),'Current tenant route revoked');
 return {id,account,sender,sessionKey:ctx.sessionKey};
}
export function defaults(){return {version:1,revision:0,plans:{},facts:{},factDrafts:{},factDeletionDrafts:{},factMemoryPaused:false,interactions:{},candidates:{},receipts:{},preferenceDrafts:{},preferences:{enabled:false,paused:true,categories:{reminder:false,weather:false,interest:false,greeting:false,memory:false},timezone:'Asia/Shanghai',quietStart:'00:00',quietEnd:'09:00',greetingLimit:3,cooldownMinutes:120,dailyGreetingEnabled:false,dailyGreetingTime:'18:30',city:null,weatherLocation:null,interests:[]},audit:[]}}
/** Fill disabled/empty fields of older records without enabling permission. */
export function completePreferences(value){const p=defaults().preferences;return {...p,...value,categories:{...p.categories,...value?.categories}};}
export const explicitReminderPlan=plan=>plan?.status==='active'&&plan.reminderConsent?.kind==='verified-weixin-business-ingress'&&plan.reminderConsent?.consent==='verified-chat-confirmation'&&typeof plan.reminderConsent.messageId==='string';
export const hasExplicitReminders=state=>Object.values(state?.plans??{}).some(explicitReminderPlan);
export function validTimezone(zone){check(typeof zone==='string','Explicit timezone required');try{new Intl.DateTimeFormat('en',{timeZone:zone}).format()}catch{throw Error('Unknown timezone')}return zone}
export function localParts(ms,zone){const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:validTimezone(zone),year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(ms).map(x=>[x.type,x.value]));return {date:`${p.year}-${p.month}-${p.day}`,time:`${p.hour}:${p.minute}`}}
export function validatePlan(input){
 const p=clone(input);p.timezone??='Asia/Shanghai';check(Object.keys(p).every(k=>['title','kind','timezone','dueAt','endAt','repeat','location','notes','outdoor','weatherCity'].includes(k)),'Unknown plan fields');
 p.title=text(p.title,160);check(['course','plan','reminder'].includes(p.kind),'Unknown plan kind');validTimezone(p.timezone);
 check(typeof p.dueAt==='string'&&/Z$|[+-]\d\d:\d\d$/.test(p.dueAt)&&Number.isFinite(Date.parse(p.dueAt)),'dueAt needs an explicit UTC offset');
 if(p.endAt)check(Date.parse(p.endAt)>Date.parse(p.dueAt),'End must follow start');
 if(p.repeat){check(Object.keys(p.repeat).every(k=>['frequency','interval','weekdays','weekParity','termStart','until'].includes(k)),'Unknown recurrence fields');check(['daily','weekly'].includes(p.repeat.frequency),'Recurrence must be daily or weekly');check(Number.isInteger(p.repeat.interval??1)&&(p.repeat.interval??1)>0&&(p.repeat.interval??1)<=52,'Invalid interval');
 if(p.repeat.weekdays)check(p.repeat.weekdays.length>0&&p.repeat.weekdays.every(n=>Number.isInteger(n)&&n>=1&&n<=7),'Invalid weekdays');
 if(p.repeat.weekParity){check(['all','odd','even'].includes(p.repeat.weekParity),'Invalid week parity');check(/^\d{4}-\d{2}-\d{2}$/.test(p.repeat.termStart??''),'Term start required for parity');}
 if(p.repeat.until)check(Number.isFinite(Date.parse(p.repeat.until)),'Invalid recurrence end');}
 if(p.outdoor!==undefined)check(typeof p.outdoor==='boolean','Invalid outdoor choice');if(p.weatherCity!==undefined)p.weatherCity=text(p.weatherCity,100);if(p.location)p.location=text(p.location,200);if(p.notes)p.notes=text(p.notes,2000);return p;
}
function validatePreferences(p){
 check(Object.keys(p).every(k=>['enabled','paused','categories','timezone','quietStart','quietEnd','greetingLimit','cooldownMinutes','city','weatherLocation','interests','dailyGreetingEnabled','dailyGreetingTime'].includes(k)),'Unknown preferences');
 check(typeof p.dailyGreetingEnabled==='boolean'&&/^(09|1\d|2[0-3]):[0-5]\d$/.test(p.dailyGreetingTime),'请选择北京时间 09:00–23:59 的日常问候时间');
 if(p.timezone!==null)validTimezone(p.timezone);
 check(typeof p.enabled==='boolean'&&typeof p.paused==='boolean','Invalid switches');
 check(Object.keys(p.categories).every(k=>['reminder','weather','interest','greeting','memory'].includes(k))&&Object.values(p.categories).every(v=>typeof v==='boolean'),'Invalid categories');
 for(const k of ['quietStart','quietEnd'])check(/^([01]\d|2[0-3]):[0-5]\d$/.test(p[k]),'Invalid quiet hours');
 check(Number.isInteger(p.greetingLimit)&&p.greetingLimit>=0&&p.greetingLimit<=5,'Greeting limit must be 0–5');
 check(Number.isInteger(p.cooldownMinutes)&&p.cooldownMinutes>=60&&p.cooldownMinutes<=10080,'Invalid cooldown');
 check(Array.isArray(p.interests)&&p.interests.length<=20&&p.interests.every(topicAllowed),'Invalid interests');
 if(p.weatherLocation!=null){const l=p.weatherLocation;check(Object.keys(l).every(k=>['city','latitude','longitude','source'].includes(k))&&l.city===p.city&&Number.isFinite(l.latitude)&&Math.abs(l.latitude)<=90&&Number.isFinite(l.longitude)&&Math.abs(l.longitude)<=180&&['user-selected','approved-geocode'].includes(l.source),'Explicit weather location required');}if(p.city!==null)text(p.city,100);if(p.enabled)check(p.timezone,'Timezone required before enabling');
}
/** One tenant record is a CAS transaction; no model-supplied tenant/recipient fields. */
export function transition(current,command,source,now){
 const s=clone(current??defaults());s.preferences=completePreferences(s.preferences);const c=clone(command);
 check(Object.keys(c).every(k=>['action','id','expectedRevision','requestId','value'].includes(k)),'Unknown command fields');
 const requestId=text(c.requestId,120);
 const fingerprint=JSON.stringify(c);
 if(s.receipts[requestId]){check(s.receipts[requestId].fingerprint===fingerprint,'Request ID reused with different content');return {state:s,result:s.receipts[requestId].result,duplicate:true};}
 check(Object.keys(s.receipts).length<2000,'Receipt capacity reached; refuse rather than forget idempotency');
 const action=c.action,id=c.id?text(c.id,100):null;let result;
 if(action.startsWith('matter.')){
  const applied=applyMatterCommand(s,c,source,now,{applyPlan(planCommand){
   const ownedSource={...source,matterMutation:true};
   Object.assign(s,transition(s,planCommand,ownedSource,now).state);
   if(['plan.create','plan.update'].includes(planCommand.action)){
    const plan=s.plans[planCommand.id];
    Object.assign(s,transition(s,{action:'plan.confirm',id:plan.id,expectedRevision:plan.revision,requestId:planCommand.requestId+':confirm'},
     {...ownedSource,confirmationNonce:plan.confirmationNonce,reminderConsent:true},now).state);
   }
  }});
  result={...applied.result,summary:applied.description};
 }
 else if(action==='plan.create'){check(id&&!s.plans[id],'Plan ID exists or missing');check(Object.keys(s.plans).length<500,'Plan capacity reached');s.plans[id]={...validatePlan(c.value),id,revision:1,status:'draft',createdAt:now,updatedAt:now,source,confirmationNonce:randomUUID(),confirmationExpiresAt:now+86400000};result={saved:false,draft:true,plan:s.plans[id],delivery:'shadow'};}
 else if(action==='plan.confirm'){
 const old=s.plans[id];check(old?.status==='draft','Unknown or non-draft plan');check(c.expectedRevision===old.revision,'Plan revision conflict');
 check(['verified-web-choice','verified-chat-confirmation'].includes(source.consent),'Explicit confirmation required');
 if(source.consent==='verified-chat-confirmation')check(old.confirmationExpiresAt>now&&old.confirmationNonce===source.confirmationNonce,'Confirmation nonce missing or expired');
 s.plans[id]={...old,status:'active',revision:old.revision+1,updatedAt:now};result={saved:true,plan:s.plans[id],delivery:'shadow'};
 }
 else if(['plan.update','plan.complete','plan.postpone','plan.cancel','plan.delete'].includes(action)){
 const old=s.plans[id];check(old,'Unknown plan');check(c.expectedRevision===old.revision,'Plan revision conflict');
 if(old.matterId)check(source.matterMutation===true,'这是事项关联的提醒，请修改原事项，准备步骤和提醒会一起更新。');
 if(action==='plan.delete')delete s.plans[id];else{const patch=action==='plan.update'?validatePlan({...Object.fromEntries(Object.entries(old).filter(([k])=>["title","kind","timezone","dueAt","endAt","repeat","location","notes","outdoor","weatherCity"].includes(k))),...c.value}):{};
 if(action==='plan.postpone'){
 check(typeof c.value?.dueAt==='string'&&/Z$|[+-]\d\d:\d\d$/.test(c.value.dueAt)&&Date.parse(c.value.dueAt)>now,'Future dueAt with explicit offset required');
 const delta=Date.parse(c.value.dueAt)-Date.parse(old.dueAt);patch.dueAt=c.value.dueAt;if(old.endAt)patch.endAt=new Date(Date.parse(old.endAt)+delta).toISOString();}
 if(action==='plan.update'){patch.status='draft';patch.confirmationNonce=randomUUID();patch.confirmationExpiresAt=now+86400000;}
 s.plans[id]={...old,...patch,lastChangeSource:source,revision:old.revision+1,updatedAt:now,status:action==='plan.complete'?'completed':action==='plan.cancel'?'cancelled':patch.status??old.status};}
 for(const candidate of Object.values(s.candidates))if(candidate.planId===id&&candidate.status==='pending')candidate.status='cancelled';result={saved:true,id,status:s.plans[id]?.status??'deleted'};
 }
 else if(action==='reminder.acknowledge'){
 check(source.consent==='verified-web-choice','Explicit web review required');
 const attempt=s.businessScheduler?.attempts?.[id];check(attempt?.status==='unknown','Unknown delivery result required');
 check(c.expectedRevision===s.revision,'Reminder state changed; reload');attempt.status='acknowledged';attempt.reviewedAt=now;
 for(const candidateId of attempt.ids)if(s.candidates[candidateId]?.status==='unknown')s.candidates[candidateId].status='unknown_acknowledged';
 result={saved:true,id,resent:false};
 }
 else if(action==='fact.propose'){
 check(!s.factMemoryPaused,'Fact intake paused');s.factDrafts??={};
 for(const [key,draft] of Object.entries(s.factDrafts))if(draft.expiresAt<=now){delete s.factDrafts[key];redactFactReceipts(s,key);}
 check(id&&(!s.factDrafts[id]||c.expectedRevision===s.factDrafts[id].revision),'Fact draft revision conflict');
 check(s.factDrafts[id]||Object.keys(s.factDrafts).length<20,'Fact draft capacity reached');
 check(c.value&&Object.keys(c.value).every(k=>k==='text'),'Unknown fact proposal fields');
 if(s.facts[id])check(s.factDrafts[id]?s.factDrafts[id].baseRevision===s.facts[id].revision:c.expectedRevision===s.facts[id].revision,'Fact revision conflict');
 const draft={id,text:text(c.value.text,2000),baseRevision:s.facts[id]?.revision??0,revision:(s.factDrafts[id]?.revision??0)+1,confirmationNonce:randomUUID(),createdAt:now,expiresAt:now+15*60000,source};
 s.factDrafts[id]=draft;result={saved:false,factDraft:draft,requiresExplicitConfirmation:true};
 }else if(action==='fact.confirm'){
 check(!s.factMemoryPaused,'Fact intake paused');const draft=s.factDrafts?.[id];
 check(draft&&draft.expiresAt>now&&draft.revision===c.expectedRevision&&draft.confirmationNonce===c.value?.nonce,'Fact confirmation missing, changed or expired');
 check(['verified-web-choice','verified-chat-confirmation'].includes(source.consent),'Explicit fact confirmation required');
 check((s.facts[id]?.revision??0)===draft.baseRevision,'Fact changed; propose again');
 check(s.facts[id]||Object.keys(s.facts).length<200,'Fact capacity reached');redactFactReceipts(s,id);
 s.facts[id]={id,text:draft.text,confidence:1,sourceKind:draft.baseRevision?'user-correction':'user-stated',source:{...source,proposedBy:draft.source},observedAt:now,revision:draft.baseRevision+1};
 delete s.factDrafts[id];result={saved:true,fact:s.facts[id]};
 }else if(action==='fact.discard'){
 check(['verified-web-choice','verified-chat-confirmation'].includes(source.consent),'Explicit user choice required');
 check(s.factDrafts?.[id]&&s.factDrafts[id].revision===c.expectedRevision,'Fact draft changed');delete s.factDrafts[id];redactFactReceipts(s,id);result={discarded:true,id};
 }
 else if(action==='fact.delete.prepare'){


 const old=s.facts[id];check(old,'Unknown fact');check(c.expectedRevision===old.revision,'Fact revision conflict');
 const nonce=randomUUID();s.factDeletionDrafts??={};s.factDeletionDrafts[id]={nonce,revision:old.revision,expiresAt:now+5*60000};result={confirmRequired:true,id,revision:old.revision,nonce,expiresAt:now+5*60000};
 }else if(action==='fact.delete.confirm'){
 const draft=s.factDeletionDrafts?.[id];check(draft&&draft.nonce===c.value?.nonce&&draft.expiresAt>now,'Deletion confirmation missing or expired');
 check(c.expectedRevision===s.facts[id]?.revision&&draft.revision===c.expectedRevision,'Fact revision conflict');check(source.consent==='verified-web-choice','Explicit user confirmation required');
 tombstoneFact(s,id,now);delete s.factDeletionDrafts[id];if(s.factDrafts)delete s.factDrafts[id];redactFactReceipts(s,id);result={deleted:true,id};
 }else if(action==='fact.pause'||action==='fact.resume'){check(source.consent==='verified-web-choice','Explicit web choice required');s.factMemoryPaused=action==='fact.pause';result={paused:s.factMemoryPaused};
 }else if(action==='fact.correct'){
 check(source.consent==='verified-web-choice','Explicit user correction required');const old=s.facts[id];check(old&&c.expectedRevision===old.revision,'Fact revision conflict');
 check(c.value&&Object.keys(c.value).every(k=>k==='text'),'Unknown correction fields');
 redactFactReceipts(s,id);if(s.factDrafts)delete s.factDrafts[id];
 s.facts[id]={...old,text:text(c.value.text,2000),sourceKind:'user-correction',confidence:1,source,sourceAt:now,sourceMessageId:source.messageId??null,sourceTime:new Date(now).toISOString(),observedAt:now,revision:old.revision+1};const known=knownFact(s.facts[id]);if(known)Object.assign(s.facts[id],{factKey:known.factKey,value:known.value,status:'active',automatic:false});else{blockFactReplay(s,old,now);delete s.facts[id].factKey;delete s.facts[id].value;s.facts[id].automatic=false;}delete s.factDeletionDrafts?.[id];result={saved:true,fact:s.facts[id]};
 }else if(action==='fact.set'){
 check(!s.factMemoryPaused,'Fact intake paused');
 check(id&&(s.facts[id]||Object.keys(s.facts).length<200),'Fact capacity or identity invalid');check(c.value&&Object.keys(c.value).every(k=>['text','confidence','sourceKind'].includes(k)),'Unknown fact fields');
 check(['user-stated','user-correction','inferred'].includes(c.value.sourceKind),'Fact source required');check(typeof c.value.confidence==='number'&&c.value.confidence>=0&&c.value.confidence<=1,'Confidence required');
 redactFactReceipts(s,id);if(s.factDrafts)delete s.factDrafts[id];
 s.facts[id]={id,text:text(c.value.text,2000),confidence:c.value.confidence,sourceKind:c.value.sourceKind,source,observedAt:now,revision:(s.facts[id]?.revision??0)+1};result={saved:true,fact:s.facts[id]};
 }else if(action==='fact.delete'){tombstoneFact(s,id,now);if(s.factDrafts)delete s.factDrafts[id];redactFactReceipts(s,id);result={deleted:true,id};}
 else if(['fact.auto.enable','fact.auto.disable','fact.auto.confirm'].includes(action)){result=autoFactCommand(s,c,source,now);}
 else if(action==='fact.followup.set'||action==='fact.followup.clear'){
 check(source.consent==='verified-web-choice','Explicit web choice required');const f=s.facts[id];check(f&&c.expectedRevision===f.revision,'Fact revision conflict');
 if(action==='fact.followup.set')check(!s.factMemoryPaused&&['user-stated','user-correction'].includes(f.sourceKind)&&f.confidence===1&&consentKinds.includes(f.source?.consent)&&nonSensitive(f.text),'Reviewed non-sensitive user fact required');
 invalidateFactCandidates(s,id);f.revision++;delete f.proactive;
 if(action==='fact.followup.set'){check(c.value&&Object.keys(c.value).every(k=>['label','at'].includes(k))&&topicAllowed(c.value.label),'Explicit non-sensitive followup label required');const at=Date.parse(c.value.at);check(typeof c.value.at==='string'&&/Z$|[+-]\d\d:\d\d$/.test(c.value.at)&&Number.isFinite(at)&&at>now-6*hour&&at<now+366*24*hour,'Followup date with offset required');f.proactive={label:c.value.label.trim(),at,expiresAt:at+6*hour,consent:'verified-web-choice'};}
 result={saved:true,fact:f};
 }else if(action==='proactive.city-question'){
 check(source.consent==='verified-chat-confirmation','Explicit chat weather request required');s.proactiveMeta??={};const ask=s.preferences.enabled&&!s.preferences.paused&&s.preferences.categories.weather&&!s.preferences.city&&!s.proactiveMeta.cityQuestionOfferedAt;if(ask)s.proactiveMeta.cityQuestionOfferedAt=now;result={question:ask?'天气关心需要按你所在的城市来。你想让我关注哪个城市？':null};
 }
 else if(action==='interaction.set'){check(id&&Object.keys(s.interactions).length<50,'Interaction capacity exceeded');check(c.value?.ttlMs>0&&c.value.ttlMs<=7*86400000,'TTL must be at most seven days');s.interactions[id]={text:text(c.value.text,500),expiresAt:now+c.value.ttlMs};result={saved:true,id};}
 else if(action==='interaction.reset'){s.interactions={};result={reset:true};}
 else if(action==='preferences.propose'){
 check(id,'Draft ID required');check(c.value&&typeof c.value==='object','Preferences required');
 const p={...s.preferences,...c.value,categories:{...s.preferences.categories,...c.value.categories}};if('city' in c.value&&c.value.city!==s.preferences.city&&!('weatherLocation' in c.value))p.weatherLocation=null;validatePreferences(p);
 s.preferenceDrafts??={};check(Object.keys(s.preferenceDrafts).length<20,'Too many pending settings drafts');
 s.preferenceDrafts[id]={id,value:p,baseRevision:s.revision,basePreferencesRevision:s.preferencesRevision??0,confirmationRevision:s.revision+1,createdAt:now,expiresAt:now+15*60000,confirmationNonce:randomUUID()};result={draft:true,id,preferences:p,confirmationNonce:s.preferenceDrafts[id].confirmationNonce,confirmationRevision:s.revision+1,requiresExplicitConfirmation:true,shadowOnly:true};
 }else if(action==='preferences.confirm'){
 const draft=s.preferenceDrafts?.[id];check(draft&&draft.expiresAt>now,'Settings draft missing or expired');
 check(c.expectedRevision===(draft.confirmationRevision??draft.baseRevision+1)&&draft.basePreferencesRevision===(s.preferencesRevision??0),'Settings changed; preview again');
 check(['verified-web-choice','verified-chat-confirmation'].includes(source.consent),'Explicit consent receipt required');
 if(source.consent==='verified-chat-confirmation')check(draft.confirmationNonce===source.confirmationNonce,'Confirmation nonce invalid');
 s.preferences=draft.value;delete s.preferenceDrafts[id];result={saved:true,preferences:s.preferences,shadowOnly:true};
 }else if(action==='preferences.pause'){
 s.preferences.paused=true;result={saved:true,preferences:s.preferences};
 }else if(action==='preferences.disable'){
 s.preferences.enabled=false;s.preferences.paused=true;result={saved:true,preferences:s.preferences};
 }else if(action==='preferences.set'){
 check(c.value&&typeof c.value==='object','Preferences required');const p={...s.preferences,...c.value,categories:{...s.preferences.categories,...c.value.categories}};if('city' in c.value&&c.value.city!==s.preferences.city&&!('weatherLocation' in c.value))p.weatherLocation=null;validatePreferences(p);
 check(source.consent==='verified-web-choice'||source.consent==='verified-chat-confirmation'||(!p.enabled&&p.paused),'Explicit consent receipt required');
 s.preferences=p;result={saved:true,preferences:p};
 }else throw Error('Unknown domain action');
 if(['plan.confirm','plan.postpone'].includes(action)&&source.kind==='verified-weixin-business-ingress'&&source.consent==='verified-chat-confirmation'&&source.reminderConsent===true&&s.plans[id]?.status==='active')s.plans[id].reminderConsent={kind:source.kind,consent:source.consent,messageId:source.messageId,at:now};
 for(const [k,v] of Object.entries(s.interactions))if(v&&typeof v==='object'&&v.expiresAt<=now)delete s.interactions[k];
 if(action.startsWith('fact.')&&!['fact.propose','fact.discard','fact.delete.prepare','fact.followup.set','fact.followup.clear'].includes(action)){invalidateFactCandidates(s,action==='fact.pause'?undefined:id);if(s.facts[id]&&action!=='fact.pause'&&action!=='fact.resume')delete s.facts[id].proactive;}
 if(action.startsWith('preferences.')&&!['preferences.propose'].includes(action)){s.preferencesRevision=(s.preferencesRevision??0)+1;s.businessScheduler??={enabled:false,attempts:{},lastDispatchAt:0};s.businessScheduler.enabled=Boolean(s.preferences.enabled&&!s.preferences.paused&&(s.preferences.dailyGreetingEnabled||Object.values(s.preferences.categories).some(Boolean)));}
 if(action.startsWith('preferences.')&&action!=='preferences.propose')for(const c of Object.values(s.candidates))if(c.category!=='reminder'&&['pending','claimed'].includes(c.status)){c.status='cancelled';delete c.text;}
 s.revision++;s.audit.push({at:now,action,id,source});s.audit=s.audit.slice(-200);
 s.receipts[requestId]={fingerprint,result};
 check(Buffer.byteLength(JSON.stringify(s))<900000,'Tenant record capacity reached');return {state:s,result};
}
export async function mutate(store,key,command,source,now=Date.now()){
 let observed=await store.observe(key);
 for(let i=0;i<8;i++){
  const next=transition(observed.value,command,source,now);if(next.duplicate)return next.result;
  const result=await store.compareAndApply(key,observed.comparison,{operation:'update',action:'set',value:next.state});
  if(result.status==='applied')return next.result;if(result.status!=='conflict')throw Error('Unexpected commit status');observed=result.current;
 }
 throw Error('Concurrent change; reload and retry with the same requestId');
}
export function candidateDecision(state,candidate,now){
 const plan=state.plans[candidate.planId];
 if(candidate.category==='reminder'&&explicitReminderPlan(plan)&&plan.revision===candidate.revision){
  if(candidate.source!=='confirmed-plan'||candidate.confidence!==1||!Number.isFinite(candidate.expiresAt)||candidate.expiresAt<=now)return {allow:false,reason:'unreliable_or_stale'};
  if(Object.values(state.candidates).some(c=>c.fingerprint===candidate.fingerprint&&['sending','unknown','sent','unknown_acknowledged'].includes(c.status)))return {allow:false,reason:'duplicate_or_unresolved'};
  return {allow:true,reason:'explicit_request'};
 }
 const p=state.preferences;
 if(!p.enabled||p.paused||!(candidate.source==='daily-greeting'?p.dailyGreetingEnabled===true:p.categories[candidate.category]))return {allow:false,reason:'disabled'};
 if(!p.timezone)return {allow:false,reason:'timezone_missing'};
 if(candidate.category==='weather'&&!p.city)return {allow:false,reason:'city_missing'};
 if(candidate.category==='interest'&&!p.interests.length)return {allow:false,reason:'interests_missing'};
 if(!withinWindow(now))return {allow:false,reason:'beijing_window'};
 const {time}=localParts(now,p.timezone);
 const quiet=p.quietStart===p.quietEnd?false:p.quietStart<p.quietEnd?time>=p.quietStart&&time<p.quietEnd:time>=p.quietStart||time<p.quietEnd;
 if(quiet)return {allow:false,reason:'quiet_hours'};
 if(typeof candidate.source!=='string'||!candidate.source.trim()||!Number.isFinite(candidate.confidence)||candidate.confidence<0.8||candidate.confidence>1||!Number.isFinite(candidate.expiresAt)||candidate.expiresAt<=now)return {allow:false,reason:'unreliable_or_stale'};
 if(['weather','interest','memory'].includes(candidate.category)&&!currentProactiveReference(state,candidate,now))return {allow:false,reason:'source_dependency_changed'};
 if(recentlyDiscussed(state,candidate,now))return {allow:false,reason:'recent_conversation_topic'};
 const all=Object.values(state.candidates);
 if(all.some(x=>x.fingerprint===candidate.fingerprint&&['sending','unknown'].includes(x.status)))return {allow:false,reason:'delivery_unresolved'};
 if(all.some(x=>x.fingerprint===candidate.fingerprint&&['sent','unknown_acknowledged'].includes(x.status)))return {allow:false,reason:'duplicate'};
 if(candidate.category!=='reminder'){const gate=sharedProactiveDecision(state,now);if(!gate.allow)return gate;}
 if(candidate.source==='daily-greeting'&&candidate.adaptive===true){const timing=greetingTiming(state,candidate,now);if(!timing.allow)return timing;}
 if(state.interactions.activeConversation?.expiresAt>now)return {allow:false,reason:'conversation_active'};
 return {allow:true,reason:'eligible_shadow'};
}
