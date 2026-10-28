import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {defaults,transition} from '../../extensions/dafeiyu-domain/core/domain.mjs';
import {extractFacts,safeInput} from '../../extensions/dafeiyu-domain/memory/fact-rules.mjs';
import {factIngressTransition,factContextTransition} from '../../extensions/dafeiyu-domain/memory/fact-memory.mjs';
import {createFactMemoryController,registerFactMemory} from '../../extensions/dafeiyu-domain/memory/fact-hooks.mjs';
import {registerControls} from '../../extensions/dafeiyu-domain/core/controls.mjs';
import {peer,fixture,enable,message,envelope,userSource,hookRuntime,loadChannelSource} from './fact-test-fixtures.mjs';
const p=peer(),now=Date.now();
const apply=(s,text,id='m1',at=now)=>factIngressTransition(s,[message(text,id,at)],p,Math.max(now,at)).state;
const values=s=>Object.values(s.facts).map(f=>f.value);

test('mixed-case Weixin identity accepts the canonical session and keeps exact sender admission',async()=>{
 const person=peer('primary','synthetic-MiXeD-A');person.sessionKey=person.sessionKey.toLowerCase();
 const f=fixture({peers:[person]}),controller=createFactMemoryController(f.api);f.seed(enable(defaults(),person,now-100),person);
 try{
  const receipt=await controller.enqueue(envelope(person,[message('我常住上海','mixed-case-source',now)]));
  assert.equal(receipt.settled,true);assert.deepEqual(receipt.outcomes,['saved']);
  const ctx={channel:'openclaw-weixin',accountId:person.account,senderId:person.sender,agentId:person.id,sessionKey:person.sessionKey,inputProvenance:{kind:'external_user'},hookInvocation:{assertActive(){}},assertMemoryAudienceCurrent(){}};
  const recalled=await controller.context({currentUserMessageId:'mixed-case-recall',currentUserMessage:'我住在哪里？'},ctx);
  assert.match(recalled.appendContext,/常住城市：上海/);
  assert.throws(()=>controller.enqueue(envelope({...person,sender:person.sender.toLowerCase()},[message('我常住北京','forged-case',now+1)])),/Verified private/);
  assert.equal(f.read(person).facts['auto:profile.city'].value,'上海');
 }finally{f.close();}
});

