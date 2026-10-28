import test from 'node:test';
import assert from 'node:assert/strict';
import {businessChat} from '../../extensions/dafeiyu-domain/core/business-chat.mjs';
import {createBoundDomainService} from '../../extensions/dafeiyu-domain/core/service.mjs';
import {schedulerTransition} from '../../extensions/dafeiyu-domain/core/business-scheduler.mjs';
import {factIngressTransition,factContextTransition} from '../../extensions/dafeiyu-domain/memory/fact-memory.mjs';
import {peer,fixture,enable,message,userSource} from './fact-test-fixtures.mjs';
import {transition,defaults} from '../../extensions/dafeiyu-domain/core/domain.mjs';
const p=peer(),now=Date.now(),due=now+3600000;
const command=(id='plan-a',requestId='propose-'+id)=>({action:'plan.create',id,requestId,value:{title:'喝水',kind:'reminder',timezone:'Asia/Shanghai',dueAt:new Date(due).toISOString()}});
const tool=(f,who=p,runId='model-run')=>createBoundDomainService(f.api,who,()=>{}, {kind:'authenticated-user',sessionKey:who.sessionKey,runId});
let serial=0;
const answer=(f,text='同意',extra={},who=p)=>businessChat(f.api,{...who,assertAdmissionCurrent(){},messageId:'reply-'+(++serial),text,receivedAt:Date.now()+1,directText:true,...extra});
async function active(f){await tool(f).propose(command(),now-100);await answer(f);return f.read().plans['plan-a'];}

test('natural approval commits a proposed reminder once without requiring memory access or changing greetings',async()=>{
 const f=fixture();f.config.plugins.entries['dafeiyu-domain'].hooks.allowConversationAccess=false;
 try{
  const draft=await tool(f).propose(command(),now-100);
  assert.equal(draft.saved,false);assert.equal(draft.requiresExplicitConfirmation,true);assert.match(draft.summary,/喝水.*北京时间/s);assert.doesNotMatch(draft.summary,/\/fish-|confirmationNonce|plan-a/);
  assert.deepEqual(f.read().plans,{});const id='same-upstream-reply';
  const reply=await answer(f,'同意',{messageId:id});assert.match(reply,/已按你同意.*喝水/s);assert.doesNotMatch(reply,/\/fish-/);
  const s=f.read(),plan=s.plans['plan-a'];assert.equal(plan.status,'active');assert.equal(plan.reminderConsent.messageId,id);
  assert.equal(s.preferences.enabled,false);assert.equal(s.preferences.dailyGreetingEnabled,false);
  const saved=JSON.stringify(s);assert.equal(await answer(f,'同意',{messageId:id}),reply);assert.equal(JSON.stringify(f.read()),saved);
 }finally{f.close();}
});

test('one same-turn summary can approve multiple plans and a dependent modification atomically',async()=>{
 const f=fixture();try{
  const service=tool(f);await service.propose(command('first'),now-100);
  const second=await service.propose(command('second'),now-90);assert.match(second.summary,/1\..*2\./s);
  const preview=second.plans.find(x=>x.id==='first');
  await service.propose({action:'plan.update',id:'first',expectedRevision:preview.revision,requestId:'change-first',value:{title:'换成喝茶'}},now-80);
  assert.deepEqual(f.read().plans,{});await answer(f,'就这么办');
  assert.equal(f.read().plans.first.title,'换成喝茶');assert.equal(f.read().plans.first.status,'active');assert.equal(f.read().plans.second.status,'active');
 }finally{f.close();}
});

test('a proposed change or refusal leaves the actual active plan intact until a fresh approval',async()=>{
 const f=fixture();try{
  const old=await active(f),service=tool(f,p,'edit-run');
  await service.propose({action:'plan.update',id:old.id,expectedRevision:old.revision,requestId:'edit',value:{dueAt:new Date(due+60000).toISOString()}},Date.now()-1);
  assert.equal(f.read().plans[old.id].dueAt,old.dueAt);
  await answer(f,'先不用');assert.equal(f.read().plans[old.id].dueAt,old.dueAt);
  await service.propose({action:'plan.update',id:old.id,expectedRevision:old.revision,requestId:'edit-again',value:{dueAt:new Date(due+120000).toISOString()}},Date.now()-1);
  await answer(f,'好的');assert.equal(f.read().plans[old.id].dueAt,new Date(due+120000).toISOString());
 }finally{f.close();}
});

