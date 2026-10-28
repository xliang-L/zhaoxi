import {defaults,candidateDecision} from '../core/domain.mjs';
import {observationCandidate} from './candidates.mjs';
import {fingerprint,currentProactiveReference,sharedProactiveDecision,withinWindow,nonSensitive,consentKinds,hour} from './proactive-policy.mjs';
export const validProactive=(s,c,now)=>currentProactiveReference(s,c,now);
export function proactiveCandidates(s,observations,now){
 const candidates=[],status=[];
 for(const o of observations.slice(0,21)){
  const r=observationCandidate(s,o,now);status.push({category:o?.category??'unknown',reason:r.candidate?r.decision.reason:r.reason});if(r.candidate&&r.decision.allow)candidates.push(r.candidate);
 }
 if(s.preferences.categories.memory&&!s.factMemoryPaused)for(const f of Object.values(s.facts)){
  if(!['user-stated','user-correction'].includes(f.sourceKind)||f.confidence!==1||!consentKinds.includes(f.source?.consent)||!nonSensitive(f.text)||!nonSensitive(f.proactive?.label)||f.proactive?.consent!=='verified-web-choice'||f.proactive.at>now||f.proactive.expiresAt<=now)continue;
  const fp=fingerprint('memory-occasion',f.id,f.proactive.at);
  const c={id:'proactive:'+fingerprint(fp,f.revision,s.preferencesRevision??0),category:'memory',at:f.proactive.at,createdAt:now,expiresAt:f.proactive.expiresAt,source:'explicitly-reviewed-fact-followup',confidence:1,fingerprint:fp,preferencesRevision:s.preferencesRevision??0,factRef:{id:f.id,revision:f.revision},status:'pending',deliveryMode:'business',text:`今天到了你给「${f.proactive.label}」留的时间。先把这个小记号递过来，有新进展时聊两句也行。`};
  const d=candidateDecision(s,c,now);status.push({category:'memory',reason:d.reason});if(d.allow)candidates.push(c);
 }
 return {candidates,status};
}
/** Adapters are trusted code dependencies; they are never accepted in RPC parameters. */
export async function refreshProactive(store,tenant,assertCurrent,{adapters={},deliveryReady=false,now=Date.now()}={}){
 assertCurrent();const before=await store.observe(tenant.id);assertCurrent();const initial=before.value??defaults();
 if(initial.proactiveStatus?.lastRefreshAt+15*60000>now&&initial.proactiveStatus.preferencesRevision===(initial.preferencesRevision??0))return {refreshed:false,reason:'refresh_cooldown'};
 const p=initial.preferences,observations=[],sources={};let nextInterestIndex=initial.proactiveStatus?.preferencesRevision===(initial.preferencesRevision??0)?initial.proactiveStatus?.nextInterestIndex??0:0;
 const assertSourcesCurrent=async()=>{
  assertCurrent();const current=(await store.observe(tenant.id)).value??defaults();assertCurrent();
  if((current.preferencesRevision??0)!==(initial.preferencesRevision??0)||!current.preferences.enabled||current.preferences.paused||!sharedProactiveDecision(current,now).allow){const error=Error('Proactive source permission changed');error.code='PROACTIVE_CONTEXT_CHANGED';throw error;}
 };
 const sourceFailure=error=>error?.code==='PROACTIVE_CONTEXT_CHANGED'?'settings_changed':'provider_error';
 const allowed=p.enabled&&!p.paused&&withinWindow(now)&&sharedProactiveDecision(initial,now).allow;
 if(allowed){
  if(p.categories.weather){
   if(!p.city||p.weatherLocation?.city!==p.city)sources.weather='needs_explicit_city';
   else if(typeof adapters.weather!=='function')sources.weather='approved_transport_unavailable';
   else{try{await assertSourcesCurrent();const r=await adapters.weather({preferences:structuredClone(p),plans:structuredClone(initial.plans),now,context:{assertCurrent,revalidate:assertSourcesCurrent}});sources.weather=r?.status??'no_evidence';if(r?.observation)observations.push(r.observation);}catch(error){sources.weather=sourceFailure(error);}assertCurrent();}
  }
  if(p.categories.interest){
   if(!p.interests.length)sources.interest='needs_explicit_interest';
   else if(typeof adapters.interest!=='function')sources.interest='approved_transport_unavailable';
   else{sources.interest='no_fresh_verified_item';for(const topic of [p.interests[nextInterestIndex%p.interests.length]]){nextInterestIndex=(nextInterestIndex+1)%p.interests.length;try{await assertSourcesCurrent();const r=await adapters.interest({topic,now,context:{assertCurrent,revalidate:assertSourcesCurrent}});sources.interest=r?.status??'no_evidence';if(r?.observation)observations.push(r.observation);}catch(error){sources.interest=sourceFailure(error);}assertCurrent();}}
  }
 }else sources.dispatch=p.enabled&&!p.paused?sharedProactiveDecision(initial,now).reason:'disabled';
 for(let n=0;n<8;n++){
  assertCurrent();const observed=await store.observe(tenant.id);assertCurrent();const s=structuredClone(observed.value??defaults());
  const r=proactiveCandidates(s,observations,now);let added=0;
  for(const c of r.candidates)if(!s.candidates[c.id]){s.candidates[c.id]=c;added++;}
  s.proactiveStatus={lastRefreshAt:now,deliveryReady,nextInterestIndex,preferencesRevision:s.preferencesRevision??0,sources,...(s.factMemoryPaused?{memory:'paused'}:{memory:s.preferences.categories.memory?'reviewed_facts_only':'disabled'}),candidateReasons:r.status.slice(-24),added};
  s.revision++;
  if(Buffer.byteLength(JSON.stringify(s))>900000)throw Error('Tenant record capacity reached');
  assertCurrent();const commit=await store.compareAndApply(tenant.id,observed.comparison,{operation:'update',action:'set',value:s});assertCurrent();
  if(commit.status==='applied')return {refreshed:true,added,status:s.proactiveStatus};if(commit.status!=='conflict')throw Error('Observation commit unknown; do not dispatch');
 }
 throw Error('Observation refresh contention; no send');
}
/** Admitted incoming conversation -> short-lived topic tokens; never a user fact.
 * The body stays in this call, is not retained, and cannot grant preferences.
 */
