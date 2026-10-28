import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {historicalSeed} from '../../extensions/zhaoxi-native/quota.mjs';
import {registerQuota} from '../../extensions/zhaoxi-native/quota-provider.mjs';
import {checkModelQuota} from '../../extensions/tencent-weixin/build/src/messaging/quota-guard.js';

test('historical initialization requires complete fresh measured metadata, never unknown zero',()=>{
 const good={updatedAt:Date.now(),cacheStatus:{status:'fresh',pendingFiles:0,staleFiles:0},totals:{totalTokens:55},sessions:[]};
 assert.equal(historicalSeed(good).tokens,55);
 for(const change of [{partial:{reason:'time-budget'}},{cacheStatus:{status:'stale'}},{totals:{totalTokens:0,usageReport:{state:'unavailable'}}},{sessions:[{computing:true}]},{updatedAt:0},{totals:{}}])
  assert.throws(()=>historicalSeed({...good,...change}),/complete fresh/);
});

test('complete synchronous native usage can initialize history without optional cache metadata',()=>{
 const report={updatedAt:Date.now(),totals:{totalTokens:0},sessions:[]};
 assert.equal(historicalSeed(report).tokens,0);
 assert.equal(historicalSeed({...report,totals:{totalTokens:55}}).tokens,55);
 for(const change of [{partial:{reason:'time-budget'}},{cacheStatus:null},{cacheStatus:{}},{cacheStatus:{status:'fresh',pendingFiles:1}},{totals:{totalTokens:0,usageReport:{state:'unavailable'}}},{sessions:[{computing:true}]}])
  assert.throws(()=>historicalSeed({...report,...change}),/complete fresh/);
});

test('model gate fails closed for missing plugin, corrupt metadata or quota status errors',async()=>{
 for(const result of [null,{enabled:false},{enabled:true,limit:100,remaining:null},{enabled:true,limit:-1,remaining:20}])
  assert.equal((await checkModelQuota(async()=>result)).reason,'unavailable');
 assert.equal((await checkModelQuota(async()=>{throw Error('plugin unavailable')})).reason,'unavailable');
});

test('model gate refuses zero and insufficient conservative reservation; preserves existing unlimited admin policy',async()=>{
 assert.equal((await checkModelQuota(async()=>({enabled:true,limit:100,remaining:0}))).reason,'exhausted');
 assert.equal((await checkModelQuota(async()=>({enabled:true,limit:100,remaining:50,min_request_tokens:80}))).reason,'exhausted');
 assert.deepEqual(await checkModelQuota(async()=>({enabled:true,limit:100,remaining:80,min_request_tokens:80})),{allow:true});
 assert.deepEqual(await checkModelQuota(async()=>({enabled:true,limit:null,remaining:null})),{allow:true});
});

test('official provider classifier makes an application budget refusal terminal, without provider billing or auth penalties',()=>{
 let provider;const callbacks=[];
 registerQuota({registerProvider:p=>{provider=p},registerGatewayMethod:()=>{},on:(...args)=>callbacks.push(args)});
 assert.equal(provider.classifyFailoverReason({errorMessage:'400 Invalid request [PRODUCT_TOKEN_BUDGET]: monthly product budget cannot reserve another request.'}),'format');
 assert.equal(provider.classifyFailoverReason({errorMessage:'Quota history needs verified initialization'}),'format');
 assert.equal(provider.classifyFailoverReason({errorMessage:'HTTP 429 service rate limit'}),undefined);
 assert.deepEqual(callbacks.map(x=>x[0]),['gateway_stop']);
 assert.equal(typeof provider.wrapSimpleCompletionStreamFn,'function');
});

test('source orders authenticated non-model personal controls before quota and preserves no-fallback guard',()=>{
 const text=fs.readFileSync(new URL('../../extensions/tencent-weixin/src/messaging/process-message.ts',import.meta.url),'utf8');
 assert.ok(text.indexOf('dafeiyu.businessChat')<text.indexOf('const quota = await checkModelQuota'));
 assert.ok(text.indexOf('const quota = await checkModelQuota')<text.indexOf('const runId = randomUUID()',text.indexOf('const quota = await checkModelQuota')));
 assert.match(text,/if \(!quota\.allow\)/);
});
