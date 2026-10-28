import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults,candidateDecision} from '../../extensions/dafeiyu-domain/core/domain.mjs';
import {greetingCandidates,validGreeting,activityTransition} from '../../extensions/dafeiyu-domain/proactive/greetings.mjs';
import {schedulerTransition,schedulerOperation} from '../../extensions/dafeiyu-domain/core/business-scheduler.mjs';
import {generateGreeting,explicitContactDelay} from '../../extensions/dafeiyu-domain/proactive/character-life.mjs';
import {dispatchPrepared} from '../../extensions/dafeiyu-domain/core/guarded-delivery.mjs';
import {fixture,peer} from '../domain/fact-test-fixtures.mjs';

const minute=60000,hour=60*minute,now=Date.parse('2026-10-28T18:30:00+08:00');
function active(){const s=defaults();Object.assign(s.preferences,{enabled:true,paused:false,dailyGreetingEnabled:true,dailyGreetingTime:'18:30',greetingLimit:3,cooldownMinutes:120});s.preferencesRevision=1;s.interactions.lastVerifiedActivityAt=now-hour;s.businessScheduler={enabled:true,attempts:{},lastDispatchAt:0};return s;}
const lease=x=>({attemptId:x.attemptId,lease:x.lease});
const output={message:'书签还停在那页，我终于把后半章读完了。',continuity:'小鲸鱼读完了后半章，旧书签还留着。',skip:false};
const storage=f=>f.api.runtime.state.openKeyedStoreV2({namespace:'tenant-domain-v1'});
async function prepare(f,at=now){f.seed(active());const claimed=await schedulerOperation(storage(f),peer(),()=>{},'claim',{},at);assert.equal(claimed.ready,true);const l=lease(claimed);assert.equal((await schedulerOperation(storage(f),peer(),()=>{},'begin',l,at)).ready,true);return l;}

test('a plain temporary do-not-disturb request expires and a newer user message replaces it',()=>{
 const busy={role:'user',at:now-5*minute,text:'我现在在上课，接下来两个小时都别打扰我，等我忙完再聊。'};
 assert.equal(explicitContactDelay([busy],now),115);
 assert.equal(explicitContactDelay([{...busy,at:new Date(busy.at).toISOString()}],now),115);
 assert.equal(explicitContactDelay([busy],now+2*hour),0);
 assert.equal(explicitContactDelay([busy,{role:'user',at:now,text:'我忙完了，想聊聊天。'}],now),0);
 assert.equal(explicitContactDelay([{...busy,text:'转发通知：我现在在上课，两个小时别打扰我'}],now),0);
 assert.equal(explicitContactDelay([{...busy,role:'assistant'}],now),0);
});

test('a busy conversation postpones the opportunity beyond the old half-hour window',()=>{
 const s=active();s.interactions.activeConversation={expiresAt:now+40*minute};
 assert.equal(schedulerTransition(s,'claim',{},now).result.ready,false);
 const later=now+45*minute,c=greetingCandidates(s,later)[0];
 assert.ok(c,'the day must still have a greeting opportunity');assert.equal(validGreeting(s,c,later),true);
 assert.equal(schedulerTransition(s,'claim',{},later).result.ready,true);
});

test('accepted and unknown greetings use separate opportunities under the shared daily limit',()=>{
 const s=active(),first=greetingCandidates(s,now)[0];
 s.candidates[first.id]={...first,status:'sent',sentAt:now,deliveryAttemptAt:now};
 s.businessScheduler.lastDispatchAt=now;
 const later=now+2*hour+minute,next=greetingCandidates(s,later)[0];assert.ok(next);assert.notEqual(next.fingerprint,first.fingerprint);
 assert.equal(candidateDecision(s,next,later).allow,true);
 s.candidates[next.id]={...next,status:'unknown',deliveryAttemptAt:later};
 s.businessScheduler.attempts.old={id:'old',status:'unknown',ids:[next.id],createdAt:later,startedAt:later,transportAdmittedAt:later};
 const thirdAt=later+2*hour+minute,third=schedulerTransition(s,'claim',{},thirdAt);assert.equal(third.result.ready,true);
 const claimed=third.state.businessScheduler.attempts[third.result.attemptId];assert.ok(!claimed.ids.includes(next.id));
});

test('quiet hours, recent-chat activity and the daily cap still prevent delivery',()=>{
 const s=active(),c=greetingCandidates(s,now)[0];s.preferences.quietStart='18:00';s.preferences.quietEnd='19:00';assert.equal(candidateDecision(s,c,now).reason,'quiet_hours');
 s.preferences.quietStart='00:00';s.preferences.quietEnd='09:00';s.interactions.lastVerifiedActivityAt=now-minute;assert.equal(candidateDecision(s,c,now).allow,false);
 s.interactions.lastVerifiedActivityAt=now+minute;assert.deepEqual(greetingCandidates(s,now),[]);
 const full=active();for(let i=0;i<3;i++)full.candidates['old'+i]={id:'old'+i,category:'greeting',status:'sent',deliveryAttemptAt:now-(8-i*2)*hour,fingerprint:'old'+i};
 assert.deepEqual(greetingCandidates(full,now),[]);
});

