import {randomUUID} from 'node:crypto';
import {defaults,transition} from './domain.mjs';
import {assertReleasedPreference} from './release-policy.mjs';
import {matterActions} from '../matters/matters.mjs';

const supported=new Set([...matterActions,'plan.create','plan.update','plan.postpone','plan.complete','plan.cancel','plan.delete','preferences.propose','preferences.pause','preferences.disable','fact.propose']);
const clone=value=>structuredClone(value);
const check=(condition,message)=>{if(!condition)throw Error(message)};
const normalize=text=>typeof text==='string'?text.trim().replace(/[\s，,。.!！、；;：:]/gu,''):'';
export function conversationReply(text,{destructive=false}={}){
 const value=normalize(text);
 if(value.length>60)return null;
 if(/^(?:(?:我)?同意|确认(?:了|吧)?|好(?:的|呀|啊|嘞)?|嗯(?:嗯)?|可以(?:的)?|行|没问题|ok|OK|就(?:这么|这样)(?:办|定|安排|设置)?(?:吧|了)?|按(?:这个|这样|你说的)(?:办|来|安排|设置)(?:吧)?)$/u.test(value))return 'confirm';
 if(!destructive&&/^(?:(?:嗯嗯|嗯|好的|好|可以|行)(?:那就)?)?(?:帮我)?(?:保存|存|存下|存下来|记下|记下来|安排|设置|确认保存|确认执行|确认设置)(?:吧|就好|就行)?$/u.test(value))return 'confirm';
 if(destructive&&/^(?:确认)?(?:帮我)?(?:删除|删掉|删|移除|忘记)(?:吧|就好|就行)?$/u.test(value))return 'confirm';
 if(destructive&&/^(?:保留|留着|不删|别删|先别删|先不删)(?:吧|了|就好|就行)?$/u.test(value))return 'decline';
 if(/^(?:不(?:同意|确认)|不用(?:了)?|先不(?:用|要|改|保存|设置|安排|执行)(?:了)?|先别(?:改|保存|设置|安排|执行)(?:了)?|算了|取消(?:吧)?|不要(?:了|保存|设置|安排|执行))$/u.test(value))return 'decline';
 return null;
}
const clock=(at,zone)=>new Intl.DateTimeFormat('zh-CN',{timeZone:zone,dateStyle:'medium',timeStyle:'short',hourCycle:'h23'}).format(new Date(at))+(zone==='Asia/Shanghai'?'（北京时间）':`（${zone}）`);
function recurrence(plan){
 const r=plan.repeat;if(!r)return '';
 const interval=r.interval??1;
 const cadence=r.frequency==='daily'?(interval===1?'每天':`每 ${interval} 天`):(interval===1?'每周':`每 ${interval} 周`);
 const weekdays=r.weekdays?.map(n=>'一二三四五六日'[n-1]).join('、');
 return `，${cadence}${weekdays?'（周'+weekdays+'）':''}${r.weekParity&&r.weekParity!=='all'?r.weekParity==='odd'?'，单周':'，双周':''}${r.until?'，截至 '+clock(r.until,plan.timezone):''}`;
}
function settings(p){
 return `主动消息${p.enabled&&!p.paused?'开启':'暂停或关闭'}；日常问候${p.dailyGreetingEnabled?'开启，在允许联系时段内结合聊天习惯与近况择机，偏好参考时间 '+p.dailyGreetingTime:'关闭'}；计划完成回访${p.categories.greeting?'开启':'关闭'}；课表和计划的自动提醒${p.categories.reminder?'开启':'关闭'}；每天最多 ${p.greetingLimit} 次主动跟进，间隔至少 ${p.cooldownMinutes} 分钟，安静时段 ${p.quietStart}–${p.quietEnd}（${p.timezone}）${p.dailyGreetingEnabled||p.categories.greeting?';结合最近私聊与角色近况生成，计入当月额度，个人事实记忆另行授权':''}`;
}
/** Replay on a copy for previews; the same sequence is committed only after admitted consent. */
function applySequence(current,commands,source,now){
 let s=clone(current??defaults());const descriptions=[],acknowledgments=[];
 for(const command of commands){
  const before=s.plans[command.id];
  if(command.action.startsWith('preferences.'))assertReleasedPreference(command.value);
  let next=transition(s,command,source,now);s=next.state;
  if(['plan.create','plan.update'].includes(command.action)){
   const plan=s.plans[command.id];
   check(plan.repeat||Date.parse(plan.dueAt)>now,'这个提醒时间已经过了，请告诉我新的时间，再自然确认。');
   next=transition(s,{action:'plan.confirm',id:plan.id,expectedRevision:plan.revision,requestId:command.requestId+':confirm'}, {...source,confirmationNonce:plan.confirmationNonce,reminderConsent:true},now);s=next.state;
  }else if(command.action==='preferences.propose'){
   const draft=s.preferenceDrafts[command.id];assertReleasedPreference(draft.value);
   next=transition(s,{action:'preferences.confirm',id:draft.id,expectedRevision:draft.confirmationRevision,requestId:command.requestId+':confirm'},{...source,confirmationNonce:draft.confirmationNonce},now);s=next.state;
  }else if(command.action==='fact.propose'){
   const draft=s.factDrafts[command.id];
   next=transition(s,{action:'fact.confirm',id:draft.id,expectedRevision:draft.revision,requestId:command.requestId+':confirm',value:{nonce:draft.confirmationNonce}},source,now);s=next.state;
  }
  if(command.action.startsWith('matter.')){
   descriptions.push(next.result.summary);
   const m=s.matters?.[command.id];
   acknowledgments.push(next.result.acknowledgement??(['matter.create','matter.update'].includes(command.action)?`「${m.title}」${command.action==='matter.update'?'更新好了':'记下了'}。${m.reminders.length?`已安排 ${m.reminders.length} 次提醒，最近一次在 ${clock(m.reminders[0].at,m.timezone)}，${m.reminders[0].text}`:'先保存资料，暂不设提醒。'}${command.action==='matter.update'?'旧通知已保留，后续按新要求跟进。':''}`:
    command.action==='matter.archive'?`「${command.value.title}」保存好了。原件和来源都保留，需要时直接让我找。`:next.result.summary));
  }
  else if(command.action.startsWith('plan.')){
   const plan=s.plans[command.id]??before;
   const verb=({'plan.create':'新增','plan.update':'修改','plan.postpone':'改期','plan.complete':'标记完成','plan.cancel':'取消','plan.delete':'删除'})[command.action];
   descriptions.push(`${verb}「${plan.title}」，${clock(plan.dueAt,plan.timezone)}${recurrence(plan)}${plan.location?'，地点：'+plan.location:''}${plan.notes?'，备注：'+plan.notes:''}${['plan.create','plan.update','plan.postpone'].includes(command.action)?'，到时提醒你':''}`);
  }else if(command.action.startsWith('preferences.'))descriptions.push('提醒设置：'+settings(s.preferences));
  else descriptions.push('记住：'+s.facts[command.id].text);
 }
 const touchedMatters=new Set(commands.filter(c=>['matter.create','matter.update'].includes(c.action)).map(c=>c.id));
 if(touchedMatters.size>1)delete s.matterFocus;
 return {state:s,descriptions,acknowledgments:commands.every(c=>c.action.startsWith('matter.'))?acknowledgments:descriptions};
}
function previewSource(source){return {...source,kind:'verified-weixin-business-ingress',consent:'verified-chat-confirmation',reminderConsent:true}};
function appendReceipt(s,messageId,text,now){
 s.conversationReceipts??={};s.conversationReceipts['message:'+messageId]={text,at:now};
 for(const [id] of Object.entries(s.conversationReceipts).sort((a,b)=>b[1].at-a[1].at).slice(128))delete s.conversationReceipts[id];
}
async function transaction(store,tenant,assertCurrent,change){
 for(let i=0;i<8;i++){
  assertCurrent();const observed=await store.observe(tenant.id);assertCurrent();const next=change(observed.value??defaults());
  if(JSON.stringify(next.state)===JSON.stringify(observed.value??defaults()))return next.result;
  check(Buffer.byteLength(JSON.stringify(next.state))<900000,'待处理事项暂时过多，请稍后再试。');
  next.state.revision++;assertCurrent();const receipt=await store.compareAndApply(tenant.id,observed.comparison,{operation:'update',action:'set',value:next.state});assertCurrent();
  if(receipt.status==='applied')return next.result;
  check(receipt.status==='conflict','这次操作的保存结果暂时无法确认，请稍后重试。');
 }
 throw Error('安排正在更新，请稍后再试。');
}

