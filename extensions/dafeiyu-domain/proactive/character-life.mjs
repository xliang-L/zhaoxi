import {randomUUID} from 'node:crypto';
import {validGreeting,deferGreeting} from './greetings.mjs';
import {candidateDecision} from '../core/domain.mjs';

export function conversationFloor(s,now){
 return Math.max(now-86400000,...Object.values(s.factTombstones??{}).map(t=>t.deletedAt??0),
  ...Object.values(s.facts??{}).filter(f=>f.sourceKind==='user-correction').map(f=>f.observedAt??0));
}
export function recentConversation(history,floor,now){
 if(!Array.isArray(history?.messages))throw Error('Private conversation unavailable');
 let remaining=8000;const selected=[];
 for(const message of history.messages.slice(-24).reverse()){
  const at=typeof message.timestamp==='number'?message.timestamp:Date.parse(message.timestamp);
  if(!['user','assistant'].includes(message.role)||!Number.isFinite(at)||at<=floor||at>now)continue;
  let text=typeof message.content==='string'?message.content:(Array.isArray(message.content)?message.content:[]).filter(p=>p.type==='text').map(p=>p.text??'').join('\n');
  text=text.replace(/(?:Conversation info|Sender|Replied message) \(untrusted metadata\):\s*```[\s\S]*?```/g,'').trim();
  if(!text)continue;text=text.slice(-Math.min(1200,remaining));remaining-=text.length;
  selected.push({role:message.role,at:new Date(at).toISOString(),text});if(remaining<=0)break;
 }
 return selected.reverse();
}
/** Honor a plain first-person request to wait, without retaining its text as a fact. */
export function explicitContactDelay(conversation,now){
 const last=conversation.findLast(m=>m.role==='user');
 const at=typeof last?.at==='number'?last.at:Date.parse(last?.at);
 if(!last||!Number.isFinite(at)||at>now||typeof last.text!=='string'||last.text.length>500)return 0;
 const body=last.text.trim();
 if(/[“”"`<>]|引用|转发|截图|通知/u.test(body)||!/^(我|接下来|先|这会儿|今天|别|不要)/u.test(body))return 0;
 if(!/(?:别|不要|先不|暂时不).{0,8}(?:打扰|联系|找我|发消息)|(?:忙|上课|开会|考试).{0,12}(?:再聊|之后聊)/u.test(body))return 0;
 const duration=body.match(/(\d{1,3}|[一二两三四五六七八九十半]+)\s*(?:个)?\s*(小时|分钟)/u);
 let minutes=60;
 if(duration){
  const digits={一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  const raw=duration[1],parts=raw.split('十');
  const count=/^\d+$/.test(raw)?Number(raw):raw==='半'?0.5:parts.length===2?(digits[parts[0]]??1)*10+(digits[parts[1]]??0):digits[raw];
  if(!Number.isFinite(count)||count<=0)return 0;
  minutes=Math.min(24*60,count*(duration[2]==='小时'?60:1));
 }
 const remaining=at+minutes*60000-now;
 return remaining>0?Math.max(30,Math.min(240,Math.ceil(remaining/60000))):0;
}
function snapshot(s,now){return {activityAt:s.interactions.lastVerifiedActivityAt??0,preferencesRevision:s.preferencesRevision??0,
 roleRevision:s.characterLife?.revision??0,forgetAt:conversationFloor(s,0)}}
export function generationCurrent(s,c,now=Date.now()){
 const g=c.generation;if(g?.status!=='ready')return false;
 return Number.isFinite(g.generatedAt)&&g.generatedAt<=now&&now-g.generatedAt<15*60000&&g.activityAt===(s.interactions.lastVerifiedActivityAt??0)&&g.preferencesRevision===(s.preferencesRevision??0)&&
  g.roleRevision===(s.characterLife?.revision??0)&&g.forgetAt===conversationFloor(s,0);
}
function admitted(s,a,now){
 if(!a||a.status!=='sending'||a.transportAdmittedAt||a.ids.length!==1)return false;
 const c=s.candidates[a.ids[0]];
 if(!c||c.category!=='greeting'||c.status!=='sending'||!validGreeting(s,c,now))return false;
 const budget=structuredClone(s);for(const id of a.ids)delete budget.candidates[id];
 return candidateDecision(budget,c,now).allow;
}
export function validateLifeOutput(value){
 if(!value||!['continuity,message,skip','continuity,message,retryAfterMinutes,skip'].includes(Object.keys(value).sort().join(','))||typeof value.skip!=='boolean'||
  typeof value.message!=='string'||typeof value.continuity!=='string'||value.message.length>500||value.continuity.length>1200)throw Error('Invalid character output');
 if(value.retryAfterMinutes!==undefined&&(!Number.isInteger(value.retryAfterMinutes)||value.retryAfterMinutes<30||value.retryAfterMinutes>240))throw Error('Invalid character retry time');
 const message=value.message.trim(),continuity=value.continuity.trim();
 if(!value.skip&&(!message||!continuity))throw Error('Empty character output');
 if(/https?:\/\/|\/fish-|\bMEDIA:|<\/?(?:system|tool)|(?:已|已经|帮你|替你).{0,12}(?:设好提醒|设置了提醒|保存了记忆|转账|下单)/iu.test(message))throw Error('Unsupported character output');
 return {message,continuity,skip:value.skip,retryAfterMinutes:value.retryAfterMinutes??60};
}
/** One in-flight generation per lease; unsent stale content may be regenerated. */
export async function generateGreeting(store,tenant,assertCurrent,lease,{generator,now=Date.now}={}){
 const run=randomUUID();let captured,candidate;
 async function change(update){
  for(let n=0;n<8;n++){
   assertCurrent();const observed=await store.observe(tenant.id);assertCurrent();const s=structuredClone(observed.value);
   const result=update(s);if(!result.write)return result.value;
   s.revision++;if(Buffer.byteLength(JSON.stringify(s))>900000)throw Error('Character state capacity reached');
   const committed=await store.compareAndApply(tenant.id,observed.comparison,{operation:'update',action:'set',value:s});
   if(committed.status==='applied')return result.value;if(committed.status!=='conflict')throw Error('Character commit uncertain');
  }throw Error('Character contention');
 }
 const started=await change(s=>{
  const a=s?.businessScheduler?.attempts?.[lease.attemptId];
  if(a?.lease!==lease.lease||!admitted(s,a,now()))return {value:{ready:false,reason:'changed_or_expired'}};
  const c=s.candidates[a.ids[0]];
   if(c.generation?.status==='ready'){
    if(generationCurrent(s,c,now()))return {value:{ready:true}};
    delete c.text;c.generation={status:'needed'};
   }
  if(c.generation?.status!=='needed')return {value:{ready:false,reason:'generation_already_attempted'}};
  captured=structuredClone(s);candidate=structuredClone(c);c.generation={...snapshot(s,now()),status:'started',run,startedAt:now()};
  return {write:true,value:{started:true}};
 });
 if(!started?.started)return started;
 const revalidate=async()=>{
  assertCurrent();const s=await store.lookup(tenant.id);assertCurrent();const a=s?.businessScheduler?.attempts?.[lease.attemptId],c=s?.candidates?.[candidate.id];
  if(a?.lease!==lease.lease||!admitted(s,a,now())||c?.generation?.run!==run||c.generation.status!=='started'||
   JSON.stringify(snapshot(s,now()))!==JSON.stringify(snapshot(captured,now())))throw Error('Character context changed');
 };
 try{
  if(typeof generator!=='function')throw Error('Character model unavailable');
  await revalidate();
  const output=validateLifeOutput(await generator({tenant,candidate,state:captured,now:now(),assertCurrent,revalidate}));
   if(!output.skip&&Object.values(captured.candidates).some(c=>c.id!==candidate.id&&c.category==='greeting'&&['sent','sending','unknown','unknown_acknowledged'].includes(c.status)&&c.text?.trim()===output.message&&(c.deliveryAttemptAt??c.sentAt)>Math.max(now()-86400000,conversationFloor(captured,0))))throw Error('Repeated greeting content');
  await revalidate();
  return await change(s=>{
   const a=s.businessScheduler.attempts[lease.attemptId],c=s.candidates[candidate.id];
   if(a?.lease!==lease.lease||!admitted(s,a,now())||c?.generation?.run!==run||c.generation.status!=='started'||
    JSON.stringify(snapshot(s,now()))!==JSON.stringify(snapshot(captured,now())))throw Error('Character context changed');
    if(output.skip){a.status='cancelled';a.finishedAt=now();if(!deferGreeting(s,c,now(),{retryAfterMinutes:output.retryAfterMinutes,reason:'model_requested_wait'})){c.status='cancelled';c.generation={status:'skipped'};}return {write:true,value:{ready:false,reason:'nothing_to_share'}};}
    c.text=output.message;c.generation={...c.generation,status:'ready',generatedAt:now(),continuity:output.continuity};
   return {write:true,value:{ready:true}};
  });
 }catch{
  await change(s=>{
   const a=s?.businessScheduler?.attempts?.[lease.attemptId],c=s?.candidates?.[candidate?.id];
   if(a?.lease!==lease.lease||a.status!=='sending'||a.transportAdmittedAt||c?.generation?.run!==run)return {value:null};
    a.status='cancelled';a.finishedAt=now();
    const changed=JSON.stringify(snapshot(s,now()))!==JSON.stringify(snapshot(captured,now()));
    if(!deferGreeting(s,c,now(),{retryAfterMinutes:changed?30:60,reason:changed?'context_changed':'generation_unavailable'})){c.status='cancelled';c.generation={status:'failed'};delete c.text;}
   return {write:true,value:null};
  });
  return {ready:false,reason:'character_generation_unavailable'};
 }
}
export function acceptCharacterLife(s,c,now){
 if(c.category!=='greeting'||c.generation?.status!=='ready')return;
 const old=s.characterLife??{revision:0,summary:'',events:[]};
 s.characterLife={revision:old.revision+1,summary:c.generation.continuity,updatedAt:now,
  events:[...old.events.filter(e=>e.at>conversationFloor(s,0)),{at:now,text:c.text}].slice(-8)};
 delete c.generation.continuity;
}