export async function noteRecentTopics(store,tenant,assertCurrent,body,messageId,now=Date.now()){
 if(typeof body!=='string'||body.length>10000||typeof messageId!=='string')return;
 for(let n=0;n<8;n++){
  assertCurrent();const observed=await store.observe(tenant.id);assertCurrent();const s=structuredClone(observed.value??defaults()),p=s.preferences;
  if(!p.enabled||p.paused)return;
  const input=body.normalize('NFKC').toLocaleLowerCase(),tokens=[];
  if(p.categories.interest)for(const topic of p.interests)if(nonSensitive(topic)&&input.includes(topic.normalize('NFKC').toLocaleLowerCase()))tokens.push({category:'interest',key:topic});
  if(p.categories.weather&&p.city&&/(天气|降温|下雨|带伞|升温)/.test(input))tokens.push({category:'weather',key:p.city});
  if(p.categories.memory)for(const f of Object.values(s.facts))if(f.proactive?.consent==='verified-web-choice'&&nonSensitive(f.proactive.label)&&input.includes(f.proactive.label.normalize('NFKC').toLocaleLowerCase()))tokens.push({category:'memory',key:f.id});
  if(!tokens.length)return;
  const eventHash=fingerprint('topic-metadata',messageId),old=(s.interactions.recentTopics??[]).filter(t=>t.expiresAt>now);
  if(old.some(t=>t.eventHash===eventHash))return;
  const keys=new Set(tokens.map(t=>t.category+':'+t.key));s.interactions.recentTopics=[...old.filter(t=>!keys.has(t.category+':'+t.key)),...tokens.map(t=>({...t,eventHash,expiresAt:now+3*hour}))].slice(-40);s.revision++;
  assertCurrent();const commit=await store.compareAndApply(tenant.id,observed.comparison,{operation:'update',action:'set',value:s});assertCurrent();if(commit.status==='applied')return;if(commit.status!=='conflict')throw Error('Topic metadata commit unknown');
 }
 throw Error('Topic metadata contention');
}