for(const action of ['plan.postpone','plan.complete','plan.cancel','plan.delete'])test('natural approval handles '+action+' without applying it at proposal time',async()=>{
 const f=fixture();try{
  const old=await active(f),body={action,id:old.id,expectedRevision:old.revision,requestId:'request-'+action,...(action==='plan.postpone'?{value:{dueAt:new Date(due+60000).toISOString()}}:{})};
  const result=await tool(f,p,'change-run').propose(body,Date.now()-1);assert.match(result.summary,/喝水/);assert.equal(f.read().plans[old.id].revision,old.revision);
  await answer(f,'确认');const changed=f.read().plans[old.id];
  if(action==='plan.delete')assert.equal(changed,undefined);
  else if(action==='plan.postpone')assert.equal(changed.dueAt,body.value.dueAt);
  else assert.equal(changed.status,action==='plan.complete'?'completed':'cancelled');
 }finally{f.close();}
});

test('reminder preference approval is scoped to its preview and rejects a concurrent web edit',async()=>{
 const f=fixture();try{
  const cmd={action:'preferences.propose',id:'daily',requestId:'daily-proposal',value:{enabled:true,paused:false,dailyGreetingEnabled:true,dailyGreetingTime:'18:30'}};
  const result=await tool(f).propose(cmd,now-100);assert.match(result.summary,/18:30.*安静时段/s);assert.equal(f.read().preferences.enabled,false);
  await answer(f,'同意');assert.equal(f.read().preferences.dailyGreetingEnabled,true);
  await tool(f,p,'next-setting').propose({...cmd,id:'change',requestId:'change-daily',value:{dailyGreetingTime:'19:30'}},Date.now()-1);
  f.seed(transition(f.read(),{action:'preferences.pause',requestId:'web-pause'},userSource(p),Date.now()).state);
  assert.match(await answer(f,'同意'),/已经变化/);assert.equal(f.read().preferences.dailyGreetingTime,'18:30');assert.equal(f.read().preferences.paused,true);
 }finally{f.close();}
});

test('a manual preference can also be confirmed in ordinary language',async()=>{
 const f=fixture();try{
  await tool(f).propose({action:'fact.propose',id:'fact-note',requestId:'fact-note-proposal',value:{text:'喜欢下午喝茶'}},now-100);
  assert.deepEqual(f.read().facts,{});await answer(f,'同意');assert.equal(f.read().facts['fact-note'].text,'喜欢下午喝茶');assert.equal(f.read().facts['fact-note'].source.sender,p.sender);
 }finally{f.close();}
});

test('unrelated input, quoted approval, ambiguity and expiry cannot approve an old proposal',async()=>{
 const f=fixture();try{
  for(const [index,text] of ['他说同意','“同意”','同意吗？','同意但是不要执行','聊点别的'].entries()){
   await tool(f,p,'run-'+index).propose(command('item-'+index),Date.now()-1);assert.equal(await answer(f,text),null);await answer(f,'同意');assert.deepEqual(f.read().plans,{});
  }
  await tool(f,p,'quote-run').propose(command('quoted'),Date.now()-1);await answer(f,'同意',{directText:false});await answer(f,'同意');assert.deepEqual(f.read().plans,{});
  await tool(f,p,'expired-run').propose(command('expired'),Date.now()-1);const s=f.read();s.conversationChoice.expiresAt=Date.now()-1;f.seed(s);
  assert.match(await answer(f,'同意'),/过期/);assert.deepEqual(f.read().plans,{});
 }finally{f.close();}
});

