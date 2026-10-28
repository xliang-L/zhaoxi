import {defaults,identityId} from '../core/domain.mjs';
import {factIngressTransition,factContextTransition} from './fact-memory.mjs';
import {safeInput,casualText} from './fact-rules.mjs';
const fail=()=>{throw Error('Verified private fact ingress required')};
function tenantFor(api,envelope){
 if(api.runtime.config.current().plugins?.entries?.['dafeiyu-domain']?.hooks?.allowConversationAccess!==true)throw Error('Structured memory conversation access has not been approved');
 const {account,sender,agentId,sessionKey}=envelope;
 if(typeof account!=='string'||!account||account==='*'||typeof sender!=='string'||!sender||sender==='*')fail();
 const id=identityId(account,sender);
 if(agentId!==id||typeof sessionKey!=='string'||sessionKey.toLowerCase()!==`agent:${id}:openclaw-weixin:${account}:direct:${sender}`.toLowerCase())fail();
 if(!api.runtime.config.current().bindings?.some(b=>b.agentId===id&&b.match?.channel==='openclaw-weixin'&&b.match.accountId===account&&b.match.peer?.kind==='direct'&&b.match.peer.id===sender))fail();
 return {id,account,sender,sessionKey};
}
/** A small asynchronous rule worker; raw messages are never persisted by this plugin. */
export function createFactMemoryController(api,{clock=Date.now}={}){
 const pending=new Map(),stats={accepted:0,filtered:0,failed:0};
 let reportedContextContract=false;
 const transact=async(tenant,assertCurrent,change)=>{
  const store=api.runtime.state.openKeyedStoreV2({namespace:'tenant-domain-v1',retention:'retained'},{assertCurrent});
  for(let n=0;n<8;n++){
   assertCurrent();const observed=await store.observe(tenant.id);assertCurrent();
   const old=observed.value??defaults(),next=change(old);
   if(JSON.stringify(old)===JSON.stringify(next.state))return next;
   if(Buffer.byteLength(JSON.stringify(next.state))>=900000)throw Error('Structured fact record capacity reached');
   assertCurrent();const result=await store.compareAndApply(tenant.id,observed.comparison,{operation:'update',action:'set',value:next.state});
   if(result.status==='applied'){assertCurrent();return next;}
   if(result.status!=='conflict')throw Error('Structured fact commit uncertain');
  }
  throw Error('Structured fact contention');
 };
 return {
  stats,
  enqueue(envelope){
   if(envelope.channelId!=='openclaw-weixin'||typeof envelope.assertAdmissionCurrent!=='function'||!Array.isArray(envelope.messages)||envelope.messages.length>20)fail();
   const admission=envelope.assertAdmissionCurrent;admission();
   const tenant=tenantFor(api,envelope);
   const assertCurrent=()=>{admission();tenantFor(api,{...tenant,agentId:tenant.id})};
   const messages=envelope.messages.map(m=>{
    if(typeof m.messageId!=='string'||!m.messageId||m.messageId.length>200||!Number.isSafeInteger(m.sourceAt)||m.sourceAt<=0||!Number.isSafeInteger(m.receivedAt)||typeof m.text!=='string')fail();
    const safe=safeInput(m.text);if(!safe)stats.filtered++;
    return {messageId:m.messageId,sourceAt:m.sourceAt,receivedAt:m.receivedAt,text:safe?m.text:''};
   });
   const previous=pending.get(tenant.id)??Promise.resolve();
   const job=previous.then(()=>transact(tenant,assertCurrent,s=>factIngressTransition(s,messages,tenant,clock()))).then(next=>({settled:true,outcomes:next.result.outcomes}),()=>{stats.failed++;api.logger?.warn?.('Structured fact memory operation failed; native input must remain unsettled');return {settled:false,outcomes:[],reason:'commit_unconfirmed'};});
   pending.set(tenant.id,job);stats.accepted+=messages.length;
   void job.finally(()=>{if(pending.get(tenant.id)===job)pending.delete(tenant.id)});
   return job;
  },
  async settle(){await Promise.all([...pending.values()])},
  async context(event,ctx,{readOnly=false}={}){
   if(!ctx.hookInvocation?.assertActive||!ctx.assertMemoryAudienceCurrent||ctx.inputProvenance?.kind!=='external_user'||!['openclaw-weixin'].includes(ctx.channel??ctx.messageProvider)||!event.currentUserMessageId){
    if(!reportedContextContract){reportedContextContract=true;api.logger?.warn?.('Structured fact recall missing host context '+JSON.stringify({lifetime:typeof ctx.hookInvocation?.assertActive==='function',audience:typeof ctx.assertMemoryAudienceCurrent==='function',external:ctx.inputProvenance?.kind==='external_user',channel:(ctx.channel??ctx.messageProvider)==='openclaw-weixin',messageId:Boolean(event.currentUserMessageId)}));}
    return;
   }
   const tenant=tenantFor(api,{account:ctx.accountId,sender:ctx.senderId,agentId:ctx.agentId,sessionKey:ctx.sessionKey});
   await pending.get(tenant.id);
   const assertCurrent=()=>{ctx.hookInvocation.assertActive();ctx.assertMemoryAudienceCurrent();tenantFor(api,{...tenant,agentId:tenant.id})};
   const change=s=>factContextTransition(s,{messageId:event.currentUserMessageId,messageText:event.currentUserMessage,casual:casualText(event.currentUserMessage??'')},clock());
   let result;
   if(readOnly){
    assertCurrent();const store=api.runtime.state.openKeyedStoreV2({namespace:'tenant-domain-v1',retention:'retained'},{assertCurrent});
    const state=await store.lookup(tenant.id);assertCurrent();result=change(state??defaults());
   }else result=await transact(tenant,assertCurrent,change);
   return result.context?{appendContext:result.context,...(readOnly?{assertCurrent}:{})}:undefined;
  },
 };
}
export function registerFactMemory(api){
 const controller=createFactMemoryController(api);
 api.registerHook('message:dafeiyu-fact-ingress',event=>{
  if(event.type!=='message'||event.action!=='dafeiyu-fact-ingress')return;
  const receive=event.context.registerCompletion;
  if(typeof receive!=='function')throw Error('Native fact settlement receiver required');
  try{receive(controller.enqueue(event.context));}
  catch{receive(Promise.resolve({settled:false,outcomes:[],reason:'intake_refused'}));}
 },{name:'dafeiyu-verified-fact-ingress',description:'Low sensitivity facts from admitted Weixin source messages; no model authority'});
 api.on('before_prompt_build',async(event,ctx)=>{
  // Prepare once; request-only facts are freshly read at every provider boundary.
  await controller.context(event,ctx);
  return {ephemeralContext:async({hookInvocation})=>{
   const result=await controller.context(event,{...ctx,hookInvocation},{readOnly:true});
   return result?{text:result.appendContext,assertCurrent:result.assertCurrent}:undefined;
  }};
 },{requiresMemoryAudience:true});
 return controller;
}
