import {createHash} from 'node:crypto';
import {loadObservation} from './providers.mjs';
import {hour,topicAllowed,nonSensitive} from './proactive-policy.mjs';
import {canonicalPublicSource,isGuardedPublicTransport} from './public-http.mjs';

const result=(status,reason,observation=null)=>({status,reason,observation});
const hash=value=>createHash('sha256').update(value).digest('hex');
const decode=text=>text.replace(/&(?:amp|quot|apos|lt|gt);|&#(?:x[0-9a-f]+|\d+);/gi,m=>{
 const map={'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>'};if(map[m.toLowerCase()])return map[m.toLowerCase()];
 const n=Number.parseInt(m.slice(m[2]?.toLowerCase()==='x'?3:2,-1),m[2]?.toLowerCase()==='x'?16:10);return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';
});
const plain=text=>typeof text==='string'?decode(text.replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim():'';
const attributes=tag=>Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m=>[m[1].toLowerCase(),decode(m[2]??m[3])]));
const absolute=(value,base)=>{try{return canonicalPublicSource(new URL(value,base).href)}catch{return null}};

export function verifiedPublicationTime(value){
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/i.test(value))return null;
 const [year,month,day]=value.slice(0,10).split('-').map(Number);
 if(month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate())return null;
 const time=value.slice(11,19),parts=time.split(':').map(Number);
 if(parts[0]>23||parts[1]>59||parts[2]>59)return null;
 const zone=value.match(/[+-](\d\d):(\d\d)$/);if(zone&&(Number(zone[1])*60+Number(zone[2])>840||Number(zone[2])>59))return null;
 const at=Date.parse(value);return Number.isFinite(at)?at:null;
}

function topicMatches(topic,title,description=''){
 const text=(title+' '+description).toLowerCase(),value=topic.toLowerCase().replace(/相关$/,'').trim();
 if(['ai','人工智能'].includes(value))return /\bai\b|人工智能/i.test(text);
 return Boolean(value)&&text.includes(value);
}

/** Shared structural check for trusted adapter observations and persisted candidate references. */
export function isVerifiedPublicInterestRecord(value,now){
 const url=canonicalPublicSource(value?.url),e=value?.publicationEvidence,at=value?.observedAt??value?.evidenceAt;
 return value?.provider==='public-web-search'&&topicAllowed(value.topic)&&Boolean(url)&&url===value.url&&
  Number.isFinite(now)&&Number.isFinite(value.publishedAt)&&value.publishedAt<=now&&now-value.publishedAt<=48*hour&&
  Number.isFinite(at)&&at<=now&&now-at<=6*hour&&e?.canonicalUrl===url&&e.publishedAt===value.publishedAt&&
  e.retrievedAt===at&&['jsonld.datePublished','meta.article:published_time'].includes(e.kind)&&e.coverage==='metadata_and_headline';
}

/** Verifies only page publication metadata/headline, not the article's claims or full text. */
export function verifiedPublicArticle({html,url,topic,now}){
 const finalUrl=canonicalPublicSource(url);
 if(!finalUrl||!topicAllowed(topic)||!Number.isFinite(now)||typeof html!=='string'||html.length>512000)return result('partial','invalid_page');
 const links=[...html.matchAll(/<link\b[^>]*>/gi)].map(m=>attributes(m[0]));
 const canonicalLinks=links.filter(a=>a.rel?.toLowerCase().split(/\s+/).includes('canonical')).map(a=>a.href?absolute(a.href,finalUrl):null);
 if(canonicalLinks.some(x=>!x))return result('partial','canonical_not_verified');
 const canonical=[...new Set(canonicalLinks)];
 const metadata=[...html.matchAll(/<meta\b[^>]*>/gi)].map(m=>attributes(m[0]));
 const meta=key=>metadata.filter(a=>(a.property??a.name??a.itemprop)?.toLowerCase()===key).map(a=>a.content);
 const articles=[];let visited=0;
 const walk=(node,depth=0)=>{
  if(!node||typeof node!=='object'||depth>6||++visited>150)return;
  if(Array.isArray(node)){node.slice(0,30).forEach(x=>walk(x,depth+1));return}
  const types=[node['@type']].flat().filter(x=>typeof x==='string').map(x=>x.split('/').at(-1));
  if(types.some(x=>['Article','NewsArticle','BlogPosting','TechArticle','ScholarlyArticle'].includes(x)))articles.push(node);
  for(const [key,value] of Object.entries(node))if(key==='@graph'||key==='mainEntity'||key==='itemListElement')walk(value,depth+1);
 };
 for(const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)){
  if(attributes(script[1]).type?.toLowerCase()!=='application/ld+json')continue;
  try{walk(JSON.parse(script[2]))}catch{}
 }
 const articleUrl=node=>{const value=typeof node.mainEntityOfPage==='string'?node.mainEntityOfPage:node.mainEntityOfPage?.['@id']??node.url;return typeof value==='string'&&value?absolute(value,finalUrl):null};
 if(!canonical.length){for(const a of articles){const candidate=articleUrl(a);if(candidate===finalUrl&&!canonical.includes(candidate))canonical.push(candidate)}}
 if(canonical.length!==1||canonical[0]!==finalUrl)return result('partial','canonical_not_verified');
 const own=articles.filter(a=>!a.mainEntityOfPage&&!a.url||articleUrl(a)===finalUrl);
 const dateEvidence=[...own.filter(a=>typeof a.datePublished==='string').map(a=>({value:a.datePublished,kind:'jsonld.datePublished'})),
  ...meta('article:published_time').map(value=>({value,kind:'meta.article:published_time'}))];
 const validDates=dateEvidence.map(x=>({...x,at:verifiedPublicationTime(x.value)}));
 if(!validDates.length||validDates.some(x=>x.at===null))return result('partial','publication_time_unverified');
 if(new Set(validDates.map(x=>x.at)).size!==1)return result('partial','conflicting_publication_times');
 const publishedAt=validDates[0].at;
 if(publishedAt>now||now-publishedAt>48*hour)return result('empty','not_fresh');
 const title=plain(own.find(a=>a.headline)?.headline??meta('og:title')[0]??html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]);
 const pageTitle=plain(meta('og:title')[0]??html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]);
 if(!title||title.length>160||!nonSensitive(title)||!pageTitle||!nonSensitive(pageTitle)||!(pageTitle.toLowerCase().includes(title.toLowerCase())||title.toLowerCase().includes(pageTitle.toLowerCase())))return result('partial','headline_not_verified');
 const description=plain(own.find(a=>a.description)?.description??meta('description')[0]);
 if(!topicMatches(topic,title,description))return result('empty','topic_not_verified');
 return result('ready','verified_page_metadata',{id:'public-web-'+hash(finalUrl),provider:'public-web-search',category:'interest',topic,
  source:finalUrl,url:finalUrl,title,publishedAt,observedAt:now,confidence:0.85,
  publicationEvidence:{kind:validDates[0].kind,canonicalUrl:finalUrl,publishedAt, retrievedAt:now,coverage:'metadata_and_headline'}});
}

