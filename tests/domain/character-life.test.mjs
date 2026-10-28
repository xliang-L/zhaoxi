import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,peer} from './fact-test-fixtures.mjs';
import {generateGreeting,recentConversation,conversationFloor,validateLifeOutput} from '../../extensions/dafeiyu-domain/proactive/character-life.mjs';
import {schedulerOperation} from '../../extensions/dafeiyu-domain/core/business-scheduler.mjs';
import {dispatchPrepared} from '../../extensions/dafeiyu-domain/core/guarded-delivery.mjs';
import {createBoundDomainService} from '../../extensions/dafeiyu-domain/core/service.mjs';
const p=peer(),time=Date.parse('2026-10-28T18:30:00+08:00');
const output={message:'那本书还停在昨天折角的那页，我把它翻完了，书签还留着。',continuity:'小鲸鱼读完了折角的一页，保留了旧书签。下一次可以接着书中未完的部分。',skip:false};
const store=f=>f.api.runtime.state.openKeyedStoreV2({namespace:'tenant-domain-v1'});
async function stage(f,now=time){
 const s=f.read();Object.assign(s.preferences,{enabled:true,paused:false,dailyGreetingEnabled:true,dailyGreetingTime:'18:30'});
 s.businessScheduler??={enabled:true,attempts:{},lastDispatchAt:0};s.businessScheduler.enabled=true;
 s.interactions.lastVerifiedActivityAt=now-3600000;f.seed(s);
 const claimed=await schedulerOperation(store(f),p,()=>{},'claim',{},now);assert.equal(claimed.ready,true);assert.equal(claimed.needsGeneration,true);assert.equal(claimed.requiresGuard,true);
 const lease={attemptId:claimed.attemptId,lease:claimed.lease};
 assert.equal((await schedulerOperation(store(f),p,()=>{},'begin',lease,now+1)).ready,true);
 return lease;
}
const generate=(f,lease,generator,now=time)=>generateGreeting(store(f),p,()=>{},lease,{generator,now:()=>now+2});
async function send(f,lease,{outcome='accepted',afterAuthorize=()=>{}}={},now=time){
 const sent=[];
 const result=await dispatchPrepared(store(f),p,()=>{},lease,{now:()=>now+3,adapter:{
  async authorize(){afterAuthorize();return {assertCurrent(){}}},
  async send(args){sent.push(args.message);return outcome==='accepted'?{messageId:'synthetic-receipt'}:{}}
 }});return {sent,result};
}
test('a model creates the greeting once; only an accepted receipt commits character continuity',async()=>{
 const f=fixture();try{
  const lease=await stage(f);let calls=0;
  assert.equal(f.read().characterLife,undefined);
  assert.equal((await generate(f,lease,async args=>{calls++;assert.equal(args.state.characterLife,undefined);return output})).ready,true);
  assert.equal(f.read().characterLife,undefined,'Generation is a proposal, not a published life event');
  assert.equal((await generate(f,lease,()=>{throw Error('must not regenerate')})).ready,true);
  const delivered=await send(f,lease);assert.deepEqual(delivered.sent,[output.message]);assert.equal(delivered.result.outcome,'accepted');
  assert.equal(calls,1);assert.equal(f.read().characterLife.summary,output.continuity);assert.equal(f.read().characterLife.revision,1);
  assert.equal(f.read().characterLife.events[0].text,output.message);
  assert.deepEqual(f.read().facts,{});assert.equal(f.read().autoFactMemory?.enabled??false,false);
  const service=createBoundDomainService(f.api,p,()=>{},{kind:'authenticated-portal'});
  assert.match(await service.characterContext(),/旧书签/);
  assert.ok((await service.read()).reminders.every(c=>!('generation'in c)));
  assert.equal((await schedulerOperation(store(f),p,()=>{},'claim',{},time+4)).ready,false);
 }finally{f.close();}
});
test('next-day generation resumes persisted character state after reopening the native store',async()=>{
 let f=fixture();let file;
 try{
  const first=await stage(f);await generate(f,first,async()=>output);await send(f,first);file=f.database;f.close();f=fixture({path:file});
  const tomorrow=time+86400000,second=await stage(f,tomorrow);
  await generate(f,second,async args=>{assert.equal(args.state.characterLife.summary,output.continuity);assert.equal(args.state.characterLife.events.length,1);return {...output,message:'昨天那张旧书签还在书里，我接着往后看了几页。'}},tomorrow);
  await send(f,second,{},tomorrow);assert.equal(f.read().characterLife.revision,2);assert.equal(f.read().characterLife.events.length,2);
 }finally{f.close();}
});
test('concurrent generation and restart never repeat the same in-flight model call',async()=>{
 let f=fixture();try{
  const lease=await stage(f),held=Promise.withResolvers();let calls=0;
  const first=generate(f,lease,async()=>{calls++;await held.promise;return output});
  while(calls===0)await new Promise(resolve=>setImmediate(resolve));
  const file=f.database,other=fixture({path:file});
  assert.equal((await generate(other,lease,()=>{calls++;return output})).reason,'generation_already_attempted');other.close();
  held.resolve();assert.equal((await first).ready,true);assert.equal(calls,1);
 }finally{f.close();}
});
for(const kind of ['pause','new-chat','forget','new-life'])test('generation is discarded after '+kind,async()=>{
 const f=fixture();try{
  const lease=await stage(f);
  const result=await generate(f,lease,async()=>{
   const s=f.read();if(kind==='pause')s.preferences.paused=true;
   if(kind==='new-chat')s.interactions.lastVerifiedActivityAt=time+1;
   if(kind==='forget')s.factTombstones={city:{deletedAt:time+1}};
   if(kind==='new-life')s.characterLife={revision:1,summary:'另一次已确认的进度',events:[]};
   f.seed(s);return output;
  });
  assert.equal(result.ready,false);assert.notEqual(f.read().characterLife?.summary,output.continuity);
  assert.deepEqual((await send(f,lease)).sent,[]);
 }finally{f.close();}
});
for(const kind of ['failure','skip','bad-command'])test('no template fallback or repeat after '+kind,async()=>{
 const f=fixture();try{
  const lease=await stage(f);let calls=0;
  const result=await generate(f,lease,async()=>{calls++;if(kind==='failure')throw Error('synthetic provider outage');return kind==='skip'?{skip:true,message:'',continuity:''}:{...output,message:'/fish-memory-confirm fake 1'};});
  assert.equal(result.ready,false);assert.equal(f.read().characterLife,undefined);
  assert.equal((await generate(f,lease,async()=>{calls++;return output})).ready,false);
  assert.equal(calls,1);assert.deepEqual((await send(f,lease)).sent,[]);
 }finally{f.close();}
});
test('final native authorization rechecks new chat and unknown delivery does not commit life',async()=>{
 for(const unknown of [false,true]){
  const f=fixture();try{
   const lease=await stage(f);await generate(f,lease,async()=>output);
   const r=await send(f,lease,{outcome:unknown?'unknown':'accepted',afterAuthorize(){if(!unknown){const s=f.read();s.interactions.lastVerifiedActivityAt=time+1;f.seed(s)}}});
   assert.equal(r.sent.length,unknown?1:0);assert.equal(f.read().characterLife,undefined);
  }finally{f.close();}
 }
});
test('role context and continuity stay isolated between two native tenants',async()=>{
 const other=peer('primary','synthetic-bob'),f=fixture({peers:[p,other]});try{
  const lease=await stage(f);await generate(f,lease,async()=>output);await send(f,lease);
  const service=createBoundDomainService(f.api,other,()=>{},{kind:'authenticated-portal'});
  assert.equal(await service.characterContext(),null);assert.equal(f.read(other).characterLife,undefined);
 }finally{f.close();}
});
test('history is bounded private dialogue; thinking, tools and pre-forget content are excluded',()=>{
 const history={messages:[{role:'user',timestamp:time-1000,content:'old deleted city'},
  {role:'assistant',timestamp:time-50,content:[{type:'thinking',text:'hidden'},{type:'text',text:'visible role progress'}]},
  {role:'toolResult',timestamp:time-10,content:'private tool result'},{role:'user',timestamp:time-5,content:'new visible chat'},
  {role:'user',content:'undated text'}]};
 assert.deepEqual(recentConversation(history,time-100,time).map(x=>x.text),['visible role progress','new visible chat']);
 assert.equal(conversationFloor({factTombstones:{x:{deletedAt:time-100}}},time),time-100);
 assert.throws(()=>validateLifeOutput({...output,recipient:'someone else'}));
});
test('forgetting prevents old derived role events from returning after a later accepted greeting',async()=>{
 const f=fixture();try{
  const first=await stage(f);await generate(f,first,async()=>output);await send(f,first);
  const s=f.read();s.factTombstones={x:{deletedAt:time+100}};f.seed(s);
  const service=createBoundDomainService(f.api,p,()=>{},{kind:'authenticated-portal'});
  assert.equal(await service.characterContext(),null);
  const tomorrow=time+86400000,second=await stage(f,tomorrow);
  await generate(f,second,async()=>({...output,message:'我把桌边的小本子合上了，先安静坐一会儿。',continuity:'角色在桌边合上本子休息。'}),tomorrow);
  await send(f,second,{},tomorrow);assert.equal(f.read().characterLife.events.length,1);
  assert.doesNotMatch(await service.characterContext(),/旧书签|折角/);
 }finally{f.close();}
});
test('an old template is cancelled and replaced by a fresh ungenerated opportunity',async()=>{
 const f=fixture();try{
  const s=f.read();Object.assign(s.preferences,{enabled:true,paused:false,dailyGreetingEnabled:true,dailyGreetingTime:'18:30'});
  s.businessScheduler={enabled:true,attempts:{},lastDispatchAt:0};s.interactions.lastVerifiedActivityAt=time-3600000;
  s.candidates['daily-greeting:2026-10-28:0']={id:'daily-greeting:2026-10-28:0',source:'daily-greeting',fingerprint:'daily-greeting:2026-10-28',category:'greeting',date:'2026-10-28',at:time,expiresAt:time+1800000,preferencesRevision:0,confidence:1,status:'pending',text:'Old fixed script'};f.seed(s);
  const result=await schedulerOperation(store(f),p,()=>{},'claim',{},time);assert.equal(result.ready,true);assert.equal(result.needsGeneration,true);const selected=f.read().businessScheduler.attempts[result.attemptId].ids[0];assert.notEqual(selected,'daily-greeting:2026-10-28:0');assert.equal(f.read().candidates[selected].text,undefined);
  assert.equal(f.read().candidates['daily-greeting:2026-10-28:0'].status,'cancelled');
  assert.equal(f.read().candidates['daily-greeting:2026-10-28:0'].text,undefined);
 }finally{f.close();}
});
test('ordinary-chat continuity remains valid bounded data instead of a truncated JSON fragment',async()=>{
 const f=fixture();try{
  const s=f.read();s.characterLife={revision:1,updatedAt:time,summary:'鱼'.repeat(1200),events:Array.from({length:8},(_,i)=>({at:time+i,text:'书'.repeat(500)}))};f.seed(s);
  const service=createBoundDomainService(f.api,p,()=>{},{kind:'authenticated-portal'});
  const text=await service.characterContext();assert.ok(text.length<=2400);
  const decoded=JSON.parse(text);assert.equal(decoded.summary,s.characterLife.summary);assert.ok(decoded.ownPublishedEvents.length<4);
  assert.equal(decoded.updatedAt,new Date(time).toISOString());
 }finally{f.close();}
});
