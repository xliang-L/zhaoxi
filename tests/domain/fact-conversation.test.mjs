import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults,transition} from '../../extensions/dafeiyu-domain/core/domain.mjs';
import {factIngressTransition,factContextTransition} from '../../extensions/dafeiyu-domain/memory/fact-memory.mjs';
import {createFactMemoryController} from '../../extensions/dafeiyu-domain/memory/fact-hooks.mjs';
import {peer,fixture,enable,message,envelope,userSource} from './fact-test-fixtures.mjs';
const p=peer(),now=Date.now();
const incoming=(s,text,id='answer',at=now+20,receivedAt=at)=>factIngressTransition(s,[{...message(text,id,at),receivedAt}],p,Math.max(at,receivedAt,now)).state;
function offered(){
 let s=enable(defaults(),p,now-100);
 s.autoFactMemory.city={status:'asked',at:now-50,messageId:'city-question'};
 s=incoming(s,'北京','city-answer',now);
 return factContextTransition(s,{messageId:'canonical-city-answer',messageText:'北京',casual:true},now+1);
}
const context=(s,text,id='canonical-answer',at=now+21)=>factContextTransition(s,{messageId:id,messageText:text,casual:true},at);

test('a spoken yes to the offered city saves it and gives a human acknowledgement without protocol tokens',()=>{
 const proposal=offered();assert.match(proposal.context,/常住城市：北京/);assert.doesNotMatch(proposal.context,/\/fish-|[a-f0-9]{24}/);
 const s=incoming(proposal.state,'好，记住吧');
 const fact=s.facts['auto:profile.city'];assert.equal(fact.value,'北京');assert.equal(fact.confidence,1);
 assert.equal(fact.source.messageId,'city-answer');assert.equal(fact.source.confirmation.messageId,'answer');
 assert.deepEqual(s.factSuggestions,{});const ack=context(s,'好，记住吧');
 assert.match(ack.context,/已保存|记住啦/);assert.match(ack.context,/北京/);assert.doesNotMatch(ack.context,/\/fish-|[a-f0-9]{24}/);
 assert.equal(s.preferences.enabled,false);assert.equal(s.preferences.categories.weather,false);
});

test('common natural approvals work only for the currently offered memory',()=>{
 for(const text of ['好','好的','可以','可以的','行','没问题','同意','我同意','嗯嗯','好，记住吧','可以保存','记住吧','帮我记住吧','好呀，记下来吧']){
  assert.equal(incoming(offered().state,text).facts['auto:profile.city']?.value,'北京',text);
  assert.deepEqual(incoming(enable(defaults(),p,now-100),text).facts,{},text+' without a question');
 }
});

test('refusals dismiss the offered candidate and never turn into a later approval',()=>{
 for(const text of ['不用了','先别记','不要保存','别记住','暂时不保存']){
  let s=incoming(offered().state,text);assert.deepEqual(s.facts,{},text);assert.deepEqual(s.factSuggestions,{},text);
  s=incoming(s,'好','later',now+30);assert.deepEqual(s.facts,{},text);
 }
});

test('questions, quotes, unrelated turns, delayed admissions, expiry and two-choice ambiguity cannot consent',()=>{
 for(const text of ['他说可以','“好，记住吧”','好，但是不要保存','可以吗？','> 好'])assert.deepEqual(incoming(offered().state,text).facts,{},text);
 let s=incoming(offered().state,'今天聊点别的','other');s=incoming(s,'可以','later',now+30);assert.deepEqual(s.facts,{});
 s=incoming(offered().state,'好','queued-before-question',now,now);assert.deepEqual(s.facts,{});
 s=incoming(offered().state,'好','expired',now+11*60000);assert.deepEqual(s.facts,{});
 assert.match(context(s,'好','expired-context',now+11*60000+1).context,/过期|重新核对/);
 s=enable(defaults(),p,now-100);s=incoming(s,'我在北京，我在上海','two-cities',now);
 const proposal=context(s,'我在北京，我在上海','two-cities-context',now+1);
 assert.equal(Object.keys(incoming(proposal.state,'好').facts).length,1);
});

