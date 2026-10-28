import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {identityId,defaults,transition} from '../../extensions/dafeiyu-domain/core/domain.mjs';
import {createBoundDomainService} from '../../extensions/dafeiyu-domain/core/service.mjs';
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'fish-synthetic-sender-'));
process.env.OPENCLAW_STATE_DIR=temporary;process.env.OPENCLAW_OAUTH_DIR=path.join(temporary,'credentials');
fs.mkdirSync(path.join(temporary,'openclaw-weixin/accounts'),{recursive:true});fs.mkdirSync(process.env.OPENCLAW_OAUTH_DIR,{recursive:true});
const {createWeixinBusinessDeliveryAdapter}=await import('../../extensions/tencent-weixin/build/src/messaging/business-delivery.js');
const tenant={id:identityId('primary','synthetic-owner'),account:'primary',sender:'synthetic-owner'};
const accountFile=path.join(temporary,'openclaw-weixin/accounts/primary.json'),allowFile=path.join(process.env.OPENCLAW_OAUTH_DIR,'openclaw-weixin-primary-allowFrom.json');
const contextFile=path.join(temporary,'openclaw-weixin/accounts/primary.context-tokens.json');
const config=()=>({plugins:{entries:{'dafeiyu-domain':{config:{shadowOnly:false}},'openclaw-weixin':{enabled:true}}},channels:{'openclaw-weixin':{enabled:true,accounts:{primary:{enabled:true}}}},bindings:[{agentId:tenant.id,match:{channel:'openclaw-weixin',accountId:'primary',peer:{kind:'direct',id:tenant.sender}}}]});
function setup(){fs.writeFileSync(accountFile,JSON.stringify({token:'synthetic-only',userId:tenant.sender,baseUrl:'https://ilinkai.weixin.qq.com'}));fs.writeFileSync(contextFile,JSON.stringify({[tenant.sender]:'synthetic-context'}));fs.rmSync(allowFile,{force:true});const current=config();return {current,adapter:createWeixinBusinessDeliveryAdapter({runtime:{config:{current:()=>current}}})};}
const args={tenant,assertCurrent:()=>{},previewMessage:'合成消息，不会真实发送'};
test('official QR credential owner admits only its existing single private route without creating pairing grants',async()=>{
 const {adapter}=setup();const cap=await adapter.authorize(args);cap.assertCurrent();assert.equal(fs.existsSync(allowFile),false);
});
test('cold proactive module sends the persisted private context without an inbound cache',async()=>{
  const {adapter}=setup(),original=globalThis.fetch;let submitted=0;
  globalThis.fetch=async(_url,init)=>{submitted++;assert.equal(JSON.parse(init.body).msg.context_token,'synthetic-context');return Response.json({ret:0,message_id:'synthetic-receipt'});};
  try{const capability=await adapter.authorize(args);const receipt=await adapter.send({tenant,capability,message:args.previewMessage,idempotencyKey:'business-reminder:'+randomUUID()});assert.equal(receipt.serverMessageId,'synthetic-receipt');assert.equal(submitted,1);}finally{globalThis.fetch=original;}
});
test('missing, invalid or another peer context is rejected before transport',async()=>{
  for(const change of [()=>fs.rmSync(contextFile),()=>fs.writeFileSync(contextFile,'invalid'),()=>fs.writeFileSync(contextFile,JSON.stringify({other:'foreign-context'})),()=>fs.writeFileSync(contextFile,JSON.stringify({[tenant.sender]:''}))]){
    const {adapter}=setup();change();await assert.rejects(adapter.authorize(args),/context/i);
  }
});
test('context rotation or deletion invalidates a prepared proactive send before network submission',async()=>{
  for(const change of [()=>fs.writeFileSync(contextFile,JSON.stringify({[tenant.sender]:'new-synthetic-context'})),()=>fs.rmSync(contextFile)]){
    const {adapter}=setup(),capability=await adapter.authorize(args),original=globalThis.fetch;let submitted=0;
    globalThis.fetch=async()=>{submitted++;return Response.json({ret:0});};
    try{change();assert.throws(()=>adapter.send({tenant,capability,message:args.previewMessage,idempotencyKey:'business-reminder:'+randomUUID()}));assert.equal(submitted,0);}finally{globalThis.fetch=original;}
  }
});
test('new proactive authorization reads the latest context persisted by another module',async()=>{
  const {adapter}=setup();await adapter.authorize(args);
  fs.writeFileSync(contextFile,JSON.stringify({[tenant.sender]:'latest-synthetic-context'}));
  const original=globalThis.fetch;
  globalThis.fetch=async(_url,init)=>{assert.equal(JSON.parse(init.body).msg.context_token,'latest-synthetic-context');return Response.json({ret:0,message_id:'synthetic-receipt'});};
  try{const capability=await adapter.authorize(args);await adapter.send({tenant,capability,message:args.previewMessage,idempotencyKey:'business-reminder:'+randomUUID()});}finally{globalThis.fetch=original;}
});
test('unknown, foreign grant, disabled receiver, different endpoint and foreign route all reject',async()=>{
 for(const change of [x=>x.current.bindings.splice(0),x=>x.current.bindings[0].match.peer.id='other',x=>x.current.channels['openclaw-weixin'].accounts.primary.enabled=false,
  ()=>fs.writeFileSync(allowFile,JSON.stringify({allowFrom:['other']})),()=>fs.writeFileSync(accountFile,JSON.stringify({token:'synthetic-only',userId:'other',baseUrl:'https://ilinkai.weixin.qq.com'})),
  ()=>fs.writeFileSync(accountFile,JSON.stringify({token:'synthetic-only',userId:tenant.sender,baseUrl:'https://other.example.com'}))]){
  const value=setup();change(value);await assert.rejects(value.adapter.authorize(args));
 }
});
test('retained credential cannot survive rotation or be used for another target, body or second submission',async()=>{
 const {adapter}=setup();let submitted=0;const original=globalThis.fetch;
 globalThis.fetch=async(_url,init)=>{submitted++;const body=JSON.parse(init.body);assert.equal(body.msg.to_user_id,tenant.sender);return Response.json({ret:0,message_id:'synthetic-receipt'});};
 try{
  const old=await adapter.authorize(args);fs.writeFileSync(accountFile,JSON.stringify({token:'rotated-synthetic-only',userId:tenant.sender,baseUrl:'https://ilinkai.weixin.qq.com'}));
  assert.throws(()=>adapter.send({tenant,capability:old,message:args.previewMessage,idempotencyKey:'business-reminder:'+randomUUID()}));assert.equal(submitted,0);
  const capability=await adapter.authorize(args),send={tenant,capability,message:args.previewMessage,idempotencyKey:'business-reminder:'+randomUUID()};
  assert.throws(()=>adapter.send({...send,tenant:{...tenant,sender:'other'}}));
  assert.throws(()=>adapter.send({...send,message:'different'}));
  const receipt=await adapter.send(send);assert.equal(receipt.serverMessageId,'synthetic-receipt');assert.equal(submitted,1);
  assert.throws(()=>adapter.send(send));assert.equal(submitted,1);
 }finally{globalThis.fetch=original;}
});
test('the official successful response can omit zero-valued ret and server message ID',async()=>{
 const {adapter}=setup(),capability=await adapter.authorize(args),original=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({});
  try{const receipt=await adapter.send({tenant,capability,message:args.previewMessage,idempotencyKey:'business-reminder:'+randomUUID()});assert.ok(receipt.messageId);}finally{globalThis.fetch=original;}
});
test('HTTP failure, invalid receipt and explicit Tencent rejection never become accepted',async()=>{
 for(const response of [()=>new Response('unavailable',{status:503}),()=>Response.json(null),()=>Response.json({ret:-1}),()=>Response.json({errcode:-14}),()=>Response.json({ret:0,errcode:-2})]){
  const {adapter}=setup(),capability=await adapter.authorize(args),original=globalThis.fetch;
  globalThis.fetch=async()=>response();
  try{await assert.rejects(adapter.send({tenant,capability,message:args.previewMessage,idempotencyKey:'business-reminder:'+randomUUID()}));}finally{globalThis.fetch=original;}
 }
});
test('legacy read projection adds disabled fields and false readiness without changing stored choices',async()=>{
 const state=defaults();delete state.preferences.categories.memory;delete state.preferences.weatherLocation;
 state.preferences.enabled=true;state.preferences.paused=false;state.preferences.greetingLimit=4;const before=JSON.stringify(state);
 const service=createBoundDomainService({runtime:{state:{openKeyedStoreV2:()=>({lookup:async()=>state})},config:{current:()=>({})}}},tenant,()=>{},{kind:'fixture'});
 const view=await service.read();assert.equal(view.preferences.categories.memory,false);assert.equal(view.preferences.weatherLocation,null);assert.equal(view.preferences.greetingLimit,4);assert.equal(view.proactiveStatus.deliveryReady,false);assert.equal(JSON.stringify(state),before);
 const changed=transition(state,{action:'preferences.propose',id:'new',requestId:'new',value:{city:'合成城'}},{consent:'verified-web-choice'},Date.now());
 assert.equal(changed.state.preferences.categories.memory,false);assert.equal(changed.state.preferences.enabled,true);assert.equal(changed.result.preferences.city,'合成城');assert.equal(changed.state.preferences.city,null);
});
test.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