function failure(error){
 if(error?.code==='PROACTIVE_CONTEXT_CHANGED')return result('settings_changed','settings_changed');
 if(error?.name==='SsrFBlockedError'||['blocked_public_url','blocked_redirect','source_blocked'].includes(error?.code))return result('blocked','source_blocked');
 if(error?.code==='unsupported_content_type')return result('unsupported','unsupported_content_type');
 return result('partial',error?.name==='AbortError'?'cancelled':'source_unavailable');
}

/** Internal owner assembly. No per-user cache, timer, credentials, or sending capability. */
export function createPublicObservationAdapters({api,searchTool,transport}={}){
 void api;
 return {
  async weather({preferences,plans,now=Date.now(),context={}}={}){
   void plans;
   const location=preferences?.weatherLocation;
   if(!preferences?.city||location?.city!==preferences.city||!['user-selected','approved-geocode'].includes(location?.source))return result('needs_configuration','verified_city_coordinates_required');
   if(!isGuardedPublicTransport(transport))return result('unsupported','approved_transport_unavailable');
   try{return await loadObservation('weather',{...location,provider:'open-meteo'},async url=>{
    if(new URL(url).hostname!=='api.open-meteo.com')throw Error('Unexpected weather provider');
    await context.revalidate?.();const response=await transport.read(url,{kind:'json',signal:context.signal,assertCurrent:context.assertCurrent});await context.revalidate?.();return JSON.parse(response.body);
   },now)}catch(error){return failure(error)}
  },
  async interest({topic,now=Date.now(),context={}}={}){
   if(!topicAllowed(topic))return result('needs_configuration','explicit_non_sensitive_topic_required');
   if(!isGuardedPublicTransport(transport)||typeof searchTool?.execute!=='function')return result('unsupported','approved_search_or_transport_unavailable');
   try{
    context.signal?.throwIfAborted();context.assertCurrent?.();await context.revalidate?.();
    const found=await searchTool.execute({query:topic.trim()+' 最新进展',count:3},context);
    context.signal?.throwIfAborted();context.assertCurrent?.();await context.revalidate?.();
    if(!Array.isArray(found?.results)||!found.results.length)return result('empty','no_public_search_results');
    let incomplete=false,blocked=false;const seen=new Set();
    for(const source of found.results.slice(0,3)){
     const url=canonicalPublicSource(source?.url);
     if(!url){blocked=true;continue}if(seen.has(url))continue;seen.add(url);
     try{
      await context.revalidate?.();const page=await transport.read(url,{kind:'html',signal:context.signal,assertCurrent:context.assertCurrent});await context.revalidate?.();
      const item=verifiedPublicArticle({html:page.body,url:page.url,topic,now});
      if(item.status==='ready')return item;
      if(item.status==='partial'||item.status==='unsupported')incomplete=true;
     }catch(error){if(context.signal?.aborted||error?.code==='PROACTIVE_CONTEXT_CHANGED')return failure(error);const rejected=failure(error);if(rejected.status==='blocked')blocked=true;else incomplete=true}
    }
    return result(incomplete?'partial':blocked?'blocked':'empty',incomplete?'no_verified_publication_metadata':blocked?'source_blocked':'no_fresh_verified_item');
   }catch(error){return failure(error)}
  },
 };
}
