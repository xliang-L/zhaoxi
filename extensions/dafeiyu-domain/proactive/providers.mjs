import {hour,nonSensitive,canonicalPublicUrl} from './proactive-policy.mjs';
/** Existing approved adapters; no default network client and no implicit location. */
export async function loadObservation(kind,config,transport,now=Date.now()){
 if(!config)return {status:'needs_configuration',observation:null};
 if(typeof transport!=='function')return {status:'approved_transport_unavailable',observation:null};
 if(kind==='weather'){
  if(config.provider!=='open-meteo'||!config.city||!Number.isFinite(config.latitude)||!Number.isFinite(config.longitude)||Math.abs(config.latitude)>90||Math.abs(config.longitude)>180)return {status:'needs_configuration',observation:null};
  const url=new URL('https://api.open-meteo.com/v1/forecast');url.search=new URLSearchParams({latitude:String(config.latitude),longitude:String(config.longitude),hourly:'temperature_2m,precipitation_probability',forecast_days:'2',timezone:'UTC'}).toString();
  const data=await transport(url.href),h=data?.hourly;
  if(!Array.isArray(h?.time)||!Array.isArray(h?.temperature_2m)||h.time.length!==h.temperature_2m.length)throw Error('Invalid weather observation');
  const times=h.time.map(t=>typeof t==='string'?Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(t)?t:t+'Z'):NaN),i=times.findIndex(t=>t>=now);
  if(i<0||i+6>=times.length||times[i]-now>hour||times[i+6]-times[i]!==6*hour)throw Error('No current six-hour forecast');
  const previousC=h.temperature_2m[i],currentC=h.temperature_2m[i+6];if(!Number.isFinite(previousC)||!Number.isFinite(currentC))throw Error('Missing forecast temperatures');
  const rain=Array.isArray(h.precipitation_probability)?h.precipitation_probability.slice(i,i+7):[],valid=rain.length===7&&rain.every(x=>Number.isFinite(x)&&x>=0&&x<=100),rainProbability=valid?Math.max(...rain):null;
  return {status:'ready',observation:{id:`${config.city}:${times[i]}:6h`,provider:'open-meteo',category:'weather',city:config.city,source:url.href,observedAt:now,confidence:0.9,previousC,currentC,forecastStartAt:times[i],forecastEndAt:times[i+6],forecast:true,rainProbability,...(valid&&rain[0]<30&&rainProbability>=70?{rainChange:'dry-to-rain'}:{})}};
 }
 if(kind==='interest'){
  if(config.provider!=='nasa-news'||config.topic!=='天文')return {status:'approved_topic_adapter_unavailable',observation:null};
  const after=new Date(now-48*hour).toISOString().replace(/\.\d{3}Z$/,'');
  const data=await transport('https://www.nasa.gov/wp-json/wp/v2/posts?per_page=5&orderby=date&order=desc&after='+encodeURIComponent(after));if(!Array.isArray(data))throw Error('Invalid interest observation');
  for(const item of data.slice(0,5)){
   const date=item?.date_gmt,publishedAt=Date.parse(typeof date==='string'&&!/[zZ]$|[+-]\d\d:\d\d$/.test(date)?date+'Z':date),title=typeof item?.title?.rendered==='string'?item.title.rendered.replace(/<[^>]*>/g,'').trim():'',url=canonicalPublicUrl(item?.link);
   if(item.status!=='publish'||!Number.isFinite(item.id)||!Number.isFinite(publishedAt)||publishedAt>now||now-publishedAt>48*hour||!url||!nonSensitive(title)||title.length>160||!/(telescope|galax|nebula|exoplanet|supernova|universe|hubble|webb|astronom|天文|宇宙|星系|行星|望远镜)/i.test(title))continue;
   return {status:'ready',observation:{id:'nasa-'+item.id,provider:'nasa-news',category:'interest',topic:'天文',source:url,url,title,publishedAt,observedAt:now,confidence:0.9}};
  }return {status:'no_fresh_verified_item',observation:null};
 }throw Error('Unknown provider kind');
}
/** Only the integration owner supplies an already-approved transport, never RPC args. */
export function createObservationAdapters(approvedTransport){if(typeof approvedTransport!=='function')return {};return {weather:({preferences,now})=>loadObservation('weather',preferences.weatherLocation?{...preferences.weatherLocation,provider:'open-meteo'}:null,approvedTransport,now),interest:({topic,now})=>loadObservation('interest',{provider:'nasa-news',topic},approvedTransport,now)};}
