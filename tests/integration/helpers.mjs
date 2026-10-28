import {pathToFileURL, URL as FileURL} from 'node:url';
import path from 'node:path';
const root = process.env.ZHAOXI_TEST_OPENCLAW_ROOT ?? new FileURL('../../data/runtime/openclaw/',import.meta.url).pathname;
const official = await import(pathToFileURL(path.join(root,'dist/plugin-sdk/ssrf-runtime.js')).href);
import {createGuardedPublicTransport} from '../../extensions/dafeiyu-domain/proactive/public-http.mjs';
export const NOW=Date.parse('2026-10-27T06:00:00Z');
export const URL='https://news.example.com/posts/ai-update';
export function article({url=URL,title='AI model tools update',published='2026-10-27T12:00:00+08:00',type='NewsArticle',canonical=true,dateKey='datePublished',extra=''}={}){
 return `<html><head><title>${title}</title><meta property="og:title" content="${title}">${canonical?`<link rel="canonical" href="${url}">`:''}${extra}<script type="application/ld+json">${JSON.stringify({'@context':'https://schema.org','@type':type,headline:title,url,[dateKey]:published})}</script></head></html>`;
}
export function transport(handler,{lookup=async()=>[{address:'93.184.216.34',family:4}]}={}){
 const calls=[],settings=[];
 const sdk={isBlockedHostnameOrIp:official.isBlockedHostnameOrIp,fetchWithSsrFGuard:params=>{
  settings.push(params);
  return official.fetchWithSsrFGuard({...params,lookupFn:lookup,fetchImpl:async(url,init)=>{calls.push({url:String(url),init});return handler(String(url),init)}});
 }};
 return {transport:createGuardedPublicTransport(sdk),calls,settings};
}
export const htmlResponse=body=>new Response(body,{headers:{'Content-Type':'text/html; charset=utf-8'}});