test('activity timing learns bounded hourly metadata only while daily contact is enabled',()=>{
 let s=active();const hash='a'.repeat(64);
 s=activityTransition(s,'start',hash,now).state;s=activityTransition(s,'end',hash,now+minute).state;
 assert.equal(s.interactions.activityHours.length,1);assert.ok(s.interactions.activityHours.every(Number.isSafeInteger));
 s=activityTransition(s,'start','b'.repeat(64),now+2*minute).state;assert.equal(s.interactions.activityHours.length,1);
 s.preferences.dailyGreetingEnabled=false;s=activityTransition(s,'start','c'.repeat(64),now+hour).state;assert.equal(s.interactions.activityHours.length,1);
});

test('learned active hours influence timing without becoming an all-day exclusion',()=>{
 const s=active(),at=Date.parse('2026-10-28T10:00:00+08:00');s.interactions.lastVerifiedActivityAt=at-hour;
 s.interactions.activityHours=[1,2,3,4].map(days=>Date.parse('2026-10-28T19:00:00+08:00')-days*24*hour);
 const c=greetingCandidates(s,at)[0];assert.equal(candidateDecision(s,c,at).allow,false);
 const later=at+4*hour;assert.equal(candidateDecision(s,greetingCandidates(s,later)[0],later).allow,true);
});

test('model skip defers the same unsent opportunity and can later regenerate it',async()=>{
 const f=fixture();try{const l=await prepare(f);let calls=0;
 const result=await generateGreeting(storage(f),peer(),()=>{},l,{now:()=>now,generator:async()=>{calls++;return {skip:true,message:'',continuity:'',retryAfterMinutes:60};}});assert.equal(result.ready,false);
 assert.equal((await schedulerOperation(storage(f),peer(),()=>{},'claim',{},now+30*minute)).ready,false);
 const second=await schedulerOperation(storage(f),peer(),()=>{},'claim',{},now+61*minute);assert.equal(second.ready,true);const l2=lease(second);
 await schedulerOperation(storage(f),peer(),()=>{},'begin',l2,now+61*minute);
 assert.equal((await generateGreeting(storage(f),peer(),()=>{},l2,{now:()=>now+61*minute,generator:async()=>{calls++;return output;}})).ready,true);assert.equal(calls,2);
 assert.equal(f.read().characterLife,undefined);
 }finally{f.close();}
});

test('content that gets stale before transport is discarded and regenerated from current context',async()=>{
 const f=fixture();try{const l=await prepare(f);await generateGreeting(storage(f),peer(),()=>{},l,{now:()=>now,generator:async()=>output});let sends=0;
 const result=await dispatchPrepared(storage(f),peer(),()=>{},l,{now:()=>now+20*minute,adapter:{authorize:async()=>({assertCurrent(){}}),send:async()=>{sends++;return {messageId:'must-not-send'}}}});
 assert.equal(result.ready,false);assert.equal(sends,0);assert.equal(f.read().characterLife,undefined);
 const later=now+51*minute,next=await schedulerOperation(storage(f),peer(),()=>{},'claim',{},later);assert.equal(next.ready,true);
 await schedulerOperation(storage(f),peer(),()=>{},'begin',lease(next),later);
 let calls=0;await generateGreeting(storage(f),peer(),()=>{},lease(next),{now:()=>later,generator:async()=>{calls++;return {...output,message:'刚才换了本书，接着往下看。'};}});assert.equal(calls,1);
 }finally{f.close();}
});

test('a new private chat during generation postpones the greeting rather than consuming the day',async()=>{
 const f=fixture();try{const l=await prepare(f);
 await generateGreeting(storage(f),peer(),()=>{},l,{now:()=>now+1,generator:async()=>{const s=f.read();s.interactions.lastVerifiedActivityAt=now+1;s.interactions.activeConversation={expiresAt:now+40*minute};f.seed(s);return output;}});
 assert.equal(f.read().characterLife,undefined);
 assert.equal((await schedulerOperation(storage(f),peer(),()=>{},'claim',{},now+45*minute)).ready,true);
 }finally{f.close();}
});

test('an unsubmitted generation interrupted by a restart recovers without resending a submitted attempt',()=>{
 let r=schedulerTransition(active(),'claim',{},now),s=r.state,l=lease(r.result);s=schedulerTransition(s,'begin',l,now).state;
 r=schedulerTransition(s,'claim',{},now+3*minute);assert.notEqual(r.state.businessScheduler.attempts[l.attemptId].status,'unknown');
 const c=Object.values(r.state.candidates).find(c=>c.source==='daily-greeting');assert.equal(c.status,'pending');
});

test('a later independent opportunity cannot repeat the same unconfirmed greeting text',async()=>{
 const f=fixture();try{const l=await prepare(f);await generateGreeting(storage(f),peer(),()=>{},l,{now:()=>now,generator:async()=>output});
 await dispatchPrepared(storage(f),peer(),()=>{},l,{now:()=>now,adapter:{authorize:async()=>({assertCurrent(){}}),send:async()=>({})}});
 const later=now+2*hour+minute,next=await schedulerOperation(storage(f),peer(),()=>{},'claim',{},later);assert.equal(next.ready,true);const second=lease(next);
 await schedulerOperation(storage(f),peer(),()=>{},'begin',second,later);
 assert.equal((await generateGreeting(storage(f),peer(),()=>{},second,{now:()=>later,generator:async()=>output})).ready,false);
 assert.equal(f.read().characterLife,undefined);assert.ok(Object.values(f.read().candidates).some(c=>c.status==='unknown'));
 }finally{f.close();}
});