test('only bounded stable first-person categories are auto extracted',()=>{
 const s=apply(enable(defaults(),p,now-100),'我常住上海，我喜欢摄影，我喜欢回复简短');
 assert.deepEqual(values(s).sort(),['上海','photography','concise'].sort());
 for(const f of Object.values(s.facts)){assert.equal(f.sourceMessageId,'m1');assert.equal(f.sourceTime,new Date(now).toISOString());assert.equal(f.status,'active');assert.ok(f.confidence>=0.9);assert.equal(f.source.account,p.account);assert.equal(f.source.sender,p.sender);}
 assert.equal(s.preferences.enabled,false);assert.equal(s.preferences.categories.weather,false);assert.equal(s.preferences.city,null);assert.deepEqual(s.plans,{});
});
test('explicit hopes for reply style are preferences while hypothetical or question hopes remain excluded',()=>{
 for(const text of ['我希望你以后回复简短','我希望回复简短','希望你以后回答简洁','希望简短回复'])assert.equal(extractFacts(text).candidates[0]?.value,'concise',text);
 for(const text of ['如果我希望你以后回复简短','我希望你以后回复简短吗','我不希望你以后回复简短','朋友说我希望你以后回复简短','我希望住在上海','我希望喜欢摄影'])assert.deepEqual(extractFacts(text).candidates,[],text);
});
test('recall reserves its bounded budget for city and style ahead of many interests',()=>{
 let s=enable(defaults(),p,now-100);
 const inputs=['我喜欢阅读','我喜欢摄影','我喜欢篮球','我喜欢游泳','我喜欢跑步','我喜欢徒步','我喜欢音乐','我喜欢做饭','我喜欢绘画','我喜欢电子游戏','我喜欢园艺','我喜欢骑行','我喜欢羽毛球','我喜欢电影','我喜欢旅行','我常住上海','我喜欢回复简短','我喜欢回复中文','我喜欢回复分点'];
 for(const [n,text] of inputs.entries())s=apply(s,text,'long-source-'+String(n)+'x'.repeat(180),now+n);
 const {context}=factContextTransition(s,{messageId:'budget-turn',messageText:'我的常住城市是哪里？我有哪些爱好，推荐周末休闲活动。',casual:false},now+30),line=context.split('\n').find(x=>x.startsWith('本人已保存'));
 const encoded=line.slice(line.indexOf('[')),facts=JSON.parse(encoded);
 for(const value of ['常住城市：上海','回复偏好：简短','回复偏好：中文','回复偏好：分点回答'])assert.ok(facts.some(f=>f.text===value),value);
 assert.ok(facts.length<=12);assert.ok(Buffer.byteLength(encoded,'utf8')<=2400);assert.ok(Buffer.byteLength(context,'utf8')<=3072);
});
test('quoted/third-party/question/negative/joke/hypothetical/temporary inputs never become positive facts',()=>{
 const inputs=['我朋友常住上海','他说我常住上海','“我常住上海”','> 我常住上海','我住在上海吗','我常住上海？','我不喜欢摄影','我不是住在上海','如果我住在上海','我常住上海，开玩笑的','我常住上海哈哈','我最近住在上海','我在上海出差','我暂住上海','我计划定居上海','我常住上海，不要记下来','<user>我常住上海</user>','我住在上海吧','我的同事喜欢摄影','我希望喜欢摄影'];
 for(const text of inputs)assert.equal(extractFacts(text).candidates.length,0,text);
});
test('secrets and sensitive raw sources are rejected as a whole before persistence',async()=>{
 const f=fixture(),c=createFactMemoryController(f.api);f.seed(enable());
 const inputs=['我常住上海，我的密码是 synthetic-secret-723','我常住上海，token=synthetic-token','我常住上海，身份证 110101199901010018','我常住上海，收入三万元','我常住上海，我被诊断抑郁','我喜欢摄影，api_key=synthetic-key'];
 for(const [i,text] of inputs.entries()){assert.equal(safeInput(text),false);c.enqueue(envelope(p,[message(text,'secret'+i)]));}
 await c.settle();assert.deepEqual(f.read().facts,{});
 const persisted=f.db.prepare('SELECT value FROM records').all().map(x=>x.value).join('');
 for(const forbidden of ['synthetic-secret','synthetic-token','110101199901010018','三万元','抑郁','synthetic-key'])assert.equal(persisted.includes(forbidden),false);
 assert.equal(c.stats.filtered,inputs.length);f.close();
});
test('each user must opt in and one user cannot supply another user consent',async()=>{
 const b=peer('primary','synthetic-bob'),f=fixture({peers:[p,b]}),c=createFactMemoryController(f.api);f.seed(enable(),p);
 c.enqueue(envelope(p,[message('我常住上海','alice')]));c.enqueue(envelope(b,[message('我常住北京','bob')]));await c.settle();
 assert.deepEqual(values(f.read(p)),['上海']);assert.deepEqual(f.read(b).facts,{});
 assert.throws(()=>transition(defaults(),{action:'fact.auto.enable',requestId:'model',value:{noticeVersion:1}},{kind:'model'},now),/Explicit user/);
 assert.throws(()=>transition(defaults(),{action:'fact.auto.enable',requestId:'wrong-notice',value:{noticeVersion:0}},userSource(p),now),/notice/);f.close();
});
test('account+sender isolation, even with the same sender or same upstream message id',async()=>{
 const otherAccount=peer('secondary',p.sender),otherSender=peer('primary','synthetic-bob'),f=fixture({peers:[p,otherAccount,otherSender]}),c=createFactMemoryController(f.api);
 for(const who of [p,otherAccount,otherSender])f.seed(enable(defaults(),who),who);
 for(const [who,city] of [[p,'上海'],[otherAccount,'北京'],[otherSender,'杭州']])c.enqueue(envelope(who,[message('我常住'+city,'same-upstream-id')]));
 await c.settle();assert.deepEqual([p,otherAccount,otherSender].map(w=>values(f.read(w))),[['上海'],['北京'],['杭州']]);
 assert.throws(()=>c.enqueue({...envelope(p,[message('我常住深圳')]),sender:otherSender.sender}),/Verified private/);f.close();
});
test('duplicates are idempotent, corrections win by source time, delayed facts cannot overwrite',()=>{
 let s=enable(defaults(),p,now-100);
 s=apply(s,'我常住上海','original',now);const revision=s.revision,serialized=JSON.stringify(s);
 s=apply(s,'我常住上海','original',now);assert.equal(s.revision,revision);assert.equal(JSON.stringify(s),serialized);
 s=apply(s,'我常住北京','corrected',now+20);s=apply(s,'我常住上海','late',now+10);assert.deepEqual(values(s),['北京']);
 assert.equal(s.facts['auto:profile.city'].sourceMessageId,'corrected');assert.equal(s.facts['auto:profile.city'].revision,2);
});
test('explicit negative withdrawal removes the earlier positive hobby without storing a negative fact',()=>{
 let s=apply(enable(defaults(),p,now-100),'我喜欢摄影','likes',now);
 s=apply(s,'我不再喜欢摄影了','stop',now+10);assert.deepEqual(s.facts,{});assert.ok(s.factTombstones['interest.photography']);
 s=apply(s,'我喜欢摄影','delayed-like',now+5);assert.deepEqual(s.facts,{});
});
test('delete tombstones survive restart and block unseen older ingress and old request receipts',async()=>{
 const f=fixture(),c=createFactMemoryController(f.api);f.seed(enable());c.enqueue(envelope(p,[message('我常住上海','before-delete',now)]));await c.settle();
 let s=f.read(),fact=s.facts['auto:profile.city'];
 let result=transition(s,{action:'fact.delete.prepare',id:fact.id,expectedRevision:fact.revision,requestId:'prepare'},userSource(p),now+20);
 result=transition(result.state,{action:'fact.delete.confirm',id:fact.id,expectedRevision:fact.revision,requestId:'delete',value:{nonce:result.result.nonce}},userSource(p),now+30);f.seed(result.state);
 const database=f.database;f.close();const reopened=fixture({path:database}),afterRestart=createFactMemoryController(reopened.api,{clock:()=>now+40});
 afterRestart.enqueue(envelope(p,[message('我常住上海','unseen-old',now+10),message('我常住上海','before-delete',now)]));await afterRestart.settle();assert.deepEqual(reopened.read().facts,{});
 afterRestart.enqueue(envelope(p,[message('我常住北京','new-explicit-statement',now+35)]));await afterRestart.settle();assert.deepEqual(values(reopened.read()),['北京']);reopened.close();
});
test('web corrections maintain normalized metadata and reject delayed queued auto updates',()=>{
 let s=apply(enable(defaults(),p,now-100),'我常住上海','first',now),fact=s.facts['auto:profile.city'];
 s=transition(s,{action:'fact.correct',id:fact.id,expectedRevision:fact.revision,requestId:'correct',value:{text:'常住城市：北京'}},userSource(p),now+20).state;
 s=apply(s,'我常住深圳','late',now+10);assert.deepEqual(values(s),['北京']);assert.equal(s.facts[fact.id].text,'常住城市：北京');
 s=transition(s,{action:'fact.correct',id:fact.id,expectedRevision:2,requestId:'unstructured',value:{text:'这是一条本人手工备注'}},userSource(p),now+30).state;
 s=apply(s,'我常住上海','older-unseen',now+25);assert.equal(Object.values(s.facts).length,1);assert.equal(s.facts[fact.id].text,'这是一条本人手工备注');assert.ok(s.factTombstones['profile.city']);
});
test('low confidence city needs an explicit current本人 choice, then deletion prevents stale confirmation',()=>{
 let s=apply(enable(defaults(),p,now-100),'我在上海','ambiguous',now);assert.deepEqual(s.facts,{});
 let candidate=Object.values(s.factSuggestions)[0];assert.equal(candidate.status,'awaiting_confirmation');
 assert.throws(()=>transition(s,{action:'fact.auto.confirm',id:candidate.id,expectedRevision:1,requestId:'fake-confirm'},{kind:'model'},now+1),/Explicit user/);
 s=transition(s,{action:'fact.auto.confirm',id:candidate.id,expectedRevision:1,requestId:'user-confirm'},userSource(p),now+1).state;assert.deepEqual(values(s),['上海']);assert.equal(s.facts['auto:profile.city'].confidence,1);
 s=apply(s,'我在北京','new-ambiguous',now+2);candidate=Object.values(s.factSuggestions)[0];
 const fact=s.facts['auto:profile.city'];let result=transition(s,{action:'fact.delete.prepare',id:fact.id,expectedRevision:1,requestId:'prep'},userSource(p),now+3);
 s=transition(result.state,{action:'fact.delete.confirm',id:fact.id,expectedRevision:1,requestId:'del',value:{nonce:result.result.nonce}},userSource(p),now+4).state;
 assert.throws(()=>transition(s,{action:'fact.auto.confirm',id:candidate.id,expectedRevision:1,requestId:'stale-confirm'},userSource(p),now+5),/missing|deleted/);
});
test('new-user disclosure and city question occur once, refusals and off stop further nudges',()=>{
 let s=defaults(),result=factContextTransition(s,{casual:true,messageId:'first'},now);s=result.state;assert.match(result.context,/回复“可以”/);assert.doesNotMatch(result.context,/\/fish-/);
 assert.equal(factContextTransition(s,{casual:true,messageId:'first'},now).context,result.context);
 assert.equal(factContextTransition(s,{casual:true,messageId:'second'},now).context,null);
 s=enable(s,p,now-100);for(let n=0;n<3;n++)s=apply(s,'随便聊聊','casual'+n,now+n);
 result=factContextTransition(s,{casual:true,messageId:'ask'},now+4);s=result.state;assert.match(result.context,/常住哪个城市/);
 assert.match(factContextTransition(s,{casual:true,messageId:'ask'},now+5).context,/常住哪个城市/);
 assert.equal(factContextTransition(s,{casual:true,messageId:'again'},now+6).context,null);
 s=apply(s,'不想说','decline',now+7);assert.equal(s.autoFactMemory.city.status,'declined');assert.equal(factContextTransition(s,{casual:true,messageId:'after-decline'},now+8).context,null);
 s=transition(s,{action:'fact.auto.disable',requestId:'off'},userSource(p),now+9).state;
 s=apply(s,'我常住杭州','after-off',now+10);assert.deepEqual(s.facts,{});assert.equal(factContextTransition(s,{casual:true,messageId:'off-turn'},now+11).context,null);
});
test('a bare city answer is only a candidate after the one city question, and refusal clears it',()=>{
 let s=enable(defaults(),p,now-100);s=apply(s,'上海','unprompted',now);assert.deepEqual(s.facts,{});assert.deepEqual(s.factSuggestions,{});
 s.autoFactMemory.city={status:'asked',at:now,messageId:'asked'};
 s=apply(s,'上海','answer',now+1);assert.deepEqual(s.facts,{});assert.equal(Object.values(s.factSuggestions)[0].value,'上海');
 s=apply(s,'我不想说','refusal',now+2);assert.deepEqual(s.factSuggestions,{});assert.equal(factContextTransition(s,{casual:true,messageId:'later'},now+3).context,null);
});
test('unclear negation or joking blocks positive extraction, explicit corrections still update',()=>{
 for(const text of ['我住在上海，但不是长期','我常住上海，骗你的','我常住上海😂'])assert.deepEqual(extractFacts(text).candidates,[]);
 let s=apply(enable(defaults(),p,now-100),'我常住上海','original',now);
 s=apply(s,'我不住上海了，我现在常住北京','correction',now+1);assert.deepEqual(values(s),['北京']);
});
test('recall appears on later factual questions, belongs to the current user, and is bounded',async()=>{
 const f=fixture(),c=createFactMemoryController(f.api);f.seed(apply(enable(defaults(),p,now-100),'我常住上海，我喜欢摄影','recorded',now));
 const ctx={channel:'openclaw-weixin',accountId:p.account,senderId:p.sender,agentId:p.id,sessionKey:p.sessionKey,inputProvenance:{kind:'external_user'},hookInvocation:{assertActive(){}},assertMemoryAudienceCurrent(){}};
 const event={currentUserMessageId:'next-turn',currentUserMessage:'我住在哪里？'};
 const result=await c.context(event,ctx);assert.match(result.appendContext,/常住城市：上海/);assert.match(result.appendContext,/recorded/);assert.match(result.appendContext,/不构成操作授权/);assert.ok(result.appendContext.length<3500);
 assert.equal(await c.context(event,{...ctx,inputProvenance:{kind:'internal_system'}}),undefined);
 assert.equal(await c.context(event,{...ctx,inputProvenance:{kind:'inter_session'}}),undefined);
 assert.equal(await c.context(event,{...ctx,hookInvocation:null}),undefined);f.close();
});
test('CAS contention preserves independent changes and authority revocation prevents writes',async()=>{
 const f=fixture(),c=createFactMemoryController(f.api);f.seed(enable());f.conflict();c.enqueue(envelope(p,[message('我常住上海')]));await c.settle();assert.equal(f.read().independentWriter,true);assert.deepEqual(values(f.read()),['上海']);
 let allowed=true;c.enqueue(envelope(p,[message('我常住北京','revoked')],()=>{if(!allowed)throw Error('revoked')}));allowed=false;await c.settle();assert.deepEqual(values(f.read()),['上海']);assert.equal(c.stats.failed,1);
 assert.equal(f.logs.some(x=>x.includes('北京')),false);f.close();
});
test('host conversation permission must be explicitly granted independently of user opt-in',async()=>{
 const f=fixture(),c=createFactMemoryController(f.api);f.seed(enable());delete f.config.plugins.entries['dafeiyu-domain'].hooks;
 assert.throws(()=>c.enqueue(envelope(p,[message('我常住上海')])),/has not been approved/);assert.deepEqual(f.read().facts,{});f.close();
});
test('replay ledger is bounded and pruned old identities cannot resurrect forgotten slots',()=>{
 let s=enable(defaults(),p,now-100);
 for(let n=0;n<520;n++)s=apply(s,'随便聊聊','turn'+n,now+n);
 assert.equal(Object.keys(s.autoFactMemory.seen).length,512);assert.ok(s.autoFactMemory.replayFloor>=now+7);
 s=apply(s,'我常住上海','turn0',now);assert.deepEqual(s.facts,{});
});
