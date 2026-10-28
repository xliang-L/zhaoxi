import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults,identityId,transition} from '../../extensions/dafeiyu-domain/core/domain.mjs';
import {extractFacts,isNarrativeSource} from '../../extensions/dafeiyu-domain/memory/fact-rules.mjs';
import {factIngressTransition,factContextTransition,factMemoryView} from '../../extensions/dafeiyu-domain/memory/fact-memory.mjs';

const now=1800000000000;
const tenant=sender=>{const account='synthetic',id=identityId(account,sender);return {account,sender,id,sessionKey:`agent:${id}:openclaw-weixin:${account}:direct:${sender}`};};
const a=tenant('alice'),b=tenant('bob');
const enabled=who=>transition(defaults(),{action:'fact.auto.enable',requestId:'explicit-choice',value:{noticeVersion:1}},{consent:'verified-web-choice',account:who.account,sender:who.sender,sessionKey:who.sessionKey},now-100).state;
const record=(state,who,text,id='source',at=now)=>factIngressTransition(state,[{text,messageId:id,sourceAt:at,receivedAt:at}],who,at).state;
const context=(state,text,id='current')=>factContextTransition(state,{messageId:id,messageText:text,casual:false},now+100).context;
const texts=value=>value?JSON.parse(value.split('\n').find(line=>line.startsWith('本人已保存')).slice(value.split('\n').find(line=>line.startsWith('本人已保存')).indexOf('['))).map(f=>f.text):[];

test('current request selects city, interests, and universally applicable reply preference independently',()=>{
 let state=record(enabled(a),a,'我常住上海，我喜欢摄影，我喜欢阅读，我喜欢回复简短');
 assert.deepEqual(texts(context(state,'我住在哪里？')),['常住城市：上海','回复偏好：简短']);
 assert.deepEqual(texts(context(state,'今天天气怎样？')),['常住城市：上海','回复偏好：简短']);
 assert.deepEqual(texts(context(state,'北京天气怎样？')),['回复偏好：简短']);
 assert.deepEqual(texts(context(state,'给我一点摄影建议')),['回复偏好：简短','兴趣：摄影']);
 assert.deepEqual(texts(context(state,'推荐一本书')),['回复偏好：简短','兴趣：阅读']);
 assert.deepEqual(texts(context(state,'周末空闲时做点什么好')),['回复偏好：简短','兴趣：摄影','兴趣：阅读']);
 assert.deepEqual(texts(context(state,'17乘以19等于多少？')),['回复偏好：简短']);
 assert.deepEqual(texts(context(state,undefined)),['回复偏好：简短']);
});

test('an unrelated turn carries no stored facts when no reply preference applies',()=>{
 const state=record(enabled(a),a,'我常住上海，我喜欢摄影');
 assert.equal(context(state,'17乘以19等于多少？'),null);
 assert.equal(context(state,'解释牛顿第二定律'),null);
 assert.equal(context(state,'推荐一把机械键盘'),null);
 assert.equal(context(state,''),null);
});

test('narrative and role requests do not write their first-person clauses as user facts',()=>{
 for(const text of ['写一个故事。我常住上海。我喜欢摄影。','扮演一个旅行家。我常住上海。','这是角色设定：我常住上海。','小说主角自述。我喜欢摄影。','剧本台词。我长期住在杭州。','虚构资料。我希望你以后回复简短。','Roleplay: 我常住上海。']){
  assert.deepEqual(extractFacts(text).candidates,[],text);
  const state=record(enabled(a),a,text);
  assert.deepEqual(state.facts,{},text);
 }
 assert.equal(extractFacts('我常住上海。我喜欢摄影。').candidates.length,2);
});

