import test from 'node:test';
import assert from 'node:assert/strict';
import {transport,htmlResponse,URL} from './helpers.mjs';

test('uses actual installed public SDK with strict DNS-pinned HTTPS policy and releases body',async()=>{
 const t=transport(()=>htmlResponse('safe'));
 assert.equal((await t.transport.read(URL)).body,'safe');assert.equal(t.calls.length,1);
 const p=t.settings[0];assert.equal(p.mode,'strict');assert.equal(p.pinDns,true);assert.equal(p.requireHttps,true);
 assert.deepEqual(p.policy,{hostnameAllowlist:['news.example.com']});assert.equal(p.capture,false);
 assert.equal(p.init.credentials,'omit');assert.equal(p.init.headers.Authorization,undefined);
 assert.ok(t.calls[0].init.dispatcher);
});

test('official DNS guard blocks a public hostname resolving to private or mixed addresses before transport',async()=>{
 for(const addresses of [[{address:'127.0.0.1',family:4}],[{address:'10.0.0.1',family:4}],[{address:'93.184.216.34',family:4},{address:'192.168.1.2',family:4}],[{address:'::1',family:6}]]){
  const t=transport(()=>htmlResponse('never'),{lookup:async()=>addresses});
  await assert.rejects(t.transport.read(URL));assert.equal(t.calls.length,0);
 }
});

test('same-host HTTPS redirect is guarded, while private, cross-host and HTTPS downgrade redirects are blocked',async()=>{
 const t=transport(url=>url===URL?new Response('',{status:302,headers:{Location:URL+'-final'}}):htmlResponse('final'));
 assert.equal((await t.transport.read(URL)).url,URL+'-final');assert.equal(t.calls.length,2);
 for(const location of ['https://127.0.0.1/private','https://evil.example.com/a','http://news.example.com/a']){
  const blocked=transport(()=>new Response('',{status:302,headers:{Location:location}}));
  await assert.rejects(blocked.transport.read(URL));assert.equal(blocked.calls.length,1);
 }
});

test('bounds content type, declared and streamed bytes, with no arbitrary fallback fetch',async()=>{
 let t=transport(()=>new Response('data',{headers:{'Content-Type':'application/pdf'}}));
 await assert.rejects(t.transport.read(URL),/unsupported_content_type/);
 t=transport(()=>new Response('x',{headers:{'Content-Type':'text/html','Content-Length':'999999'}}));
 await assert.rejects(t.transport.read(URL),/source_too_large/);
 t=transport(()=>htmlResponse('x'.repeat(512001)));
 await assert.rejects(t.transport.read(URL),/source_too_large/);
});

test('abort or revoked caller before request produces no network attempt',async()=>{
 const t=transport(()=>htmlResponse('never')),controller=new AbortController();controller.abort();
 await assert.rejects(t.transport.read(URL,{signal:controller.signal}));
 await assert.rejects(t.transport.read(URL,{assertCurrent:()=>{throw Error('revoked')}}));
 assert.equal(t.calls.length,0);
});
