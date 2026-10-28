import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults,completePreferences,transition,candidateDecision} from '../../extensions/dafeiyu-domain/core/domain.mjs';
import {greetingCandidates,validGreeting} from '../../extensions/dafeiyu-domain/proactive/greetings.mjs';
import {generateGreeting} from '../../extensions/dafeiyu-domain/proactive/character-life.mjs';
import {fixture,peer} from '../domain/fact-test-fixtures.mjs';
import {schedulerTransition} from '../../extensions/dafeiyu-domain/core/business-scheduler.mjs';

const now=Date.parse('2026-10-27T10:30:00Z'); // Beijing 18:30.
const minute=60000;
function active(){const s=defaults();Object.assign(s.preferences,{enabled:true,paused:false,dailyGreetingEnabled:true,dailyGreetingTime:'18:30'});s.preferencesRevision=1;s.businessScheduler={enabled:true,attempts:{},lastDispatchAt:0};s.interactions.lastVerifiedActivityAt=now-60*minute;return s;}
const lease=r=>({attemptId:r.attemptId,lease:r.lease});

test('upgrading old greetings never opts an account into daily messages',()=>{
 const old={...defaults().preferences};delete old.dailyGreetingEnabled;delete old.dailyGreetingTime;old.categories.greeting=true;
 assert.equal(completePreferences(old).dailyGreetingEnabled,false);
 const s=active();s.preferences=completePreferences(old);s.preferences.enabled=true;s.preferences.paused=false;
 assert.deepEqual(greetingCandidates(s,now),[]);
});

test('a daily greeting needs explicit enablement, recent actual interaction and allowed contact hours',()=>{
 const s=active();const c=greetingCandidates(s,now);
 assert.equal(c.length,1);assert.equal(c[0].source,'daily-greeting');assert.equal(validGreeting(s,c[0],now),true);
 assert.equal(candidateDecision(s,c[0],now).allow,true); // Independent of plan-completion greetings.
 assert.equal(greetingCandidates(s,now+45*minute).length,1);
 for(const t of [Date.parse('2026-10-27T08:59:00+08:00'),Date.parse('2026-10-28T00:00:00+08:00')]){const off=structuredClone(s);off.interactions.lastVerifiedActivityAt=t-60*minute;assert.deepEqual(greetingCandidates(off,t),[]);}
 for(const activity of [undefined,null,0,-1,NaN,Infinity,now+1]){s.interactions.lastVerifiedActivityAt=activity;assert.deepEqual(greetingCandidates(s,now),[]);}
});

test('eligible daily slots have no fixed message before model generation',()=>{
 for(const time of ['09:59','14:00','18:30','22:30']){
  const at=Date.parse('2026-10-28T'+time+':00+08:00'),s=active();
  s.preferences.dailyGreetingTime=time;s.interactions.lastVerifiedActivityAt=at-60*minute;
  const c=greetingCandidates(s,at)[0];assert.ok(c);assert.equal(c.text,undefined);
  assert.equal(c.generation.status,'needed');assert.equal(candidateDecision(s,c,at).allow,true);
  assert.equal(greetingCandidates(s,at+20*minute)[0].fingerprint,c.fingerprint);
 }
});

test('pause, quiet hours and an active conversation suppress the same daily candidate',()=>{
 const s=active(),c=greetingCandidates(s,now)[0];
 s.preferences.paused=true;assert.equal(candidateDecision(s,c,now).allow,false);
 s.preferences.paused=false;s.preferences.quietStart='18:00';s.preferences.quietEnd='19:00';assert.equal(candidateDecision(s,c,now).reason,'quiet_hours');
 s.preferences.quietStart='00:00';s.preferences.quietEnd='09:00';s.interactions.activeConversation={expiresAt:now+minute};assert.equal(candidateDecision(s,c,now).reason,'conversation_active');
});

test('normal claim, final validation and settlement respect the configured frequency after restart or settings changes',async()=>{
 let s=active(),r=schedulerTransition(s,'claim',{},now);assert.equal(r.result.ready,true);s=r.state;const l=lease(r.result);
 r=schedulerTransition(s,'begin',l,now+1);assert.equal(r.result.ready,true);s=r.state;
 const f=fixture();f.seed(s);
 try{const store=f.api.runtime.state.openKeyedStoreV2({namespace:'tenant-domain-v1'});
  const generated=await generateGreeting(store,peer(),()=>{},l,{now:()=>now+1,generator:async()=>({message:'Synthetic model-generated role life',continuity:'Synthetic ongoing role scene',skip:false})});
  assert.equal(generated.ready,true);s=f.read();
 }finally{f.close();}

 r=schedulerTransition(s,'validate',l,now+2);assert.equal(r.result.ready,true);assert.ok(r.result.message.length<140);s=r.state;
 s=schedulerTransition(s,'settle',{...l,outcome:'accepted'},now+3).state;
 s=structuredClone(s);s.preferencesRevision++;s.preferences.dailyGreetingTime='18:35';
 assert.equal(schedulerTransition(s,'claim',{},now+5*minute).result.ready,false);
 assert.equal(Object.values(s.candidates).filter(x=>x.status==='sent').length,1);
});