test('old admission time, cross-tenant messages and stale plan revisions never grant consent',async()=>{
 const other=peer('primary','synthetic-other'),f=fixture({peers:[p,other]});try{
  await tool(f).propose(command(),now-100);assert.equal(await answer(f,'同意',{receivedAt:now-200}),null);assert.deepEqual(f.read().plans,{});
  assert.equal(await answer(f,'同意',{},other),null);assert.deepEqual(f.read().plans,{});
  await answer(f);const old=f.read().plans['plan-a'];await tool(f,p,'cancel-run').propose({action:'plan.cancel',id:old.id,expectedRevision:old.revision,requestId:'cancel'},Date.now()-1);
  f.seed(transition(f.read(),{action:'plan.complete',id:old.id,expectedRevision:old.revision,requestId:'web-complete'},userSource(p),Date.now()).state);
  assert.match(await answer(f,'同意'),/已经变化/);assert.equal(f.read().plans[old.id].status,'completed');
 }finally{f.close();}
});

test('a business approval cannot also approve an automatic memory suggestion',async()=>{
 const f=fixture();try{
  let s=factIngressTransition(enable(defaults(),p,now-1000),[message('我在北京','city',now-500)],p,now-500).state;
  s=factContextTransition(s,{messageId:'city-question',messageText:'我在北京',casual:true},now-400).state;f.seed(s);
  await tool(f).propose(command(),now-100);
  s=factIngressTransition(f.read(),[message('同意','choice',now)],p,now).state;f.seed(s);
  await answer(f,'同意',{messageId:'choice'});assert.equal(f.read().plans['plan-a'].status,'active');assert.deepEqual(f.read().facts,{});
 }finally{f.close();}
});

test('an approved one-minute reminder bypasses greeting quiet hours and conversation cooldown, then sends only once',async()=>{
 const f=fixture();try{
  await active(f);let s=f.read();s.interactions.activeConversation={expiresAt:due+900000};
  const claim=schedulerTransition(s,'claim',{},due);assert.equal(claim.result.ready,true);
  const lease={attemptId:claim.result.attemptId,lease:claim.result.lease};
  const begun=schedulerTransition(claim.state,'begin',lease,due+1);assert.equal(begun.result.ready,true);
  const admitted=schedulerTransition(begun.state,'validate',lease,due+2);assert.equal(admitted.result.ready,true);assert.match(admitted.result.message,/喝水/);
  const settled=schedulerTransition(admitted.state,'settle',{...lease,outcome:'accepted'},due+3);
  assert.equal(schedulerTransition(settled.state,'claim',{},due+1000).result.ready,false);
  assert.equal(settled.state.preferences.dailyGreetingEnabled,false);
 }finally{f.close();}
});

test('a persisted proposal survives restart and concurrent duplicate approvals change it once',async()=>{
 const f=fixture();let database;try{await tool(f).propose(command(),now-100);database=f.database;}finally{f.close();}
 const reopened=fixture({path:database});try{
  reopened.conflict();const replies=await Promise.all([answer(reopened,'同意',{messageId:'duplicate'}),answer(reopened,'同意',{messageId:'duplicate'})]);
  assert.equal(replies[0],replies[1]);assert.equal(reopened.read().plans['plan-a'].revision,2);assert.equal(reopened.read().independentWriter,true);
 }finally{reopened.close();}
});

test('editing an explicitly approved reminder on the website preserves its permission only after web confirmation',async()=>{
 const f=fixture();try{
  const old=await active(f),updatedDue=due+60000;
  let changed=transition(f.read(),{action:'plan.update',id:old.id,expectedRevision:old.revision,requestId:'web-edit',value:{dueAt:new Date(updatedDue).toISOString()}},userSource(p),now+100).state;
  assert.equal(schedulerTransition(changed,'claim',{},updatedDue).result.ready,false);
  const draft=changed.plans[old.id];changed=transition(changed,{action:'plan.confirm',id:draft.id,expectedRevision:draft.revision,requestId:'web-confirm'},userSource(p),now+101).state;
  assert.equal(schedulerTransition(changed,'claim',{},updatedDue).result.ready,true);assert.equal(changed.preferences.dailyGreetingEnabled,false);
 }finally{f.close();}
});
