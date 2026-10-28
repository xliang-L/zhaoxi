import {isIP} from 'node:net';

const transports=new WeakSet();
const sensitiveKey=/^(?:access_?token|refresh_?token|token|authorization|api_?key|password|credential|session(?:id)?|signature)$/i;
export class PublicSourceError extends Error{constructor(code){super(code);this.name='PublicSourceError';this.code=code}}

/** Syntax restriction only. The official guard still resolves/pins DNS for every hop. */
export function canonicalPublicSource(value){
 try{
  if(typeof value!=='string'||value.length>500||/[\x00-\x20\x7f\\]/.test(value))return null;
  const u=new URL(value),host=u.hostname.toLowerCase();
  if(u.protocol!=='https:'||u.username||u.password||u.port||isIP(host.replace(/^\[|\]$/g,'')))return null;
  if(!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)||host.includes('xn--'))return null;
  if(/(?:^|\.)(?:localhost|local|internal|lan|home|invalid|test|example|onion)$/.test(host))return null;
  for(const key of [...u.searchParams.keys()]){
   if(sensitiveKey.test(key))return null;
   if(/^utm_|^(?:gclid|fbclid)$/i.test(key))u.searchParams.delete(key);
  }
  u.hash='';u.searchParams.sort();u.pathname=u.pathname.replace(/\/+$/,'')||'/';
  return u.href;
 }catch{return null}
}

export const isGuardedPublicTransport=value=>Boolean(value&&transports.has(value));

/** Internal assembly only: inject openclaw/plugin-sdk/ssrf-runtime, never RPC arguments. */
export function createGuardedPublicTransport(sdk){
 if(typeof sdk?.fetchWithSsrFGuard!=='function'||typeof sdk.isBlockedHostnameOrIp!=='function')throw new PublicSourceError('official_ssrf_sdk_required');
 const transport=Object.freeze({
  async read(url,{kind='html',signal,assertCurrent}={}){
   const canonical=canonicalPublicSource(url);
   if(!canonical||sdk.isBlockedHostnameOrIp(new URL(canonical).hostname))throw new PublicSourceError('blocked_public_url');
   if(!['html','json'].includes(kind))throw new PublicSourceError('unsupported_content_type');
   signal?.throwIfAborted();assertCurrent?.();
   let guarded;
   try{
    guarded=await sdk.fetchWithSsrFGuard({url:canonical,mode:'strict',pinDns:true,requireHttps:true,maxRedirects:2,
     timeoutMs:8000,signal,capture:false,auditContext:'proactive-public-source',
     // hostnameAllowlist restricts hosts; allowedHostnames would exempt private DNS and is forbidden here.
     policy:{hostnameAllowlist:[new URL(canonical).hostname]},
     beforeRequest:()=>{signal?.throwIfAborted();assertCurrent?.()},
     init:{method:'GET',credentials:'omit',headers:{Accept:kind==='json'?'application/json':'text/html, application/xhtml+xml'}}});
    signal?.throwIfAborted();assertCurrent?.();
    const finalUrl=canonicalPublicSource(guarded.finalUrl),response=guarded.response;
    if(!finalUrl||new URL(finalUrl).hostname!==new URL(canonical).hostname)throw new PublicSourceError('blocked_redirect');
    if(!response?.ok)throw new PublicSourceError(response?.status===401||response?.status===403?'source_blocked':'source_http_error');
    const contentType=(response.headers.get('content-type')??'').toLowerCase().split(';')[0].trim();
    if(!(kind==='json'?contentType==='application/json':['text/html','application/xhtml+xml'].includes(contentType)))throw new PublicSourceError('unsupported_content_type');
    const declared=Number(response.headers.get('content-length'));
    if(Number.isFinite(declared)&&declared>512000)throw new PublicSourceError('source_too_large');
    if(!response.body)throw new PublicSourceError('empty_source');
    const reader=response.body.getReader(),chunks=[];let bytes=0;
    try{
     for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>512000)throw new PublicSourceError('source_too_large');chunks.push(value);signal?.throwIfAborted();assertCurrent?.()}
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
    const body=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
    return {url:finalUrl,contentType,body};
   }finally{if(guarded?.response?.body&&!guarded.response.body.locked)await guarded.response.body.cancel().catch(()=>{});await guarded?.release?.()}
  },
 });
 transports.add(transport);return transport;
}