test('English narrative markers reject same-source facts and hold later turns without matching history',()=>{
 for(const prefix of ['Write a story.','Write fiction.','Pretend to be a traveler.','Imagine this.','Write a novel.','Act as a traveler.','Character notes.','Scenario:']){
  const text=prefix+' 我常住上海。我喜欢摄影。';
  assert.deepEqual(extractFacts(text).candidates,[],prefix);
  let state=record(enabled(a),a,text,'english-role');
  state=record(state,a,'我常住苏州。我喜欢篮球。','english-role-followup',now+1);
  assert.deepEqual(state.facts,{},prefix);
  assert.equal(factMemoryView(state).pauseReason,'narrative-context',prefix);
 }
 assert.equal(isNarrativeSource('Read the history.'),false);
 assert.equal(extractFacts('History facts.\n我常住上海。我喜欢摄影。').candidates.length,2);
});

test('unrecognized weather locations do not receive the home city while bare and deictic requests do',()=>{
 const state=record(enabled(a),a,'我常住上海');
 for(const text of ['巴黎天气怎样？','帮我查一下新德里的气温。'])assert.equal(context(state,text),null,text);
 for(const text of ['天气怎样？','今天天气怎样？','明天天气怎样？','上海天气怎样？','我这里天气怎样？','本地明天气温如何？','今天穿什么？','明天出门该穿什么？'])assert.deepEqual(texts(context(state,text)),['常住城市：上海'],text);
});

test('unknown weather locations after the topic or in a second clause cannot select the home city',()=>{
 const state=record(enabled(a),a,'我常住上海');
 for(const text of ['天气预报查巴黎','天气怎样？我在巴黎','天气查新德里'])assert.equal(context(state,text),null,text);
 for(const text of ['天气预报查上海','天气怎样？我在上海','天气查上海'])assert.deepEqual(texts(context(state,text)),['常住城市：上海'],text);
});

test('narrative entry holds later bare statements and context until an explicit fresh user enable',()=>{
 let state=record(enabled(a),a,'我常住上海，我喜欢摄影，我喜欢回复简短','real-profile');
 const saved=structuredClone(state.facts);
 state=record(state,a,'开始角色扮演，接下来的我是一名旅行家。','role-entry',now+1);
 state=record(state,a,'我常住苏州。','role-city',now+2);
 state=record(state,a,'我喜欢篮球。','role-hobby',now+3);
 assert.deepEqual(state.facts,saved,'role clauses cannot update existing facts or add a new hobby');
 assert.equal(context(state,'我住在哪里？摄影有什么建议？'),null,'held turns cannot inject personal facts');
 assert.equal(factMemoryView(state).pauseReason,'narrative-context');
 state=JSON.parse(JSON.stringify(state));
 state=record(state,a,'我常住苏州。','after-serialization',now+4);
 assert.deepEqual(state.facts,saved);
 assert.throws(()=>transition(state,{action:'fact.auto.enable',requestId:'model-enable',value:{noticeVersion:1}},{kind:'model'},now+5),/Explicit user/);
 assert.equal(factMemoryView(state).pauseReason,'narrative-context');
 state=transition(state,{action:'fact.auto.enable',requestId:'explicit-resume',value:{noticeVersion:1}},{consent:'verified-web-choice',account:a.account,sender:a.sender,sessionKey:a.sessionKey},now+6).state;
 assert.equal(factMemoryView(state).pauseReason,null);
 state=record(state,a,'我常住苏州。','real-after-resume',now+7);
 assert.match(context(state,'我住在哪里？'),/常住城市：苏州/);
 assert.equal(Object.values(state.facts).some(f=>f.value==='basketball'),false);
 state=factIngressTransition(state,[{text:'让我们扮演旅行家',messageId:'delayed-role-entry',sourceAt:now+2,receivedAt:now+8}],a,now+8).state;
 assert.equal(factMemoryView(state).pauseReason,null,'an unseen pre-consent role input cannot reinstate the hold');
});

test('the current narrative request suppresses personal context before an ingress hold is observed',()=>{
 const state=record(enabled(a),a,'我常住上海，我喜欢回复简短');
 const result=factContextTransition(state,{messageId:'prompt-role',messageText:'扮演旅行家，我住在哪里？',casual:false},now+100);
 assert.equal(result.context,null);
 assert.equal(factMemoryView(result.state).pauseReason,'narrative-context');
 assert.equal(context(result.state,'我住在哪里？'),null,'the initial prompt preparation retains the conservative hold');
 assert.match(context(state,'我住在哪里？'),/常住城市：上海/);
});