test('revoking a daily choice between claim and final validation prevents delivery',()=>{
 let r=schedulerTransition(active(),'claim',{},now),s=r.state,l=lease(r.result);
 r=schedulerTransition(s,'begin',l,now+1);s=r.state;s.preferences.dailyGreetingEnabled=false;s.preferencesRevision++;
 assert.equal(schedulerTransition(s,'validate',l,now+2).result.ready,false);
});

test('unknown send results retain their daily deduplication fence',()=>{
 let r=schedulerTransition(active(),'claim',{},now),s=r.state,l=lease(r.result);
 s=schedulerTransition(s,'begin',l,now+1).state;s=schedulerTransition(s,'settle',{...l,outcome:'unknown'},now+2).state;
 assert.equal(schedulerTransition(structuredClone(s),'claim',{},now+10*minute).result.ready,false);
});

test('only reviewed preference confirmation enables daily greeting and night times are rejected',()=>{
 let s=defaults();const source={kind:'authenticated-portal',consent:'verified-web-choice'};
 const p={...s.preferences,enabled:true,paused:false,dailyGreetingEnabled:true,dailyGreetingTime:'18:30'};
 let r=transition(s,{action:'preferences.propose',id:'daily-choice',value:p,requestId:'daily-preview'},source,now);
 assert.equal(r.state.preferences.dailyGreetingEnabled,false);
 // The existing native preference lifecycle requires confirmation, never the preview alone.
 assert.ok(Object.values(r.state.preferenceDrafts).length>0);
 const confirmed=transition(r.state,{action:'preferences.confirm',id:'daily-choice',expectedRevision:r.result.confirmationRevision,requestId:'daily-confirm'},source,now);
 assert.equal(confirmed.state.preferences.dailyGreetingEnabled,true);
 assert.equal(confirmed.state.businessScheduler.enabled,true);
 for(const time of ['00:00','08:59','24:00','18:99'])assert.throws(()=>transition(defaults(),{action:'preferences.propose',id:'daily-choice',value:{...p,dailyGreetingTime:time},requestId:'invalid-'+time},source,now),/日常问候时间/);
});

test('an opted-in daily greeting remains eligible after more than 24 hours of silence',()=>{
 for(const age of [25*60*minute,7*24*60*minute,90*24*60*minute]){
  const s=active();s.interactions.lastVerifiedActivityAt=now-age;
  const candidates=greetingCandidates(s,now);assert.equal(candidates.length,1);
  assert.equal(validGreeting(s,candidates[0],now),true);
  assert.equal(candidateDecision(s,candidates[0],now).allow,true);
  assert.equal(schedulerTransition(s,'claim',{},now).result.ready,true);
 }
});


test('a confirmed plan completion can follow up without recent chat, while the completion window stays bounded',()=>{
 const s=active();s.preferences.dailyGreetingEnabled=false;s.preferences.categories.greeting=true;
 s.interactions.lastVerifiedActivityAt=now-7*24*60*minute;
 s.plans.done={id:'done',status:'completed',revision:1,updatedAt:now-30*minute,lastChangeSource:{consent:'verified-web-choice'}};
 const candidates=greetingCandidates(s,now);assert.equal(candidates.length,1);
 assert.equal(candidates[0].source,'explicit-plan-completion');assert.equal(validGreeting(s,candidates[0],now),true);
 assert.deepEqual(greetingCandidates(s,now+90*minute),[]);
});


test('long silence does not bypass opt-out, quiet hours, daily quota or duplicate delivery protection',()=>{
 const s=active();s.interactions.lastVerifiedActivityAt=now-7*24*60*minute;
 const candidate=greetingCandidates(s,now)[0];assert.ok(candidate);
 s.preferences.dailyGreetingEnabled=false;assert.deepEqual(greetingCandidates(s,now),[]);s.preferences.dailyGreetingEnabled=true;
 s.preferences.enabled=false;assert.deepEqual(greetingCandidates(s,now),[]);s.preferences.enabled=true;
 s.preferences.paused=true;assert.deepEqual(greetingCandidates(s,now),[]);s.preferences.paused=false;
 s.preferences.quietStart='18:00';s.preferences.quietEnd='19:00';assert.equal(candidateDecision(s,candidate,now).reason,'quiet_hours');
 s.preferences.quietStart='00:00';s.preferences.quietEnd='09:00';s.preferences.greetingLimit=1;
 s.candidates.used={id:'used',fingerprint:'other',category:'greeting',status:'sent',sentAt:now-minute,deliveryAttemptAt:now-minute};
 assert.equal(candidateDecision(s,candidate,now).reason,'greeting_limit');
 s.preferences.greetingLimit=5;
 s.candidates={old:{...candidate,id:'old',status:'sent',sentAt:now-minute,deliveryAttemptAt:now-minute}};
 assert.equal(validGreeting(s,candidate,now+30*minute),false);
 assert.equal(candidateDecision(s,candidate,now).reason,'duplicate');
});
