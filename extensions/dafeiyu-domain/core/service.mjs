import {activityPattern} from '../proactive/greetings.mjs';
import {conversationFloor} from '../proactive/character-life.mjs';
import {releasedCategories,releasedSources,assertReleasedPreference} from './release-policy.mjs';
import {noteRecentTopics} from '../proactive/proactive.mjs';
import {dispatchEligibility} from './business-scheduler.mjs';
import {defaults,completePreferences,resolveTenant,mutate,candidateDecision,hasExplicitReminders} from './domain.mjs';
import {projectReminders} from './scheduling.mjs';
import {factMemoryView} from '../memory/fact-memory.mjs';
import {proposeConversation,answerConversation} from './conversation.mjs';
import {matterView,matterContext,completionTarget} from '../matters/matters.mjs';
import {matterTransaction,purgeForgottenSources} from '../matters/matter-sources.mjs';
import {transition} from './domain.mjs';
/** Both authenticated adapters share this exact store and tenant key. */
export function createDomainService(api,ctx){
 const assertCurrent=()=>{resolveTenant(ctx,api.runtime.config.current());ctx.assertInputCommitAllowed?.();};
 const tenant=resolveTenant(ctx,api.runtime.config.current());
 return createBoundDomainService(api,tenant,assertCurrent,{kind:'authenticated-user',sessionKey:tenant.sessionKey,runId:ctx.runId??null});
}
/** Internal adapter entry: authority must come from host command/RPC, never model arguments. */
export function createBoundDomainService(api,tenant,assertCurrent,source){
 const store=api.runtime.state.openKeyedStoreV2({namespace:'tenant-domain-v1',retention:'retained'},{assertCurrent});
 return {
  async matters(id){assertCurrent();const s=await store.lookup(tenant.id)??defaults();assertCurrent();return matterView(s,id)},
  async matterContext(input){assertCurrent();const s=await store.lookup(tenant.id)??defaults();assertCurrent();return matterContext(s,input)},
  async focusMatter(id,now=Date.now()){
   return matterTransaction(store,tenant,assertCurrent,s=>{const m=s.matters?.[id];if(m?.status==='active'){
    const old=s.matterFocus,sameRun=source.runId&&old?.runId===source.runId&&old.expiresAt>now,ambiguous=Boolean(sameRun&&(old.ambiguous||old.id!==id));
    s.matterFocus={id:ambiguous?null:id,revision:m.revision,ambiguous,runId:source.runId??null,createdAt:now,expiresAt:now+30*60000};
   }return {state:s,result:m??null}});
  },
  async clearMatterFocus(receivedAt){return matterTransaction(store,tenant,assertCurrent,s=>{if(s.matterFocus&&receivedAt>s.matterFocus.createdAt)delete s.matterFocus;return {state:s,result:true}})},
  async finishMatter(envelope,now=Date.now()){
   if(source.kind!=='verified-weixin-business-ingress'||envelope.directText===false)return null;
   return matterTransaction(store,tenant,assertCurrent,s=>{
    const receipt=s.conversationReceipts?.['message:'+envelope.messageId];if(receipt)return {state:s,result:receipt.text};
    const target=completionTarget(s,envelope.text,now);
    if(!target||!Number.isSafeInteger(envelope.receivedAt)||envelope.receivedAt<(s.matterFocus?.createdAt??0))return {state:s,result:null};
    const changed=transition(s,{action:'matter.complete',id:target.id,expectedRevision:target.revision,requestId:'done:'+envelope.messageId},
     {...source,consent:'verified-chat-confirmation',reminderConsent:true},now);
    changed.state.conversationReceipts??={};changed.state.conversationReceipts['message:'+envelope.messageId]={text:changed.result.summary,at:now};
    return {state:changed.state,result:changed.result.summary};
   });
  },
  async propose(command,now=Date.now()){return proposeConversation(store,tenant,assertCurrent,command,{...source,account:tenant.account,sender:tenant.sender},now)},
  async answer(envelope){const text=await answerConversation(store,tenant,assertCurrent,envelope,{...source,account:tenant.account,sender:tenant.sender},{shadowOnly:api.runtime.config.current().plugins?.entries?.['dafeiyu-domain']?.config?.shadowOnly!==false});try{const cleared=await purgeForgottenSources(api,tenant,assertCurrent);return text&&cleared?text+'\n归档原件和原文已清理。':text}catch{return text?text+'\n原件清理尚未完成，可刷新资料页重试。':text}},
  async noteTopics(body,messageId,now=Date.now()){return noteRecentTopics(store,tenant,assertCurrent,body,messageId,now)},
  async read(){try{await purgeForgottenSources(api,tenant,assertCurrent)}catch{}assertCurrent();const state=await store.lookup(tenant.id)??defaults();assertCurrent();return {availableCategories:releasedCategories,pendingConfirmation:state.conversationChoice?.summary??null,revision:state.revision,preferencesRevision:state.preferencesRevision??0,dispatchAttempts:Object.values(state.businessScheduler?.attempts??{}).map(({id,status,createdAt,startedAt,finishedAt,reviewedAt,ids})=>({id,status,createdAt,startedAt,finishedAt,reviewedAt,reminderCount:ids.length})),documentCleanupPending:Object.values(state.matterSourceTombstones??{}).filter(t=>!t.purgedAt).length,matters:matterView(state),documents:Object.values(state.matterSources??{}).filter(x=>x.archived),plans:Object.values(state.plans).filter(p=>!p.matterId),facts:Object.values(state.facts),factDrafts:Object.values(state.factDrafts??{}).filter(d=>d.expiresAt>Date.now()),interactionState:{active:(state.interactions.activeConversation?.expiresAt??0)>Date.now(),lastVerifiedActivityAt:state.interactions.lastVerifiedActivityAt??null,greetingMode:'adaptive',activitySampleDays:activityPattern(state,Date.now()).days,greetingTrigger:'adaptive_contact_window',greetingMinDelayMinutes:30,greetingExpiryMinutes:120,greetingCooldownMinutes:state.preferences.cooldownMinutes},factMemoryPaused:state.factMemoryPaused??false,autoFactMemory:factMemoryView(state),proactiveStatus:{deliveryReady:false,...(state.proactiveStatus??{}),lastCheckAt:state.businessScheduler?.lastCheckAt??null,sources:{...state.proactiveStatus?.sources,...releasedSources}},sourceStatus:{...releasedSources,memory:state.proactiveStatus?.memory??'reviewed_facts_only'},preferences:{...completePreferences(state.preferences),categories:{...completePreferences(state.preferences).categories,weather:false,interest:false}},reminders:Object.values(state.candidates).map(c=>{const {generation,...visible}=c;return {...visible,eligibility:c.status==='pending'?dispatchEligibility(state,c,Date.now()):{allow:false,reason:c.status}}}),shadowOnly:api.runtime.config?.current?.().plugins?.entries?.['dafeiyu-domain']?.config?.shadowOnly!==false,deliveryEnabled:Boolean(state.businessScheduler?.enabled||hasExplicitReminders(state))};},
  async characterContext(){
   assertCurrent();const state=await store.lookup(tenant.id);assertCurrent();const life=state?.characterLife,forgetAt=conversationFloor(state??defaults(),0);
   if(!(life?.updatedAt>forgetAt))return null;
   const context={roleLife:true,updatedAt:new Date(life.updatedAt).toISOString(),summary:life.summary,
    ownPublishedEvents:life.events.filter(e=>e.at>forgetAt).slice(-4).map(e=>({...e,at:new Date(e.at).toISOString()}))};
   while(JSON.stringify(context).length>2400&&context.ownPublishedEvents.length)context.ownPublishedEvents.shift();
   return JSON.stringify(context);
  },
  async change(command,{consent,confirmationNonce}={}){assertCurrent();if(command.action==='fact.auto.enable'&&api.runtime.config.current().plugins?.entries?.['dafeiyu-domain']?.hooks?.allowConversationAccess!==true)throw Error('Structured memory conversation access has not been approved');if(['preferences.propose','preferences.set'].includes(command.action))assertReleasedPreference(command.value);if(command.action==='preferences.confirm'){const state=await store.lookup(tenant.id);assertCurrent();assertReleasedPreference(state?.preferenceDrafts?.[command.id]?.value);}const result=await mutate(store,tenant.id,command,{...source,account:tenant.account,sender:tenant.sender,...(consent?{consent}:{}),...(confirmationNonce?{confirmationNonce}:{})});assertCurrent();let cleanupComplete=true;if(command.action==='matter.forget')try{await purgeForgottenSources(api,tenant,assertCurrent)}catch{cleanupComplete=false}const shadowOnly=api.runtime.config?.current?.().plugins?.entries?.['dafeiyu-domain']?.config?.shadowOnly!==false;return {...result,...(command.action==='matter.forget'?{cleanupComplete}:{}),...('shadowOnly' in result?{shadowOnly}:{}),...('delivery' in result?{delivery:result.draft?'awaiting_confirmation':shadowOnly?'shadow':'business_preferences_apply'}:{})};},
  async reconcile(now=Date.now()){
   for(let attempt=0;attempt<8;attempt++){
    assertCurrent();const observed=await store.observe(tenant.id),state=structuredClone(observed.value??defaults());
    const {jobs,errors}=projectReminders(state,now);
    for(const candidate of Object.values(state.candidates))if(candidate.category==='reminder'&&candidate.status==='pending'&&(!state.plans[candidate.planId]||state.plans[candidate.planId].status!=='active'||state.plans[candidate.planId].revision!==candidate.revision))candidate.status='cancelled';
    for(const job of jobs)if(!state.candidates[job.id])state.candidates[job.id]={...job,category:'reminder',status:'pending',deliveryMode:'shadow',createdAt:now};
    if(JSON.stringify(state)===JSON.stringify(observed.value??defaults()))return {pending:Object.values(state.candidates).filter(x=>x.status==='pending').length,errors,shadowOnly:true};
    state.revision++;assertCurrent();const result=await store.compareAndApply(tenant.id,observed.comparison,{operation:'update',action:'set',value:state});
    if(result.status==='applied')return {pending:Object.values(state.candidates).filter(x=>x.status==='pending').length,errors,shadowOnly:true};
    if(result.status!=='conflict')throw Error('Unknown commit outcome; inspect before retry');
   }
   throw Error('Concurrent change; retry reconciliation');
  }
 };
}
