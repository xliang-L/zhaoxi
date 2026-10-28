import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {registerFactMemory} from '../../extensions/dafeiyu-domain/memory/fact-hooks.mjs';
import {registerControls} from '../../extensions/dafeiyu-domain/core/controls.mjs';
import {transition} from '../../extensions/dafeiyu-domain/core/domain.mjs';
import {createBoundDomainService} from '../../extensions/dafeiyu-domain/core/service.mjs';
import {peer,fixture,enable,userSource,hookRuntime,loadChannelSource,hostRoot} from './fact-test-fixtures.mjs';
const p=peer();
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const raw=(text,id,at=Date.now())=>({message_id:id,from_user_id:p.sender,create_time_ms:at,message_type:1,item_list:[{type:1,text_item:{text}}]});
const monitorEntry=process.env.ZHAOXI_TEST_INGRESS_MODULE??'monitor/ingress.ts';
async function channelHarness(f){
 const facts=registerFactMemory(f.api);registerControls(f.api);
 const {module:auth,url:authURL}=await loadChannelSource('messaging/authorization.ts');
 const {module:route,url:routeURL}=await loadChannelSource('messaging/private-route.ts');
 const {module:factIngress,url:factURL}=await loadChannelSource('messaging/fact-ingress.ts');
 const {url:bubblesURL}=await loadChannelSource('messaging/reply-bubbles.ts');
 const capture={model:[],sends:[],outbound:[],sent:[],sendOptions:[],adoptions:0,frameworkAllowed:true,allow:[p.sender],mediaDownloads:new Map()};
 const require=createRequire(hostRoot+'/package.json');
 const {bindIngressLifecycleToReplyOptions}=await import(pathToFileURL(require.resolve('openclaw/plugin-sdk/channel-outbound')));
 const io=()=>{throw Error('Unexpected external I/O in synthetic fixture')};
 const logger={debug(){},info(){},warn(){},error(){}};
 const mocks={
  'openclaw/plugin-sdk/channel-outbound':{bindIngressLifecycleToReplyOptions},
  'openclaw/plugin-sdk/gateway-runtime':{callGatewayFromCli:async(method,_options,params)=>{
   assert.equal(method,'dafeiyu.businessChat');let result;
   await f.methods[method]({params,hasCurrentClientAuthority:()=>true,respond:(ok,value,error)=>{if(!ok)throw Error(error.message);result=value}});return result;
  }},
  'openclaw/plugin-sdk/temp-path':{resolvePreferredOpenClawTmpDir:()=>f.directory},
  '../api/api.js':{sendTyping:io},'../api/types.js':{MessageItemType:{TEXT:1,IMAGE:2,VOICE:3,FILE:4,VIDEO:5},TypingStatus:{TYPING:1,CANCEL:2}},
  '../auth/accounts.js':{loadWeixinAccount:()=>({userId:p.sender})},'../auth/pairing.js':{readFrameworkAllowFromList:()=>capture.allow},
  '../cdn/upload.js':{downloadRemoteImageToTemp:io},'../config/reply-progress.js':{resolveReplyProgressMessagesEnabled:()=>false},
  '../media/media-download.js':{downloadMediaFromItem:async item=>capture.mediaDownloads.has(item.msg_id)?capture.mediaDownloads.get(item.msg_id):io()},'../util/logger.js':{logger},'../util/redact.js':{redactBody:()=>'',redactToken:()=>''},
  './debug-mode.js':{isDebugMode:()=>false},'./error-notice.js':{sendWeixinErrorNotice:io},
  './outbound-hooks.js':{applyWeixinMessageSendingHook:async args=>({cancelled:capture.cancel===true,text:args.text}),emitWeixinMessageSent:args=>capture.sent.push(args)},
  './inbound.js':{setContextToken:io,weixinMessageToMsgContext:(m,account)=>({Body:m.item_list.map(i=>i.text_item?.text??'').join('\n'),RawBody:m.item_list.map(i=>i.text_item?.text??'').join('\n'),From:m.from_user_id,To:m.from_user_id,SenderId:m.from_user_id,AccountId:account,MessageSid:m.message_id,Timestamp:m.create_time_ms}),getContextTokenFromMsgContext:()=>undefined,getWeixinMessageId:m=>m.message_id,isMediaItem:()=>false,resolveStoredQuoteContext(){}},
  './send-media.js':{sendWeixinMediaFile:io},'./markdown-filter.js':{StreamingMarkdownFilter:class{feed(text){return text}flush(){return ''}}},
  './send.js':{sendMessageWeixin:async args=>{capture.sends.push(args.text);capture.sendOptions.push(args);await capture.afterSend?.(args);return {messageId:'synthetic-'+capture.sends.length,platformAccepted:true}}},'./reply-progress-sender.js':{WeixinReplyProgressSender:class{}},
  './dispatch-options.js':{withPublishedModelRuntime:args=>args},'./typing.js':{loadTypingCallbacksFactory:async()=>()=>({})},
  './quote-store.js':{getActiveQuoteMediaSubdir:()=>undefined,getQuoteStore:()=>undefined},'./slash-commands.js':{handleSlashCommand:async()=>({handled:false})},
 };
 const {module:entry}=await loadChannelSource('messaging/process-message.ts',mocks,{'./private-route.js':routeURL,'./authorization.js':authURL,'./fact-ingress.js':factURL,'./reply-bubbles.js':bubblesURL});
 const channelRuntime={media:{saveMediaBuffer:io},routing:{resolveAgentRoute:()=>({agentId:p.id,sessionKey:p.sessionKey,mainSessionKey:p.sessionKey,accountId:p.account,dmScope:'per-account-channel-peer'})},commands:{shouldComputeCommandAuthorized:()=>false},inbound:{ingress:{resolve:async input=>{assert.equal(input.subject.stableId,p.sender);assert.equal(input.contextBinding.agentId,p.id);return {senderAccess:{allowed:capture.frameworkAllowed},commandAccess:{authorized:false}};}},buildContext:input=>({...input.extra,SenderId:input.sender.id,AccountId:input.accountId,RawBody:input.message.rawBody,Body:input.message.body})},session:{resolveStorePath:()=>f.directory,recordInboundSession:async()=>{}},reply:{resolveHumanDelayConfig:()=>undefined,createReplyDispatcherWithTyping:options=>{capture.deliver=options.deliver;return {dispatcher:{},replyOptions:{},markDispatchIdle(){}}},withReplyDispatcher:({run})=>run(),dispatchReplyFromConfig:async args=>{
  const ctx=args.ctx;const prepared=f.config.plugins.entries['dafeiyu-domain'].hooks.allowConversationAccess===true?await f.typed.before_prompt_build({currentUserMessageId:ctx.MessageSid,currentUserMessage:ctx.RawBody,messages:[],prompt:ctx.Body},{channel:'openclaw-weixin',accountId:ctx.AccountId,senderId:ctx.SenderId,agentId:p.id,sessionKey:ctx.SessionKey,inputProvenance:ctx.InputProvenance,hookInvocation:{assertActive(){}},assertMemoryAudienceCurrent(){}}):undefined;
  const read=await prepared?.ephemeralContext?.({hookInvocation:{assertActive(){}}});const enrichment=read?{appendContext:read.text}:undefined;
  await args.replyOptions.turnAdoptionLifecycle?.onAdopted();
  capture.model.push({ctx,enrichment});
  for(const payload of capture.outbound)await capture.deliver(payload);
 }}};
 const lifecycle={abortSignal:new AbortController().signal,onAdopted:async()=>{capture.adoptions++},onDeferred(){},onDeferredHeartbeat(){},onAbandoned:async()=>{},onFailed:async()=>{},readLaneBacklog:async()=>[]};
 const process=(message,sources,ingressLifecycle=lifecycle)=>entry.processOneMessage(message,{accountId:p.account,config:f.config,channelRuntime,baseUrl:'https://synthetic.invalid',cdnBaseUrl:'https://synthetic.invalid',log(){},errLog(){},ingressLifecycle,...(sources?{factSourceMessages:sources}:{})});
 return {process,facts,capture,lifecycle,auth,route,factIngress};
}
test('actual channel entry refuses unauthenticated and third-party ingress before the memory hook',async()=>{
 hookRuntime.clearInternalHooks();const f=fixture(),h=await channelHarness(f);f.seed(enable());
 h.capture.frameworkAllowed=false;await h.process(raw('我常住上海','denied-framework'));await h.facts.settle();assert.deepEqual(f.read().facts,{});assert.equal(h.capture.model.length,0);
 h.capture.frameworkAllowed=true;await h.process({...raw('我常住上海','wrong-sender'),from_user_id:'synthetic-mallory'});await h.facts.settle();assert.deepEqual(f.read().facts,{});
 await h.process({...raw('我常住上海','group'),group_id:'synthetic-group'});await h.facts.settle();assert.deepEqual(f.read().facts,{});f.close();
});
test('actual channel hook keeps original batch source IDs, avoids quotes/media/bot text and feeds later recall',async()=>{
 hookRuntime.clearInternalHooks();const f=fixture(),h=await channelHarness(f);f.seed(enable());
 const t=Date.now(),first=raw('我常住上海','original-city',t),second=raw('我喜欢摄影','original-interest',t+1);
 await h.process({...second,item_list:[{type:1,text_item:{text:'我常住上海\n我喜欢摄影'}}]},[{message:first,receivedAt:t},{message:second,receivedAt:t+1}]);await h.facts.settle();
 const facts=Object.values(f.read().facts);assert.equal(facts.find(x=>x.value==='上海').sourceMessageId,'original-city');assert.equal(facts.find(x=>x.value==='photography').sourceMessageId,'original-interest');
 for(const m of [{...raw('我常住北京','quoted'),item_list:[{type:1,text_item:{text:'我常住北京'},ref_msg:{title:'someone else'}}]},{...raw('我常住北京','bot'),message_type:2},{...raw('我常住北京','media'),item_list:[{type:1,text_item:{text:'我常住北京'}},{type:2}]}])h.factIngress.emitVerifiedFactIngress({...p,sources:[{message:m,receivedAt:Date.now()}],assertAdmissionCurrent(){}});
 await h.facts.settle();assert.equal(f.read().facts['auto:profile.city'].value,'上海');
 await h.process(raw('我住在哪里？','later-question',Date.now()));await h.facts.settle();
 assert.match(h.capture.model.at(-1).enrichment.appendContext,/常住城市：上海/);assert.equal(h.capture.model.at(-1).ctx.InputProvenance.kind,'external_user');assert.equal(h.capture.sends.length,0);f.close();
});
test('actual authenticated chat opt-in/off commands do not enable proactive delivery',async()=>{
 hookRuntime.clearInternalHooks();const f=fixture(),h=await channelHarness(f);
 await h.process(raw('/fish-memory-on','opt-in'));assert.equal(f.read().autoFactMemory.enabled,true);assert.match(h.capture.sends.at(-1),/不存密码/);assert.equal(f.read().preferences.enabled,false);assert.equal(f.read().businessScheduler?.enabled??false,false);
 await h.process(raw('我常住杭州','after-opt-in',Date.now()+2));await h.facts.settle();assert.equal(f.read().facts['auto:profile.city'].value,'杭州');
 await h.process(raw('/fish-memory-off','opt-out'));await h.process(raw('我常住北京','after-opt-out',Date.now()+3));await h.facts.settle();assert.equal(f.read().facts['auto:profile.city'].value,'杭州');assert.equal(h.capture.model.at(-1).enrichment,undefined);f.close();
});
test('actual channel saves a naturally approved memory and supplies the committed acknowledgement to the model',async()=>{
 hookRuntime.clearInternalHooks();const f=fixture(),h=await channelHarness(f);f.seed(enable());
 try{
  await h.process(raw('我在北京','spoken-city'));await h.facts.settle();
  assert.match(h.capture.model.at(-1).enrichment.appendContext,/常住城市：北京/);
  assert.doesNotMatch(h.capture.model.at(-1).enrichment.appendContext,/\/fish-memory-confirm/);
  await new Promise(resolve=>setTimeout(resolve,3));
  await h.process(raw('好，记住吧','spoken-approval'));await h.facts.settle();
  assert.equal(f.read().facts['auto:profile.city'].value,'北京');
  assert.equal(f.read().facts['auto:profile.city'].source.confirmation.messageId,'spoken-approval');
  assert.match(h.capture.model.at(-1).enrichment.appendContext,/已保存.*北京/);
  assert.doesNotMatch(h.capture.model.at(-1).enrichment.appendContext,/\/fish-/);
  assert.equal(f.read().preferences.enabled,false);
 }finally{f.close();}
});
test('actual channel processes plan approval and refusal before model quota without exposing commands',async()=>{
 hookRuntime.clearInternalHooks();const f=fixture(),h=await channelHarness(f);
 f.config.plugins.entries['zhaoxi-native']={config:{quotaEnabled:true}};
 try{
  const service=createBoundDomainService(f.api,p,()=>{},{kind:'authenticated-user',sessionKey:p.sessionKey,runId:'native-proposal'});
  await service.propose({action:'plan.create',id:'native-reminder',requestId:'native-create',value:{title:'喝水',kind:'reminder',timezone:'Asia/Shanghai',dueAt:new Date(Date.now()+60000).toISOString()}});
  await new Promise(resolve=>setTimeout(resolve,3));
  await h.process(raw('同意','native-approval'));
  assert.equal(f.read().plans['native-reminder'].status,'active');assert.equal(h.capture.model.length,0);
  assert.match(h.capture.sends.at(-1),/已按你同意.*喝水/s);assert.doesNotMatch(h.capture.sends.at(-1),/\/fish-/);
  const old=f.read().plans['native-reminder'];
  await service.propose({action:'plan.cancel',id:old.id,expectedRevision:old.revision,requestId:'native-cancel'});
  await new Promise(resolve=>setTimeout(resolve,3));await h.process(raw('先不用','native-refusal'));
  assert.equal(f.read().plans[old.id].status,'active');assert.equal(h.capture.model.length,0);assert.match(h.capture.sends.at(-1),/先不处理/);
 }finally{f.close();}
});
test('actual channel sends three independent bubbles from one model response and one logical receipt',async()=>{
 hookRuntime.clearInternalHooks();const f=fixture(),h=await channelHarness(f);
 try{
  h.capture.outbound=[{text:'来了。\n\n怎么啦？\n\n我在听。'}];
  await h.process(raw('分三条跟我打个招呼','bubble-three'));
  assert.equal(h.capture.model.length,1);assert.deepEqual(h.capture.sends,['来了。','怎么啦？','我在听。']);
  assert.equal(h.capture.sent.length,1);assert.equal(h.capture.sent[0].success,true);
  assert.equal(h.capture.sent[0].content,h.capture.outbound[0].text);
  assert.ok(h.capture.sendOptions.every(args=>args.to===p.sender&&args.opts.accountId===p.account));
  h.capture.sends=[];h.capture.outbound=[{text:'第一句。\n\n第二句。'}];
  await h.process(raw('只发一条','bubble-one'));assert.deepEqual(h.capture.sends,['第一句。\n\n第二句。']);
 }finally{f.close();}
});
test('partial bubble failure stops the rest and does not claim the entire reply was unsent',async()=>{
 hookRuntime.clearInternalHooks();const f=fixture(),h=await channelHarness(f);
 try{
  h.capture.outbound=[{text:'第一句。\n\n第二句。\n\n第三句。'}];
  const original=Object.assign(new Error('synthetic retryable no send'),{retryableNoSend:true});
  h.capture.afterSend=()=>{if(h.capture.sends.length===2)throw original};
  await assert.rejects(()=>h.process(raw('连续发三条消息','bubble-failure')),error=>{
   assert.notEqual(error,original);assert.equal(error.cause,undefined);assert.equal(error.retryableNoSend,undefined);assert.match(error.message,/已有部分内容发送/);return true;
  });
  assert.equal(h.capture.model.length,1);assert.equal(h.capture.sends.length,2);
  assert.equal(h.capture.sent.length,1);assert.equal(h.capture.sent[0].success,false);
 }finally{f.close();}
});
test('a revoked or aborted private route prevents subsequent bubbles',async()=>{
 for(const abort of [false,true]){
  hookRuntime.clearInternalHooks();const f=fixture(),h=await channelHarness(f),controller=new AbortController();
  try{
   h.capture.outbound=[{text:'甲\n\n乙\n\n丙'}];
   h.capture.afterSend=()=>{if(abort)controller.abort();else f.config.bindings=[]};
   await assert.rejects(()=>h.process(raw('分三条','bubble-revoked'),undefined,{...h.lifecycle,abortSignal:controller.signal}),/已有部分内容发送/);
   assert.deepEqual(h.capture.sends,['甲']);
  }finally{f.close();}
 }
});
test('a sending-hook cancellation sends no bubbles',async()=>{
 hookRuntime.clearInternalHooks();const f=fixture(),h=await channelHarness(f);
 try{
  h.capture.cancel=true;h.capture.outbound=[{text:'甲\n\n乙'}];
  await h.process(raw('在吗','bubble-cancel'));assert.deepEqual(h.capture.sends,[]);assert.deepEqual(h.capture.sent,[]);
 }finally{f.close();}
});
test('actual channel cannot adopt when the local fact commit is unconfirmed',async()=>{
 hookRuntime.clearInternalHooks();const f=fixture(),h=await channelHarness(f);f.seed(enable());
 const open=f.api.runtime.state.openKeyedStoreV2;
 f.api.runtime.state.openKeyedStoreV2=(...args)=>{const store=open(...args);return {...store,compareAndApply:async()=>{throw Error('Synthetic storage outage')}}};
 await assert.rejects(()=>h.process(raw('我常住上海','unconfirmed')),/Fact commit unconfirmed/);
 assert.equal(h.capture.adoptions,0);assert.equal(h.capture.model.length,0);assert.deepEqual(f.read().facts,{});f.close();
});
test('known host/internal disable settles the source without queuing fact extraction',async()=>{
 hookRuntime.clearInternalHooks();const f=fixture(),h=await channelHarness(f);
 f.config.plugins.entries['dafeiyu-domain'].hooks.allowConversationAccess=false;
 await h.process(raw('我常住上海','host-off'));assert.equal(h.capture.adoptions,1);assert.equal(h.facts.stats.accepted,0);
 f.config.plugins.entries['dafeiyu-domain'].hooks.allowConversationAccess=true;f.config.hooks={internal:{enabled:false}};
 await h.process(raw('我常住北京','internal-off'));assert.equal(h.capture.adoptions,2);assert.equal(h.facts.stats.accepted,0);assert.deepEqual(f.read().facts,{});f.close();
});
test('the existing 1.2s idle and busy serial batch path stays intact and carries raw attribution',async()=>{
 const require=createRequire(hostRoot+'/package.json');
 const sourceURL=pathToFileURL(require.resolve('openclaw/plugin-sdk/channel-inbound-debounce')).href;
 const lifecycle={abortSignal:new AbortController().signal,onAdopted:async()=>{},onDeferred(){},onDeferredHeartbeat(){},onAbandoned:async()=>{},onFailed:async()=>{},onCancelled:async()=>{},readLaneBacklog:async()=>[]};
 const mocks={'openclaw/plugin-sdk/channel-outbound':{createChannelIngressMonitor:options=>({start(){},async admit(message,{receivedAt}){if(!options.inspect(message))return {accepted:false};return options.deliver(message,lifecycle,{receivedAt})},async stop(){}})}};
 const {module:{createWeixinIngress}}=await loadChannelSource(monitorEntry,mocks,{'openclaw/plugin-sdk/channel-inbound-debounce':sourceURL});
 let releaseFirst,resolveFirst,resolveSecond,active=0,maxActive=0;const batches=[];
 const firstStarted=new Promise(resolve=>resolveFirst=resolve),secondCompleted=new Promise(resolve=>resolveSecond=resolve),held=new Promise(resolve=>releaseFirst=resolve);
 const start=Date.now();const ingress=createWeixinIngress({accountId:p.account,allowFrom:[p.sender],queue:{},onError:error=>{throw error},dispatch:async(full,_life,sources)=>{
  active++;maxActive=Math.max(maxActive,active);batches.push({full,sources,at:Date.now()});
  if(batches.length===1){resolveFirst();await held;}else resolveSecond();active--;
 }});
 await ingress.admitBatch([raw('我常住上海','batch-first')]);await firstStarted;assert.ok(batches[0].at-start>=1100);
 await ingress.admitBatch([raw('我喜欢摄影','batch-second'),raw('我喜欢回复简短','batch-third')]);assert.equal(batches.length,1);releaseFirst();await secondCompleted;await tick();
 assert.equal(maxActive,1);assert.equal(batches.length,2);assert.deepEqual(batches[1].sources.map(s=>s.message.message_id),['batch-second','batch-third']);assert.match(batches[1].full.item_list[0].text_item.text,/摄影\n我喜欢回复简短/);await ingress.stop();
});
for(const choice of ['delete','new-consent'])test('recovered undated native input preserves admission time after '+choice,{timeout:20000},async()=>{
 hookRuntime.clearInternalHooks();const f=fixture(),h=await channelHarness(f);
 const require=createRequire(hostRoot+'/package.json');
 const debounceURL=pathToFileURL(require.resolve('openclaw/plugin-sdk/channel-inbound-debounce')).href;
 // Mirror the native monitor's persisted-payload/claim contract in a local SQLite fixture.
 // Actual channel batching, processOneMessage, fact ingress, hooks, and fact writes run below.
 f.db.exec('CREATE TABLE native_pending(id TEXT PRIMARY KEY,payload TEXT,received_at INTEGER,status TEXT)');
 const mocks={'openclaw/plugin-sdk/channel-outbound':{createChannelIngressMonitor:options=>({
  async admit(message,{receivedAt}){
   const facts=options.inspect(message);if(!facts)return {kind:'ignored'};
   const payload=options.payload.encode({version:1,body:options.payload.serialize(message,{facts,receivedAt})});
   f.db.prepare('INSERT INTO native_pending VALUES(?,?,?,?)').run(facts.eventId,JSON.stringify(payload),receivedAt,'pending');
   return {kind:'durable',queueResult:{record:{receivedAt}}};
  },
  start(){for(const row of f.db.prepare("SELECT * FROM native_pending WHERE status='pending'").all()){
   const claim={id:row.id,receivedAt:row.received_at,payload:JSON.parse(row.payload)};
   const decoded=options.payload.decode(claim.payload,{claim}),message=options.payload.deserialize(decoded.body,{claim});
   assert.equal(options.inspect(message).eventId,claim.id);
   options.deliver(message,{abortSignal:new AbortController().signal,onDeferred(){},onDeferredHeartbeat(){},onAbandoned(){},readLaneBacklog:async()=>[],onAdopted:async()=>{f.db.prepare("UPDATE native_pending SET status='completed' WHERE id=?").run(row.id)}},claim);
  }},
  async stop(){},
 })}};
 const {module:{createWeixinIngress}}=await loadChannelSource(monitorEntry,mocks, {'openclaw/plugin-sdk/channel-inbound-debounce':debounceURL});
 let ingress;
 try{
  if(choice==='delete'){f.seed(enable());await h.process(raw('我常住上海','saved-before-delete',Date.now()-100));}
  const original=raw('我常住上海','unseen-undated-source');delete original.create_time_ms;
  ingress=createWeixinIngress({accountId:p.account,allowFrom:[p.sender],queue:{},onError:error=>{throw error},dispatch:async()=>{throw Error('Delivery must wait for recovery')}});
  const [admitted]=await ingress.admitBatch([original]);const receivedAt=admitted.queueResult.record.receivedAt;
  await ingress.stop();
  await new Promise(resolve=>setTimeout(resolve,5));
  if(choice==='delete'){
   const fact=f.read().facts['auto:profile.city'];
   let next=transition(f.read(),{action:'fact.delete.prepare',id:fact.id,expectedRevision:fact.revision,requestId:'undated-delete-prepare'},userSource(p),Date.now());
   next=transition(next.state,{action:'fact.delete.confirm',id:fact.id,expectedRevision:fact.revision,requestId:'undated-delete-confirm',value:{nonce:next.result.nonce}},userSource(p),Date.now());f.seed(next.state);
  }else f.seed(enable(f.read(),p,Date.now()));
  await new Promise(resolve=>setTimeout(resolve,5));
  const delivered=Promise.withResolvers();
  ingress=createWeixinIngress({accountId:p.account,allowFrom:[p.sender],queue:{},debounceMs:0,onError:delivered.reject,dispatch:async(full,lifecycle,sources)=>{
   try{await h.process(full,sources,lifecycle);delivered.resolve(sources);}catch(error){delivered.reject(error);throw error;}
  }});
  ingress.start();const sources=await delivered.promise;await h.facts.settle();
  assert.deepEqual(f.read().facts,{},'an unseen pre-choice source must not resurrect a fact or backfill consent');
  assert.equal(sources[0].receivedAt,receivedAt,'recovery must retain the native queue admission timestamp');
  assert.equal(h.capture.model.length,choice==='delete'?2:1,'ordinary chat still reaches the model');
  assert.equal(f.db.prepare('SELECT status FROM native_pending').get().status,'completed');
 }finally{await ingress?.stop();f.close();}
});