test('spoken approval survives a restart, is idempotent and cannot overwrite a newer correction or a paused memory',()=>{
 let s=JSON.parse(JSON.stringify(offered().state));s=incoming(s,'好');assert.equal(s.facts['auto:profile.city'].value,'北京');const original=JSON.stringify(s);
 assert.equal(JSON.stringify(incoming(s,'好')),original);
 s=incoming(offered().state,'我常住上海','correction');s=incoming(s,'好','late-agreement',now+30);assert.equal(s.facts['auto:profile.city'].value,'上海');
 s=transition(offered().state,{action:'fact.auto.disable',requestId:'off'},userSource(p),now+10).state;
 assert.deepEqual(incoming(s,'好').facts,{});
 s=offered().state;s.factMemoryPaused=true;assert.deepEqual(incoming(s,'好').facts,{});
 s=incoming(offered().state,'我们来扮演故事角色','role');s=incoming(s,'好','after-role',now+30);assert.deepEqual(s.facts,{});
});

test('the acknowledgement freshly reads the fact and cannot retain a deleted value at a provider retry',()=>{
 let s=incoming(offered().state,'好'),fact=s.facts['auto:profile.city'];
 assert.equal(JSON.stringify(s.autoFactMemory.lastChoice).includes('北京'),false);
 let deletion=transition(s,{action:'fact.delete.prepare',id:fact.id,expectedRevision:fact.revision,requestId:'delete-prepare'},userSource(p),now+22);
 s=transition(deletion.state,{action:'fact.delete.confirm',id:fact.id,expectedRevision:fact.revision,requestId:'delete-confirm',value:{nonce:deletion.result.nonce}},userSource(p),now+23).state;
 const result=context(s,'好','canonical-answer',now+24);assert.doesNotMatch(result.context,/北京/);assert.match(result.context,/变更/);
});

test('the existing one-candidate command prompt accepts a natural reply without migrating account data',()=>{
 const legacy=offered().state;delete legacy.autoFactMemory.pendingChoice;
 assert.ok(Object.values(legacy.factSuggestions)[0].offeredFor);
 assert.equal(incoming(legacy,'可以').facts['auto:profile.city']?.value,'北京');
 const unrelated=incoming(legacy,'换个话题','other');assert.deepEqual(incoming(unrelated,'好','later',now+30).facts,{});
});

test('initial memory consent can be spoken after the disclosure, with no backfill or proactive opt-in',()=>{
 const proposal=context(defaults(),'你好','notice',now);
 assert.match(proposal.context,/常住城市/);assert.doesNotMatch(proposal.context,/\/fish-/);
 let s=incoming(proposal.state,'可以');assert.equal(s.autoFactMemory.enabled,true);assert.deepEqual(s.facts,{});
 assert.equal(s.autoFactMemory.consent.source.messageId,'answer');assert.equal(s.preferences.enabled,false);
 s=incoming(s,'我常住上海','new-fact',now+30);assert.equal(s.facts['auto:profile.city'].value,'上海');
 assert.equal(incoming(defaults(),'可以').autoFactMemory.enabled,false);
});

test('the retained input worker commits approval before prompt recall and keeps two accounts separate',async()=>{
 const other=peer('primary','synthetic-other'),f=fixture({peers:[p,other]});
 try{
  f.seed(offered().state,p);f.seed(enable(defaults(),other,now-100),other);
  const controller=createFactMemoryController(f.api,{clock:()=>now+20});
  const receipt=controller.enqueue(envelope(p,[message('好，记住吧','answer',now+20)]));
  const reply=await controller.context({currentUserMessageId:'canonical-answer',currentUserMessage:'好，记住吧'},{channel:'openclaw-weixin',accountId:p.account,senderId:p.sender,agentId:p.id,sessionKey:p.sessionKey,inputProvenance:{kind:'external_user'},hookInvocation:{assertActive(){}},assertMemoryAudienceCurrent(){}});
  assert.equal((await receipt).settled,true);assert.equal(f.read(p).facts['auto:profile.city'].value,'北京');
  assert.match(reply.appendContext,/北京/);assert.deepEqual(f.read(other).facts,{});
 }finally{f.close();}
});