export async function proposeConversation(store,tenant,assertCurrent,command,source,now=Date.now()){
 check(supported.has(command.action),'Unsupported conversation proposal');
 check(source.kind==='authenticated-user'&&typeof source.sessionKey==='string','Verified tool invocation required');
 check(typeof command.requestId==='string'&&command.requestId.length<=100,'Bounded request ID required');
 return transaction(store,tenant,assertCurrent,current=>{
  const s=clone(current),old=s.conversationChoice;
  const sameRun=old?.status==='pending'&&old.expiresAt>now&&source.runId&&old.runId===source.runId&&old.sessionKey.toLowerCase()===source.sessionKey.toLowerCase();
  const commands=sameRun?clone(old.commands):[];
  const duplicate=commands.find(c=>c.requestId===command.requestId);
  if(duplicate)check(JSON.stringify(duplicate)===JSON.stringify(command),'Request ID reused with different proposal');else commands.push(clone(command));
  check(commands.length<=10,'一次最多确认十项安排，请先确认当前这批。');
  const applied=applySequence(s,commands,previewSource(source),now);
  const summary=applied.descriptions.map((line,index)=>`${index+1}. ${line}`).join('\n')+'\n确认照这样处理吗？回复“同意”或“就这么办”即可；想改内容直接告诉我，“先不用”就不处理。';
  s.conversationChoice={status:'pending',id:sameRun?old.id:randomUUID(),runId:source.runId??null,sessionKey:source.sessionKey,commands,summary,createdAt:sameRun?old.createdAt:now,expiresAt:now+10*60000,preferencesRevision:sameRun?old.preferencesRevision:s.preferencesRevision??0};
  if(s.autoFactMemory)delete s.autoFactMemory.pendingChoice;
  return {state:s,result:{saved:false,draft:true,requiresExplicitConfirmation:true,summary,plans:commands.filter(c=>c.action.startsWith('plan.')).map(c=>applied.state.plans[c.id]).filter(Boolean).map(p=>({id:p.id,revision:p.revision,title:p.title,dueAt:p.dueAt,timezone:p.timezone,status:'pending_confirmation'}))}};
 });
}