test('actual channel preserves complete text for consent and publishes the authenticated source for matter intake',async()=>{
 hookRuntime.clearInternalHooks();const f=fixture(),h=await channelHarness(f);
 const workspace=f.directory+'/private-workspace';await fs.mkdir(workspace);f.config.agents={entries:{[p.id]:{workspace}}};
 try{
  await h.process(raw('通知：11月5日18点前交实验报告，需要PDF和签字。','notice-source'));
  assert.ok(f.read().matterSources['src-'+Buffer.from('notice-source').toString('base64url')]);
  assert.match(h.capture.model.at(-1).ctx.ChannelPromptContext.join('\n'),/本人资料与事项索引/);
  const svc=createBoundDomainService(f.api,p,()=>{},{kind:'authenticated-user',sessionKey:p.sessionKey,runId:'compound-confirmation'});
  await svc.propose({action:'plan.create',id:'must-not-approve',requestId:'compound-proposal',value:{title:'喝水',kind:'reminder',timezone:'Asia/Shanghai',dueAt:new Date(Date.now()+60000).toISOString()}},Date.now()-10);
  await h.process({...raw('同意','compound-reply'),item_list:[{type:1,text_item:{text:'同意'}},{type:1,text_item:{text:'但是先不要执行，我要修改时间'}}]});
  assert.equal(f.read().plans['must-not-approve'],undefined);
 }finally{f.close()}
});

