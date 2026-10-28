import {isVerifiedPublicInterestRecord} from './public-observations.mjs';
import {createHash} from 'node:crypto';
export const hour=3600000;
export const consentKinds=['verified-web-choice','verified-chat-confirmation'];
const forbidden=/(病史|诊断|抑郁|医疗|用药|药物|怀孕|癌症|肿瘤|化疗|放疗|糖尿病|高血压|治疗|手术|复诊|医院|性取向|性生活|宗教|政治|党派|投票|工资|收入|银行卡|密码|身份证|住址|精确定位|小剧场|虚构|扮演|角色设定|剧情里|故事里|本鱼|大肥鱼|ignore.{0,30}instructions|system\s*prompt|api.?key|忽略.{0,12}指令|系统提示|立即购买|限时优惠|返佣|推广码|sponsored|advertorial)/i;
export const nonSensitive=x=>typeof x==='string'&&Boolean(x.trim())&&!forbidden.test(x)&&!/[\x00-\x1f<>]/.test(x);
export const topicAllowed=x=>nonSensitive(x)&&x.length<=40&&!/https?:\/\//i.test(x);
export const fingerprint=(...parts)=>createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export function beijingParts(now){const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(x=>[x.type,x.value]));return {date:`${p.year}-${p.month}-${p.day}`,time:`${p.hour}:${p.minute}`};}
export const withinWindow=now=>beijingParts(now).time>='09:00';
export function sharedProactiveDecision(s,now){
 if(!withinWindow(now))return {allow:false,reason:'beijing_window'};
 const used=Object.values(s.candidates).filter(c=>c.category!=='reminder'&&['sent','sending','unknown','unknown_acknowledged'].includes(c.status)&&Number.isFinite(c.deliveryAttemptAt??c.sentAt));
 if(used.filter(c=>beijingParts(c.deliveryAttemptAt??c.sentAt).date===beijingParts(now).date).length>=Math.min(5,s.preferences.greetingLimit))return {allow:false,reason:'greeting_limit'};
 if(used.some(c=>now-(c.deliveryAttemptAt??c.sentAt)<Math.max(60,s.preferences.cooldownMinutes)*60000))return {allow:false,reason:'cooldown'};
 if(s.interactions.activeConversation?.expiresAt>now)return {allow:false,reason:'conversation_active'};
 return {allow:true,reason:'eligible'};
}
export function canonicalPublicUrl(value){try{const u=new URL(value);if(u.protocol!=='https:'||u.hostname!=='www.nasa.gov'||u.username||u.password||u.port)return null;for(const k of [...u.searchParams.keys()])if(/^utm_|^(fbclid|gclid)$/i.test(k))u.searchParams.delete(k);u.hash='';u.searchParams.sort();u.pathname=u.pathname.replace(/\/+$/,'')||'/';return u.href;}catch{return null;}}
export function currentProactiveReference(s,c,now){
 const p=s.preferences;if(c.preferencesRevision!==(s.preferencesRevision??0))return false;
 if(c.category==='weather'){
  if(!p.city||p.weatherLocation?.city!==p.city||c.city!==p.city||c.forecastEndAt<=now||c.forecastStartAt>now+hour||c.evidenceAt>now||now-c.evidenceAt>6*hour)return false;
  if(c.planRef){const plan=s.plans[c.planRef.id];if(!plan||plan.status!=='active'||plan.revision!==c.planRef.revision||plan.outdoor!==true||plan.weatherCity!==p.city||!Number.isFinite(Date.parse(plan.dueAt))||Date.parse(plan.dueAt)<now||Date.parse(plan.dueAt)>c.forecastEndAt)return false;}
  return c.provider==='open-meteo';
 }
 if(c.category==='interest')return p.interests.includes(c.topic)&&topicAllowed(c.topic)&&((c.provider==='nasa-news'&&Boolean(canonicalPublicUrl(c.url)))||isVerifiedPublicInterestRecord(c,now))&&Number.isFinite(c.publishedAt)&&c.publishedAt<=now&&now-c.publishedAt<=48*hour&&c.evidenceAt<=now&&now-c.evidenceAt<=6*hour;
 if(c.category==='memory'){const f=s.facts[c.factRef?.id];return !s.factMemoryPaused&&f?.revision===c.factRef?.revision&&['user-stated','user-correction'].includes(f.sourceKind)&&f.confidence===1&&consentKinds.includes(f.source?.consent)&&nonSensitive(f.text)&&f.proactive?.consent==='verified-web-choice'&&nonSensitive(f.proactive.label)&&f.proactive.at<=now&&f.proactive.expiresAt>now;}
 return false;
}
export function invalidateFactCandidates(s,id){for(const c of Object.values(s.candidates))if(c.factRef&&(id===undefined||c.factRef.id===id)){delete c.text;if(['pending','claimed'].includes(c.status))c.status='cancelled';}}

export function recentlyDiscussed(s,c,now){return (s.interactions.recentTopics??[]).some(t=>t.expiresAt>now&&t.category===c.category&&(c.category==='weather'?t.key===c.city:c.category==='interest'?t.key===c.topic:t.key===c.factRef?.id));}
