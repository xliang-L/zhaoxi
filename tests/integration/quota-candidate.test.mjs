import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {QuotaLedger,monthKey,measuredTokens,wrapQuotaStream,quotaRequest} from '../../extensions/zhaoxi-native/quota.mjs';
import {quotaFor} from '../../extensions/zhaoxi-native/quota-provider.mjs';

const OCT=Date.parse('2026-10-26T12:00:00Z');
function fixture({limit=1000,zero=true}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fish-quota-')),state=path.join(root,'space','openclaw');fs.mkdirSync(state,{recursive:true});
 const file=path.join(state,'quota-policy.json');const policy={version:1,limit,activationPeriod:'2026-10',initialKnownZero:zero,timezone:'Asia/Shanghai'};fs.writeFileSync(file,JSON.stringify(policy),{mode:0o600});
 let now=OCT;const ledger=new QuotaLedger(state,{clock:()=>now});return {root,state,file,policy,ledger,tick:v=>{now=v},close:()=>ledger.close()};
}
const done=usage=>({role:'assistant',content:[],usage});
function source(message){return {async *[Symbol.asyncIterator](){yield {type:'done',message}},async result(){return message}}}

test('Beijing natural month boundary ignores machine timezone',()=>{
 assert.equal(monthKey(Date.parse('2026-10-31T15:59:59Z')),'2026-10');assert.equal(monthKey(Date.parse('2026-10-31T16:00:00Z')),'2026-11');
});
test('reported total is not increased by cached input, reasoning or tool counters',()=>{
 assert.equal(measuredTokens({total_tokens:130,input_tokens:100,output_tokens:30,input_tokens_details:{cached_tokens:60},reasoning_tokens:20}),130);
 assert.equal(measuredTokens({input:40,output:30,cacheRead:60,cacheWrite:0}),130);
 assert.equal(measuredTokens({total:130,input:40,output:30,cacheRead:60}),130);
 assert.equal(measuredTokens({input_tokens:100,output_tokens:30,input_tokens_details:{cached_tokens:60}}),130);
 assert.equal(measuredTokens({input:0,output:0,cacheRead:0,cacheWrite:0}),null);
 assert.equal(measuredTokens({totalTokens:0,usageReport:{state:'unavailable'}}),null);
 assert.equal(measuredTokens({totalTokens:0,usageReport:{state:'available'}}),0);
});
test('existing bound history must be seeded completely and cannot be reset',()=>{
 const f=fixture({zero:false});assert.throws(()=>f.ledger.reserve('a',10),/verified initialization/);
 assert.throws(()=>f.ledger.seed('2026-10',70,{complete:false,asOf:new Date(OCT).toISOString()}),/complete historical/);
 f.ledger.seed('2026-10',70,{complete:true,asOf:new Date(OCT).toISOString()});assert.equal(f.ledger.view().used_tokens,70);
 assert.throws(()=>f.ledger.seed('2026-10',0,{complete:true,asOf:new Date(OCT).toISOString()}),/do not reset/);assert.equal(f.ledger.view().used_tokens,70);f.close();
});
test('atomic admission subtracts reservations and rejects exhaustion',()=>{
 const f=fixture({limit:100});f.ledger.reserve('a',60);assert.throws(()=>f.ledger.reserve('b',41),/PRODUCT_TOKEN_BUDGET/);f.ledger.reserve('b',40);assert.equal(f.ledger.view().remaining,0);assert.equal(f.ledger.view().reserved_tokens,100);f.close();
});
test('settlement is idempotent and refunds only unused reservation',()=>{
 const f=fixture({limit:100});f.ledger.reserve('a',80);f.ledger.start('a');f.ledger.settle('a',35);f.ledger.settle('a',35);assert.equal(f.ledger.view().used_tokens,35);assert.equal(f.ledger.view().remaining,65);assert.equal(f.ledger.view().reserved_tokens,0);assert.throws(()=>f.ledger.settle('a',20),/do not rewrite/);f.close();
});
test('only proven unstarted calls refund; unknown result survives restart',()=>{
 const f=fixture({limit:100});f.ledger.reserve('unstarted',10);f.ledger.releaseUnstarted('unstarted');f.ledger.reserve('a',70);f.ledger.start('a');f.ledger.unknown('a');assert.throws(()=>f.ledger.releaseUnstarted('a'),/cannot be refunded/);f.close();
 const next=new QuotaLedger(f.state,{clock:()=>OCT});assert.equal(next.view().reserved_tokens,70);assert.equal(next.call('a').status,'unknown');assert.throws(()=>next.reserve('new',31),/PRODUCT_TOKEN_BUDGET/);next.settle('a',20);assert.equal(next.view().used_tokens,20);next.close();
});
test('month rollover retains old usage and fixes in-flight call to its admission month',()=>{
 const f=fixture();f.tick(Date.parse('2026-10-31T15:59:59Z'));f.ledger.reserve('a',100);f.ledger.start('a');f.tick(Date.parse('2026-10-31T16:00:01Z'));f.ledger.settle('a',40);assert.equal(f.ledger.view().period,'2026-11');assert.equal(f.ledger.view().used_tokens,0);assert.equal(f.ledger.db.prepare('SELECT spent FROM quota_periods WHERE period=?').get('2026-10').spent,40);f.close();
});
test('provider wrapper blocks before delegate, preserves terminal usage and no double charge on result()',async()=>{
 const f=fixture({limit:10000});let calls=0;const wrap=wrapQuotaStream(()=>{calls++;return source(done({input:10,output:3,cacheRead:7,total:20}))},f.ledger);
 const stream=await wrap({contextWindow:50,maxTokens:10},{messages:[]},{maxTokens:10});for await(const _ of stream){}await stream.result();assert.equal(calls,1);assert.equal(f.ledger.view().used_tokens,20);assert.equal(f.ledger.view().reserved_tokens,0);f.close();
 const g=fixture({limit:10});const blocked=wrapQuotaStream(()=>{calls++;return source(done({total:1}))},g.ledger);await assert.rejects(blocked({contextWindow:50,maxTokens:10},{messages:[]},{maxTokens:10}),/PRODUCT_TOKEN_BUDGET/);assert.equal(calls,1);g.close();
});
test('cancel before provider start releases, failure after admission holds',async()=>{
 const f=fixture({limit:20000});let calls=0;const wrap=wrapQuotaStream(()=>{calls++;throw Error('transport outcome unknown')},f.ledger);const c=new AbortController();c.abort(Error('cancelled'));
 await assert.rejects(wrap({contextWindow:10,maxTokens:1},{},{maxTokens:1,signal:c.signal}),/cancelled/);assert.equal(f.ledger.view().reserved_tokens,0);assert.equal(calls,0);
 await assert.rejects(wrap({contextWindow:10,maxTokens:1},{},{maxTokens:1}),/outcome unknown/);assert.ok(f.ledger.view().reserved_tokens>0);assert.equal(calls,1);f.close();
});
test('raw search request uses same ledger even if results later fail source validation',async()=>{
 const f=fixture({limit:100});const result=await quotaRequest(f.ledger,80,async()=>({usage:{input_tokens:30,output_tokens:10,total_tokens:40},output:[]}));assert.deepEqual(result.output,[]);assert.equal(f.ledger.view().used_tokens,40);assert.equal(f.ledger.view().reserved_tokens,0);f.close();
});
test('upstream over-reservation is recorded rather than clamped or refunded',()=>{
 const f=fixture({limit:100});f.ledger.reserve('a',80);f.ledger.start('a');assert.equal(f.ledger.settle('a',120).overReservation,true);assert.equal(f.ledger.view().used_tokens,120);assert.equal(f.ledger.view().remaining,0);assert.throws(()=>f.ledger.reserve('b',1),/PRODUCT_TOKEN_BUDGET/);f.close();
});
test('per-account counters stay isolated',()=>{
 const a=fixture({limit:100}),b=fixture({limit:100});a.ledger.reserve('same-id',100);b.ledger.reserve('same-id',20);assert.equal(a.ledger.view().remaining,0);assert.equal(b.ledger.view().remaining,80);a.close();b.close();
});
test('real concurrent SQLite reservations cannot oversubscribe',async()=>{
 const f=fixture({limit:100});f.close();const url=new URL('../../extensions/zhaoxi-native/quota.mjs',import.meta.url).href;
 const attempts=Array.from({length:12},(_,i)=>new Promise((resolve,reject)=>{const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');(async()=>{const {QuotaLedger}=await import(workerData.url);const l=new QuotaLedger(workerData.state,{clock:()=>${OCT}});try{l.reserve('r-'+workerData.i,20);parentPort.postMessage(true)}catch{parentPort.postMessage(false)}finally{l.close()}})()`,{eval:true,workerData:{url,state:f.state,i}});worker.once('message',resolve);worker.once('error',reject)}));
 assert.equal((await Promise.all(attempts)).filter(Boolean).length,5);const after=new QuotaLedger(f.state,{clock:()=>OCT});assert.equal(after.view().reserved_tokens,100);after.close();
});
test('provider boundary rejects foreign workspace, unknown/group sender and policy identity spoof',()=>{
 const f=fixture();const own=path.join(path.dirname(f.state),'workspace','peers','one');fs.mkdirSync(own,{recursive:true});const sender='synthetic-A';const fingerprint=createHash('sha256').update(JSON.stringify(['primary',sender.toLowerCase()])).digest('hex');fs.writeFileSync(f.file,JSON.stringify({...f.policy,spaceId:'space',bindingFingerprint:fingerprint}));
 const cfg={plugins:{entries:{'zhaoxi-native':{config:{quotaEnabled:true}}}},bindings:[{agentId:'one',match:{channel:'openclaw-weixin',accountId:'primary',peer:{kind:'direct',id:sender}}}],agents:{entries:{one:{workspace:own}}}};
 const old=process.env.OPENCLAW_STATE_DIR;process.env.OPENCLAW_STATE_DIR=f.state;const api={runtime:{config:{current:()=>cfg}}};
 try{assert.ok(quotaFor(api,{workspaceDir:own}));assert.throws(()=>quotaFor(api,{workspaceDir:os.tmpdir()}),/authenticated private/);cfg.bindings[0].match.peer.kind='group';assert.throws(()=>quotaFor(api),/authenticated private/);cfg.bindings[0].match.peer.kind='direct';cfg.bindings[0].match.peer.id='synthetic-B';assert.throws(()=>quotaFor(api),/authenticated private/)}finally{if(old===undefined)delete process.env.OPENCLAW_STATE_DIR;else process.env.OPENCLAW_STATE_DIR=old;f.close()}
});
