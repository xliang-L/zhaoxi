import {identityId} from './domain.mjs';
import {createBoundDomainService} from './service.mjs';
const sourceLabel=value=>({needs_explicit_city:'待确认城市',needs_explicit_interest:'待选择兴趣',approved_transport_unavailable:'公开资料来源尚未接好',approved_topic_adapter_unavailable:'这个主题的资料来源尚未接好',no_fresh_verified_item:'暂时没有核实的新消息',provider_error:'这次未能取到可靠资料',ready:'已取到可靠资料',reviewed_facts_only:'只使用本人审核的跟进',disabled:'关闭',paused:'已暂停'})[value]??'待确认来源';
const pattern=/^\/fish-(?:confirm|settings-confirm|fact-confirm|memory-on|memory-off|memory-confirm|complete|plans|settings|facts|interaction-reset|pause|off)(?:\s|$)/;
/** Only the authenticated channel application endpoint calls this; no model tool grants consent. */
export async function businessChat(api,envelope){
 const {account,sender,agentId,sessionKey,messageId,assertAdmissionCurrent}=envelope;
 const id=identityId(account,sender);
 if(!messageId||typeof assertAdmissionCurrent!=='function'||agentId!==id||sessionKey?.toLowerCase()!==`agent:${id}:openclaw-weixin:${account}:direct:${sender}`.toLowerCase())throw Error('Private authenticated ingress required');
 const assertCurrent=()=>{assertAdmissionCurrent();const cfg=api.runtime.config.current();if(!cfg?.bindings?.some(b=>b.agentId===id&&b.match?.channel==='openclaw-weixin'&&b.match.accountId===account&&b.match.peer?.kind==='direct'&&b.match.peer.id===sender))throw Error('Tenant binding revoked')};
 assertCurrent();const service=createBoundDomainService(api,{id,account,sender,sessionKey},assertCurrent,{kind:'verified-weixin-business-ingress',sessionKey,messageId});
 const aliases={'查看计划':'/fish-plans','我的计划':'/fish-plans','计划列表':'/fish-plans','查看提醒设置':'/fish-settings','当前提醒设置':'/fish-settings','暂停主动问候':'/fish-pause','暂停主动消息':'/fish-pause','关闭主动问候':'/fish-off','关闭主动消息':'/fish-off'};
 const alias=envelope.directText!==false?aliases[envelope.text.trim().replace(/[。！!]$/u,'')]:null;
 if(alias)envelope={...envelope,text:alias};
 if(envelope.directText===false||!pattern.test(envelope.text)){
  const reply=await service.answer(envelope);
  if(reply!==null){await service.reconcile();return reply;}
  const completed=await service.finishMatter(envelope);
  if(completed!==null){await service.reconcile();return completed;}
  if(envelope.directText!==false&&['查看事项','我的事项','查看待办'].includes(envelope.text.trim().replace(/[。！!]$/u,''))){
   const matters=(await service.matters()).filter(m=>m.status==='active');
   return matters.length?matters.map(m=>`「${m.title}」${m.deadlineAt?'\n截止：'+new Intl.DateTimeFormat('zh-CN',{timeZone:m.timezone,dateStyle:'medium',timeStyle:'short',hourCycle:'h23'}).format(new Date(m.deadlineAt)):'\n尚未注明截止时间'}${m.preparations.filter(p=>!p.done).length?'\n待准备：'+m.preparations.filter(p=>!p.done).map(p=>p.text).join('；'):''}`).join('\n\n'):'目前没有正在跟进的事项。把通知、截图或文件转给我，我先帮你整理。';
  }
  await service.clearMatterFocus(envelope.receivedAt);
  await service.noteTopics(envelope.text,messageId);return null;
 }
 await service.answer({...envelope,directText:false});
 const words=envelope.text.trim().split(/\s+/),action=words[0];
 if(action==='/fish-settings'&&words.length===1){
  const {preferences:p,shadowOnly,sourceStatus,proactiveStatus}=await service.read();
  return [
   `主动问候：${p.enabled&&!p.paused?'允许':'暂停或关闭'}${shadowOnly?'（服务仅预演）':''}`,
   `日常问候：${p.dailyGreetingEnabled?'允许联系时段内择机，参考聊天活跃时间与近况；偏好参考时间 '+p.dailyGreetingTime:'关闭'}；计划完成回访：${p.categories.greeting?'开':'关'}`,
   `课表和计划的自动提醒：${p.categories.reminder?'开':'关'}。你单独确认的定时提醒仍按约定时间处理。`,
   `主动跟进每天最多 ${p.greetingLimit} 次，间隔 ${p.cooldownMinutes} 分钟；安静时段 ${p.quietStart}–${p.quietEnd}（${p.timezone??'时区待设置'}）。`,
   `天气和 AI 自动资讯暂未开放；记忆跟进：${p.categories.memory?proactiveStatus.deliveryReady?sourceLabel(sourceStatus.memory):'投递链路尚未接好':'关闭'}。`,
   '想调整哪项直接告诉我，我会先说明具体改动，你回复“同意”就会处理。也可以直接说“暂停主动问候”或“关闭主动问候”。'
  ].join('\n');
 }
 if(action==='/fish-facts'&&words.length===1){const view=await service.read();return `你的结构化记录有 ${view.facts.length} 条、待确认草稿有 ${view.factDrafts.length} 条。可在个人网页查看来源、更正、删除或暂停写入。原生聊天记忆单独管理，不在此列表中。`;}
 if(action==='/fish-plans'&&words.length===1){const view=await service.read();return view.plans.length?view.plans.map(p=>`${p.title} · ${{draft:'待确认',active:'进行中',completed:'已完成',cancelled:'已取消'}[p.status]??p.status}\n${p.dueAt}${p.status==='draft'?'\n告诉我是否按这项安排保存，或直接说要修改的内容。':''}`).join('\n\n')+(view.pendingConfirmation?'\n\n待你确认：\n'+view.pendingConfirmation:''):'目前没有已保存的计划。'+(view.pendingConfirmation?'\n待你确认：\n'+view.pendingConfirmation:'告诉我具体事项和时间，我先跟你核对。')}
 let command,nonce;
 if(['/fish-memory-on','/fish-memory-off'].includes(action)&&words.length===1)command={action:action==='/fish-memory-on'?'fact.auto.enable':'fact.auto.disable',requestId:'chat:'+messageId,...(action==='/fish-memory-on'?{value:{noticeVersion:1}}:{})};
 else if(action==='/fish-memory-confirm'&&words.length===3&&/^\d+$/.test(words[2]))command={action:'fact.auto.confirm',id:words[1],expectedRevision:Number(words[2]),requestId:'chat:'+messageId};
 else if(['/fish-confirm','/fish-settings-confirm','/fish-fact-confirm'].includes(action)&&words.length===4&&/^\d+$/.test(words[2])){
  nonce=words[3];command={action:action==='/fish-confirm'?'plan.confirm':action==='/fish-fact-confirm'?'fact.confirm':'preferences.confirm',id:words[1],expectedRevision:Number(words[2]),requestId:'chat:'+messageId,...(action==='/fish-fact-confirm'?{value:{nonce}}:{})};
 }else if(action==='/fish-complete'&&words.length===3&&/^\d+$/.test(words[2]))command={action:'plan.complete',id:words[1],expectedRevision:Number(words[2]),requestId:'chat:'+messageId};
 else if(['/fish-pause','/fish-off','/fish-interaction-reset'].includes(action)&&words.length===1)command={action:action==='/fish-pause'?'preferences.pause':action==='/fish-interaction-reset'?'interaction.reset':'preferences.disable',requestId:'chat:'+messageId};
 else throw Error('没有找到可直接处理的这项内容。请用普通话告诉我要安排或修改什么，我再跟你核对。');
 await service.change(command,{consent:'verified-chat-confirmation',confirmationNonce:nonce});await service.reconcile();
 const view=await service.read();
 if(command.action==='preferences.confirm'&&view.preferences.categories.weather&&!view.preferences.city){const r=await service.change({action:'proactive.city-question',requestId:'city-question:'+messageId},{consent:'verified-chat-confirmation'});if(r.question)return '个人设置已保存；天气尚未启用来源。'+r.question;}
 if(command.action==='fact.auto.enable')return '已由你开启这份结构化自动记忆：只记录你明确自述的常住城市、兴趣、回复风格；不存密码、证件等秘密，健康和财务默认不自动沉淀。不确定的内容会先询问。可在个人网页查看、更正、删除，或直接说“关闭自动记忆”。原生聊天记忆另行管理；不会因此开启提醒、推送或定位。';
 if(command.action==='fact.auto.disable')return '已关闭这份结构化自动记忆的写入和自动召回。已保存内容仍可在个人网页查看、删除；原生聊天记忆另行管理。';
 if(command.action==='fact.auto.confirm')return '已按你的本人确认保存这条结构化事实，可在个人网页查看来源、更正或删除。';
 if(command.action==='plan.complete')return '已将这项计划标记为完成。';
 if(command.action==='fact.confirm')return '这条结构化偏好已由你确认保存，可在个人网页查看来源、更正或删除。';
 if(command.action==='interaction.reset')return '已清除问候互动状态。后续新对话会重新记录时间，计划和记忆内容保留。';
 return command.action.startsWith('plan.')?`计划已保存。${view.shadowOnly?'目前仍是预演，自动发送未开启。':view.deliveryEnabled?'到期后会按你设置的时段提醒本人。':'主动提醒尚未启用，可以在个人网页设置。'}`:command.action==='preferences.confirm'?'个人设置已保存；只应用到本人。':'已暂停或关闭你的主动消息；已经交给微信发送的消息无法撤回。';
}
