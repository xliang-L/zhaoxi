import {schedulerOperation} from './business-scheduler.mjs';
/** Adapter belongs to the native send owner. No model/RPC can supply one.
 * authorize must await all lower-layer authentication; send must begin transport
 * immediately, without another async credential lookup. No adapter => no send.
 */
export async function dispatchPrepared(store,tenant,assertCurrent,lease,{adapter,now=()=>Date.now(),availableCategories={}}={}){
 if(typeof adapter?.authorize!=='function'||typeof adapter?.send!=='function')return {ready:false,reason:'guarded_transport_unavailable'};
 assertCurrent();const observed=await store.observe(tenant.id);assertCurrent();
 const attempt=observed.value?.businessScheduler?.attempts?.[lease.attemptId];
 if(!attempt||attempt.lease!==lease.lease||attempt.status!=='sending'||attempt.transportAdmittedAt)return {ready:false,reason:'attempt_not_sendable'};
 if(attempt.ids.some(id=>availableCategories[observed.value.candidates[id]?.category]===false)){await schedulerOperation(store,tenant,assertCurrent,'abort',lease,now());return {ready:false,reason:'release_unavailable'};}
 const preview=attempt.ids.length===1?observed.value.candidates[attempt.ids[0]]?.text:undefined;
 let capability;
 try{capability=await adapter.authorize({tenant,assertCurrent,previewMessage:preview});}
 catch{await schedulerOperation(store,tenant,assertCurrent,'abort',lease,now());return {ready:false,reason:'prepared_transport_rejected'};}
 assertCurrent();if(typeof capability?.assertCurrent!=='function')throw Error('Native retained send authority required');capability.assertCurrent();
 // Re-read facts, preferences and route AFTER lower-layer authorization awaits.
 const checked=await schedulerOperation(store,tenant,assertCurrent,'validate',lease,now(),{availableCategories});
 if(!checked.ready)return checked;
 assertCurrent();capability.assertCurrent();
 let outcome='unknown',receipt;
 try{
  // This invocation is the transport admission boundary; no await precedes it.
  receipt=await adapter.send({tenant,capability,message:checked.message,idempotencyKey:'business-reminder:'+lease.attemptId});
  const validId=x=>typeof x==='string'&&x.trim().length>0&&x.length<=512;
  if(receipt&&(validId(receipt.messageId)||validId(receipt.serverMessageId)))outcome='accepted';
 }finally{await schedulerOperation(store,tenant,assertCurrent,'settle',{...lease,outcome},now());}
 return {ready:true,outcome,...(typeof receipt?.messageId==='string'&&receipt.messageId.trim()?{messageId:receipt.messageId}:{}),...(typeof receipt?.serverMessageId==='string'&&receipt.serverMessageId.trim()?{serverMessageId:receipt.serverMessageId}:{})};
}