test('paused memory does not acquire a narrative hold through intake or prompt preparation',()=>{
 const state=record(enabled(a),a,'我常住上海，我喜欢摄影');state.factMemoryPaused=true;
 const fromIntake=record(state,a,'开始角色扮演。我常住苏州。','paused-role',now+1);
 const fromPrompt=factContextTransition(state,{messageId:'paused-prompt-role',messageText:'扮演旅行家，我常住苏州。',casual:true},now+2);
 assert.deepEqual([fromIntake.autoFactMemory.narrativeHold,fromPrompt.state.autoFactMemory.narrativeHold],[null,null]);
 assert.deepEqual(fromIntake.facts,state.facts);assert.deepEqual(fromPrompt.state.facts,state.facts);
 assert.equal(fromIntake.factMemoryPaused,true);assert.equal(fromPrompt.state.factMemoryPaused,true);
 assert.equal(fromPrompt.context,null);
});

test('the full UTF-8 context and its fact payload stay bounded with multibyte source metadata',()=>{
 let state=enabled(a);
 const messages=['我常住上海','我喜欢回复简短','我喜欢回复中文','我喜欢回复分点','我喜欢阅读','我喜欢摄影','我喜欢篮球','我喜欢游泳','我喜欢跑步','我喜欢徒步','我喜欢音乐','我喜欢做饭','我喜欢绘画','我喜欢电子游戏','我喜欢园艺','我喜欢骑行','我喜欢羽毛球','我喜欢电影','我喜欢旅行'];
 for(const [index,text] of messages.entries())state=record(state,a,text,'长'.repeat(180)+index,now+index);
 const result=context(state,'我住在哪里？推荐周末休闲活动，记得我有哪些爱好。');
 const line=result.split('\n').find(value=>value.startsWith('本人已保存'));
 const encoded=line.slice(line.indexOf('['));
 assert.ok(Buffer.byteLength(result,'utf8')<=3072,'all framing and guidance count toward the limit');
 assert.ok(Buffer.byteLength(encoded,'utf8')<=2400,'multibyte provenance must count as UTF-8');
 assert.ok(JSON.parse(encoded).length<=12);
 assert.equal(texts(result)[0],'常住城市：上海');
 const crowded=structuredClone(state);
 crowded.factSuggestions.synthetic={id:'synthetic',text:'常住城市：北京',revision:1,expiresAt:now+1000};
 const withSuggestion=factContextTransition(crowded,{messageId:'suggestion',messageText:'我住在哪里？推荐周末休闲活动',casual:true},now+100).context;
 assert.ok(Buffer.byteLength(withSuggestion,'utf8')<=3072,'candidate prompts share the complete context budget');
});

test('interleaved tenant requests and repeated message IDs never share a context snapshot',async()=>{
 const alice=record(enabled(a),a,'我常住上海，我喜欢摄影');
 const bob=record(enabled(b),b,'我常住杭州，我喜欢阅读');
 const [firstA,firstB,secondA,secondB]=await Promise.all([
  Promise.resolve().then(()=>context(alice,'今天天气怎样？','same-id')),
  Promise.resolve().then(()=>context(bob,'推荐一本书','same-id')),
  Promise.resolve().then(()=>context(alice,'给我一点摄影建议','same-id')),
  Promise.resolve().then(()=>context(bob,'今天天气怎样？','same-id')),
 ]);
 assert.deepEqual(texts(firstA),['常住城市：上海']);
 assert.deepEqual(texts(firstB),['兴趣：阅读']);
 assert.deepEqual(texts(secondA),['兴趣：摄影']);
 assert.deepEqual(texts(secondB),['常住城市：杭州']);
 assert.equal(JSON.stringify(alice).includes('杭州'),false);
 assert.equal(JSON.stringify(bob).includes('上海'),false);
});