export async function answerConversation(store,tenant,assertCurrent,envelope,source,{now=Date.now(),shadowOnly=false}={}){
 check(source.kind==='verified-weixin-business-ingress'&&source.messageId===envelope.messageId,'Verified channel reply required');
 return transaction(store,tenant,assertCurrent,current=>{
  if(Object.hasOwn(current.conversationReceipts??{},'message:'+envelope.messageId))return {state:current,result:current.conversationReceipts['message:'+envelope.messageId].text};
  const pending=current.conversationChoice;if(pending?.status!=='pending')return {state:current,result:null};
  if(pending.sessionKey.toLowerCase()!==tenant.sessionKey.toLowerCase()||!Number.isSafeInteger(envelope.receivedAt)||envelope.receivedAt<=pending.createdAt)return {state:current,result:null};
  const s=clone(current),reply=envelope.directText===false?null:conversationReply(envelope.text,{destructive:pending.commands.some(c=>['matter.forget','matter.delete','plan.delete'].includes(c.action))});delete s.conversationChoice;
  if(!reply)return {state:s,result:null};
  let result;
  if(pending.expiresAt<=now)result='刚才的确认已经过期，这次没有处理。请重新告诉我安排或设置，我会用普通话再跟你核对。';
  else if(reply==='decline')result='好，刚才这项提议先不处理，原来的安排和设置保留。';
  else{
   try{
    if(pending.commands.some(c=>c.action.startsWith('preferences.')))check((s.preferencesRevision??0)===pending.preferencesRevision,'Settings changed');
    const applied=applySequence(s,pending.commands,{...source,kind:'verified-weixin-business-ingress',consent:'verified-chat-confirmation',reminderConsent:true},now);
    const text='已按你同意的内容处理：\n'+applied.acknowledgments.join('\n')+(shadowOnly?'\n当前服务仍在预演，尚未实际发送提醒。':'');
    appendReceipt(applied.state,envelope.messageId,text,now);delete applied.state.conversationChoice;
    return {state:applied.state,result:text};
   }catch{result='刚才的内容或时间已经变化，这次没有按旧提议处理。请告诉我最新安排，我再自然跟你核对。';}
  }
  appendReceipt(s,envelope.messageId,result,now);return {state:s,result};
 });
}