test('actual intake keeps mixed screenshots and multiple files, names failures and never silently reads beyond eight',async()=>{
 hookRuntime.clearInternalHooks();const f=fixture(),h=await channelHarness(f),workspace=f.directory+'/private-files';await fs.mkdir(workspace);f.config.agents={entries:{[p.id]:{workspace}}};
 try{
  const picture=workspace+'/notice.png',first=workspace+'/proof.txt';await fs.writeFile(picture,'synthetic-image');await fs.writeFile(first,'志愿服务8小时');
  h.capture.mediaDownloads.set('picture',{decryptedPicPath:picture});h.capture.mediaDownloads.set('first',{decryptedFilePath:first,fileMediaType:'text/plain'});h.capture.mediaDownloads.set('missing',{});
  const items=[{type:2,msg_id:'picture',image_item:{media:{full_url:'https://synthetic.invalid/picture'}}},{type:4,msg_id:'first',file_item:{file_name:'志愿证明.txt',media:{full_url:'https://synthetic.invalid/first'}}},{type:4,msg_id:'missing',file_item:{file_name:'报名附件2.pdf',media:{full_url:'https://synthetic.invalid/missing'}}}];
  await h.process({...raw('请保存这组通知与证明','mixed-files'),item_list:[{type:1,text_item:{text:'请保存这组通知与证明'}},...items]});
  const ctx=h.capture.model.at(-1).ctx;assert.equal(ctx.MediaPaths.length,2);assert.deepEqual(ctx.MediaTypes,['image/*','text/plain']);assert.equal(ctx.media[1].fileName,'志愿证明.txt');assert.match(ctx.Body,/报名附件2.pdf.*下载失败/);
  const source=f.read().matterSources['src-'+Buffer.from('mixed-files').toString('base64url')];assert.equal(source.files.length,2);assert.equal(source.files[1].name,'志愿证明.txt');
  const many=[];for(let i=0;i<10;i++){const id='batch-'+i;h.capture.mediaDownloads.set(id,{decryptedFilePath:first,fileMediaType:'text/plain'});many.push({type:4,msg_id:id,file_item:{file_name:'材料'+i+'.txt',media:{full_url:'https://synthetic.invalid/'+id}}})}
  await h.process({...raw('批量附件','many-files'),item_list:many});const limited=h.capture.model.at(-1).ctx;assert.equal(limited.MediaPaths.length,8);assert.match(limited.Body,/前8.*其余未读取/);
 }finally{f.close()}
});
