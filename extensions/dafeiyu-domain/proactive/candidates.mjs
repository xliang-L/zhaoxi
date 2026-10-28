import {isVerifiedPublicInterestRecord} from './public-observations.mjs';
import {canonicalPublicSource} from './public-http.mjs';
import {candidateDecision} from '../core/domain.mjs';
import {hour,fingerprint,canonicalPublicUrl,topicAllowed,nonSensitive,beijingParts} from './proactive-policy.mjs';
const bounded=(x,n)=>typeof x==='string'&&x.trim().length>0&&x.length<=n;
/** Internal trusted adapter data only; never exposes observation injection to a model. */
export function observationCandidate(s,o,now){
 if(!o||!bounded(o.id,160)||!bounded(o.source,500)||!Number.isFinite(o.observedAt)||o.observedAt>now||now-o.observedAt>6*hour||!Number.isFinite(o.confidence)||o.confidence<0.8||o.confidence>1)return {candidate:null,reason:'missing_or_stale_evidence'};
 const p=s.preferences;let text,fp,refs={},expiresAt=o.observedAt+6*hour;
 if(o.category==='weather'){
  if(o.provider!=='open-meteo'||!p.city||o.city!==p.city||p.weatherLocation?.city!==p.city)return {candidate:null,reason:'city_not_configured_or_mismatch'};
  let u;try{u=new URL(o.source)}catch{return {candidate:null,reason:'invalid_source'}}
  if(u.protocol!=='https:'||u.hostname!=='api.open-meteo.com'||u.username||u.password||u.port)return {candidate:null,reason:'invalid_source'};
  if(!Number.isFinite(o.forecastStartAt)||!Number.isFinite(o.forecastEndAt)||o.forecastStartAt>now+hour||o.forecastStartAt<now-hour||o.forecastEndAt-o.forecastStartAt!==6*hour||o.forecastEndAt<=now)return {candidate:null,reason:'invalid_forecast_window'};
  if(!Number.isFinite(o.previousC)||!Number.isFinite(o.currentC)||Math.abs(o.previousC)>80||Math.abs(o.currentC)>80)return {candidate:null,reason:'invalid_temperature'};
  const delta=o.currentC-o.previousC,temperature=Math.abs(delta)>=8,rain=o.rainChange==='dry-to-rain';
  const trip=Object.values(s.plans).find(x=>x.status==='active'&&x.outdoor===true&&x.weatherCity===p.city&&Date.parse(x.dueAt)>=now&&Date.parse(x.dueAt)<=o.forecastEndAt);
  if(!temperature&&!rain&&!trip)return {candidate:null,reason:'no_significant_change_or_outdoor_plan'};
  const relatedTrip=!temperature&&!rain?trip:null;const fmt=t=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(t);const period=fmt(o.forecastStartAt)+'至'+fmt(o.forecastEndAt);
  text=temperature?`${p.city}${period}预计从 ${o.previousC}°C ${delta<0?'降到':'升到'} ${o.currentC}°C。出门时留意一下衣物。`:rain?`${p.city}${period}预报降雨概率明显上升。今天出门的话，把伞顺手带上。`:`你确认的户外时段快到了，${p.city}${period}预计 ${o.previousC}–${o.currentC}°C${o.rainProbability>=70?'，降雨概率较高，带把伞更稳妥。':'。预报先递给你，方便安排出门。'}`;
  fp=fingerprint('weather',p.city,beijingParts(now).date,temperature?(delta<0?'cooling':'warming'):rain?'rain':'outdoor',relatedTrip?.id??'');
  expiresAt=Math.min(expiresAt,o.forecastEndAt);refs={provider:o.provider,city:o.city,evidenceAt:o.observedAt,forecastStartAt:o.forecastStartAt,forecastEndAt:o.forecastEndAt,...(relatedTrip?{planRef:{id:relatedTrip.id,revision:relatedTrip.revision}}:{})};
 }else if(o.category==='interest'){
  if(!['nasa-news','public-web-search'].includes(o.provider)||!topicAllowed(o.topic)||!p.interests.includes(o.topic))return {candidate:null,reason:'topic_not_opted_in'};
  const url=o.provider==='public-web-search'?canonicalPublicSource(o.url):canonicalPublicUrl(o.url);
  if(!url||!bounded(o.title,160)||!nonSensitive(o.title)||!Number.isFinite(o.publishedAt)||o.publishedAt>now||now-o.publishedAt>48*hour)return {candidate:null,reason:'unverified_or_stale_item'};
  if(o.provider==='public-web-search'?!isVerifiedPublicInterestRecord(o,now):(o.topic!=='天文'||!/(telescope|galax|nebula|exoplanet|supernova|universe|hubble|webb|astronom|天文|宇宙|星系|行星|望远镜)/i.test(o.title)))return {candidate:null,reason:'topic_not_verified'};
  text=`你关注的「${o.topic}」有条新消息：${o.title}\n${o.provider==='nasa-news'?'NASA 原文':'公开来源（标题与发布元数据已核对）'}：${url}`;fp=fingerprint('public-item',url);expiresAt=Math.min(expiresAt,o.publishedAt+48*hour);refs={provider:o.provider,topic:o.topic,url,publishedAt:o.publishedAt,evidenceAt:o.observedAt,...(o.provider==='public-web-search'?{publicationEvidence:structuredClone(o.publicationEvidence)}:{})};
 }else return {candidate:null,reason:'unsupported_observation'};
 const candidate={id:'proactive:'+fingerprint(fp,s.preferencesRevision??0),category:o.category,text,source:o.source,confidence:o.confidence,createdAt:now,at:now,expiresAt,fingerprint:fp,preferencesRevision:s.preferencesRevision??0,status:'pending',deliveryMode:'business',...refs};
 return {candidate,decision:candidateDecision(s,candidate,now)};
}
export function shadowBatch(s,candidates,now,{maxNonReminder=2}={}){
 if(!Number.isInteger(maxNonReminder)||maxNonReminder<0||maxNonReminder>10)throw Error('Bounded shadow budget required');
 const selected=[],results=[],seen=new Set();for(const c of candidates){let decision=candidateDecision(s,c,now);if(decision.allow&&seen.has(c.fingerprint))decision={allow:false,reason:'duplicate_in_batch'};if(decision.allow&&c.category!=='reminder'&&selected.filter(x=>x.category!=='reminder').length>=maxNonReminder)decision={allow:false,reason:'shadow_batch_budget'};if(decision.allow){seen.add(c.fingerprint);selected.push(c)}results.push({id:c.id,...decision});}return {selected,results,deliveryMode:'shadow',sent:0};
}
