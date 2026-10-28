import {releasedCategories} from './release-policy.mjs';
import {dispatchPrepared} from './guarded-delivery.mjs';
import {refreshProactive} from '../proactive/proactive.mjs';
import {createHash} from 'node:crypto';
import {activityTransition} from '../proactive/greetings.mjs';
import {defaults} from './domain.mjs';
import {businessChat} from './business-chat.mjs';
import {schedulerOperation} from './business-scheduler.mjs';
import {identityId} from './domain.mjs';
import {createBoundDomainService} from './service.mjs';
import {generateGreeting} from '../proactive/character-life.mjs';
import {stageMatterSource,readMatterSource} from '../matters/matter-sources.mjs';
const fail=m=>{throw Error(m)};
function binding(config,account,sender){
 const id=identityId(account,sender);
 if(!config.bindings?.some(b=>b.agentId===id&&b.match?.channel==='openclaw-weixin'&&b.match.accountId===account&&b.match.peer?.kind==='direct'&&b.match.peer.id===sender))fail('Tenant binding revoked');
 return {id,account,sender};
}
export async function control(service,params,consent){
 if(!params||Object.keys(params).some(k=>!['action','id','requestId','expectedRevision','value'].includes(k)))fail('Unknown control fields');
 if(params.action==='list')return service.read();
 if(!['matter.forget','matter.complete','matter.cancel','matter.delete','plan.create','plan.update','interaction.reset','fact.confirm','fact.discard','fact.auto.enable','fact.auto.disable','fact.auto.confirm','reminder.acknowledge','fact.add','fact.correct','fact.delete.prepare','fact.delete.confirm','fact.pause','fact.resume','fact.followup.set','fact.followup.clear','plan.confirm','plan.cancel','plan.complete','plan.delete','plan.postpone','preferences.propose','preferences.confirm','preferences.pause','preferences.disable'].includes(params.action))fail('Unsupported control action');
 if(params.action==='fact.add'){if(!params.value||Object.keys(params.value).some(k=>k!=='text'))fail('Unknown fact fields');params={...params,action:'fact.set',value:{text:params.value.text,confidence:1,sourceKind:'user-stated'}};}
 const result=await service.change(params,{consent});
 if(params.action.startsWith('matter.')||params.action.startsWith('plan.')||['preferences.pause','preferences.disable','preferences.confirm'].includes(params.action))await service.reconcile();
 return result;
}
export function registerControls(api,{proactiveAdapters={},deliveryAdapter,greetingGenerator}={}){
 api.registerGatewayMethod('dafeiyu.document',async options=>{
  try{
   const params=options.params??{};
   if(Object.keys(params).some(k=>!['sourceId','index'].includes(k))||!Number.isInteger(params.index)||params.index<0||params.index>7)fail('请选择原件。');
   const rows=api.runtime.config.current().bindings?.filter(b=>b.match?.channel==='openclaw-weixin'&&b.match.peer?.kind==='direct')??[];
   if(rows.length!==1)fail('当前资料归属无法确认。');
   const b=rows[0],tenant=binding(api.runtime.config.current(),b.match.accountId,b.match.peer.id);
   const assertCurrent=()=>{if(options.hasCurrentClientAuthority?.()!==true)fail('Request expired');binding(api.runtime.config.current(),tenant.account,tenant.sender)};
   const source=await readMatterSource(api,tenant,assertCurrent,params.sourceId,{extract:false});
   const attachment=source.attachments[params.index];
   if(!source.archived||!attachment?.available)fail('原件暂时不可用，请在微信重新转发。');
   assertCurrent();options.respond(true,{path:attachment.path,name:attachment.name,bytes:attachment.bytes});
  }catch(e){options.respond(false,undefined,{code:'INVALID_REQUEST',message:e.message})}
 },{scope:'operator.admin'});
 api.registerGatewayMethod('dafeiyu.activity',async options=>{
  try{
   const params=options.params??{};
   if(Object.keys(params).some(k=>!['account','sender','eventId','phase'].includes(k))||!['start','end'].includes(params.phase)||typeof params.eventId!=='string'||!params.eventId||params.eventId.length>512)fail('Verified bounded channel activity required');
   const rows=api.runtime.config.current().bindings?.filter(b=>b.match?.channel==='openclaw-weixin'&&b.match.peer?.kind==='direct')??[];
   if(rows.length!==1||rows[0].match.accountId!==params.account||rows[0].match.peer.id!==params.sender)fail('Activity tenant mismatch');
   const tenant=binding(api.runtime.config.current(),params.account,params.sender);
   const assertCurrent=()=>{if(options.hasCurrentClientAuthority?.()!==true)fail('Activity request expired');binding(api.runtime.config.current(),params.account,params.sender)};
   assertCurrent();const store=api.runtime.state.openKeyedStoreV2({namespace:'tenant-domain-v1',retention:'retained'},{assertCurrent});
   const eventHash=createHash('sha256').update(JSON.stringify([params.account,params.sender,params.eventId])).digest('hex');
   for(let n=0;n<8;n++){
    const observed=await store.observe(tenant.id);const update=activityTransition(observed.value??defaults(),params.phase,eventHash,Date.now());
    if(JSON.stringify(update.state)===JSON.stringify(observed.value??defaults())){options.respond(true,update.result);return}
    assertCurrent();const committed=await store.compareAndApply(tenant.id,observed.comparison,{operation:'update',action:'set',value:update.state});
    if(committed.status==='applied'){options.respond(true,update.result);return}
    if(committed.status!=='conflict')fail('Activity result uncertain');
   }
   fail('Activity contention');
  }catch(e){options.respond(false,undefined,{code:'INVALID_REQUEST',message:e.message});}
 },{scope:'operator.write'});

 // Authenticated local application endpoint, distinct from native owner commands.
 // The channel constructs these fields only after its real admission check.
 api.registerGatewayMethod('dafeiyu.businessChat',async options=>{
  try{
   const params=options.params??{};
   if(Object.keys(params).some(k=>!['text','messageId','account','sender','agentId','sessionKey','receivedAt','directText','source'].includes(k)))fail('Unknown chat confirmation fields');
   if(typeof params.text!=='string'||params.text.length>3000||typeof params.messageId!=='string'||!params.messageId||params.messageId.length>200)fail('Bounded channel message required');
   if(params.receivedAt!==undefined&&(!Number.isSafeInteger(params.receivedAt)||params.receivedAt<=0||params.receivedAt>Date.now()+5*60000))fail('Original channel admission time required');
   if(params.directText!==undefined&&typeof params.directText!=='boolean')fail('Original text classification required');
   const bindings=api.runtime.config.current().bindings?.filter(b=>b.match?.channel==='openclaw-weixin'&&b.match.peer?.kind==='direct')??[];
   if(bindings.length!==1)fail('One tenant per authenticated application Gateway required');
   const b=bindings[0];if(params.account!==b.match.accountId||params.sender!==b.match.peer.id||params.agentId!==b.agentId)fail('Authenticated application tenant mismatch');
   const assertAdmissionCurrent=()=>{if(options.hasCurrentClientAuthority?.()!==true)fail('Application request expired');binding(api.runtime.config.current(),params.account,params.sender)};
   assertAdmissionCurrent();const text=await businessChat(api,{...params,assertAdmissionCurrent});
   const service=createBoundDomainService(api,{id:params.agentId,account:params.account,sender:params.sender},assertAdmissionCurrent,{kind:'authenticated-portal'});
   const characterContext=await service.characterContext();
   let sourceContext=null,sourceError=null;
   if(text===null&&params.source){
    try{sourceContext=await stageMatterSource(api,{id:params.agentId,account:params.account,sender:params.sender},assertAdmissionCurrent,params.source)}
    catch{sourceError='本次资料未能保存来源；可以继续聊，但不要声称原件已经归档。需要跟进时请重新转发。'}
   }
   const matterContext=await service.matterContext(params.text);
   options.respond(true,{text,characterContext,sourceContext,sourceError,matterContext});
  }catch(e){options.respond(false,undefined,{code:'INVALID_REQUEST',message:e.message});}
 },{scope:'operator.write'});

 api.registerGatewayMethod('dafeiyu.scheduler',async options=>{
  try{
   const params=options.params??{};
   if(Object.keys(params).some(k=>!['action','attemptId','lease','outcome'].includes(k)))fail('Unknown scheduler fields');
   if(!['claim','begin','validate','settle','refresh','deliver','generate'].includes(params.action))fail('Unknown scheduler action');
   const config=api.runtime.config.current();
   if(config.plugins?.entries?.['dafeiyu-domain']?.config?.shadowOnly!==false)fail('Business delivery is not enabled');
   const candidates=config.bindings?.filter(b=>b.match?.channel==='openclaw-weixin'&&b.match.peer?.kind==='direct')??[];
   if(candidates.length!==1)fail('One authenticated tenant per Gateway required');
   const b=candidates[0],tenant=binding(config,b.match.accountId,b.match.peer.id);
   const assertCurrent=()=>{if(options.hasCurrentClientAuthority?.()!==true)fail('Request expired');binding(api.runtime.config.current(),tenant.account,tenant.sender);if(api.runtime.config.current().plugins?.entries?.['dafeiyu-domain']?.config?.shadowOnly!==false)fail('Business delivery disabled');};
   assertCurrent();const store=api.runtime.state.openKeyedStoreV2({namespace:'tenant-domain-v1',retention:'retained'},{assertCurrent});
   const {action,...args}=params;
   if(action==='validate'){
    const current=await store.lookup(tenant.id);assertCurrent();const attempt=current?.businessScheduler?.attempts?.[args.attemptId];
    if(attempt?.ids.some(id=>['weather','interest','memory','greeting'].includes(current.candidates[id]?.category)))fail('New proactive types require guarded delivery');
   }
   if(action==='refresh'&&Object.keys(args).length)fail('Refresh takes no observation arguments');
   if(action==='generate'&&Object.keys(args).some(k=>!['attemptId','lease'].includes(k)))fail('Generation takes only a retained lease');
   const result=action==='generate'?await generateGreeting(store,tenant,assertCurrent,args,{generator:greetingGenerator}):
    action==='deliver'?await dispatchPrepared(store,tenant,assertCurrent,args,{adapter:deliveryAdapter,availableCategories:releasedCategories}):
    action==='refresh'?await refreshProactive(store,tenant,assertCurrent,{adapters:Object.fromEntries(Object.entries(proactiveAdapters).filter(([key])=>releasedCategories[key]!==false)),deliveryReady:typeof deliveryAdapter?.authorize==='function'&&typeof deliveryAdapter?.send==='function'}):
    await schedulerOperation(store,tenant,assertCurrent,action,args,Date.now(),{availableCategories:releasedCategories,proactiveTransportReady:typeof deliveryAdapter?.authorize==='function'&&typeof deliveryAdapter?.send==='function'});
   options.respond(true,action==='begin'&&result.requiresGuard?{ready:result.ready,attemptId:result.attemptId,needsGeneration:result.needsGeneration,requiresGuard:true}:result);
  }catch(e){options.respond(false,undefined,{code:'INVALID_REQUEST',message:e.message});}
 },{scope:'operator.admin'});

 api.registerCommand({name:'fish',description:'查看、确认计划和个人设置；不会开启实际发送',acceptsArgs:true,requireAuth:true,handler:async ctx=>{
  try{
   // Fail closed on runtimes that do not supply retained command authority.
   if(!ctx.isAuthorizedSender||typeof ctx.assertOwnerCurrent!=='function')fail('当前运行时未提供此命令的有效授权，未修改数据。');
   const account=ctx.accountId,sender=ctx.senderId;if(!account||!sender||ctx.channel!=='openclaw-weixin')fail('Private Weixin command required');
   const tenant=binding(api.runtime.config.current(),account,sender);
   if(ctx.agentId!==tenant.id||ctx.sessionKey?.toLowerCase()!==`agent:${tenant.id}:openclaw-weixin:${account}:direct:${sender}`.toLowerCase())fail('Private command session mismatch');
   const assertCurrent=()=>{ctx.assertOwnerCurrent();binding(api.runtime.config.current(),account,sender)};
   const service=createBoundDomainService(api,tenant,assertCurrent,{kind:'chat-command',sessionKey:ctx.sessionKey});
   const words=(ctx.args??'').trim().split(/\s+/);let command;
   if(!words[0]||words[0]==='list')command={action:'list'};
   else if(['confirm','cancel','complete'].includes(words[0])&&words.length===3&&/^\d+$/.test(words[2]))command={action:'plan.'+words[0],id:words[1],expectedRevision:Number(words[2]),requestId:`chat:${words.join(':')}`};
   else if(words[0]==='settings-confirm'&&words.length===3&&/^\d+$/.test(words[2]))command={action:'preferences.confirm',id:words[1],expectedRevision:Number(words[2]),requestId:`chat:${words.join(':')}`};
   else if(['pause','off'].includes(words[0])&&words.length===1)command={action:words[0]==='pause'?'preferences.pause':'preferences.disable',requestId:`chat:${words[0]}:${crypto.randomUUID()}`};
   else fail('用法：/fish list；/fish confirm 草稿ID 版本；/fish cancel 计划ID 版本；/fish settings-confirm 设置ID 版本；/fish pause；/fish off');
   return {text:JSON.stringify(await control(service,command,'verified-chat-confirmation'))};
  }catch(e){return {text:'未完成：'+e.message};}
 }});
 api.registerGatewayMethod('dafeiyu.control',async options=>{
  try{
   // A portal calls its user's existing Gateway. Never accept a tenant selector.
   const candidates=api.runtime.config.current().bindings?.filter(b=>b.match?.channel==='openclaw-weixin'&&b.match.peer?.kind==='direct')??[];
   if(candidates.length!==1)fail('Portal requires one unambiguous owner binding');
   const b=candidates[0],tenant=binding(api.runtime.config.current(),b.match.accountId,b.match.peer.id);
   const assertCurrent=()=>{if(options.hasCurrentClientAuthority?.()!==true)fail('Gateway request authority expired');binding(api.runtime.config.current(),tenant.account,tenant.sender)};
   assertCurrent();const service=createBoundDomainService(api,tenant,assertCurrent,{kind:'authenticated-portal'});
   options.respond(true,await control(service,options.params,'verified-web-choice'));
  }catch(e){options.respond(false,undefined,{code:'INVALID_REQUEST',message:e.message});}
 },{scope:'operator.admin'});
}
