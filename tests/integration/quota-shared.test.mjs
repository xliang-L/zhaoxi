import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {QuotaLedger} from '../../extensions/zhaoxi-native/quota.mjs';
import {ensureQuotaHistory} from '../../extensions/zhaoxi-native/quota-provider.mjs';

function fixture({known=true}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'shared-agent-quota-'));
 const primary=path.join(root,'primary'),secondary=path.join(root,'secondary');
 for(const state of [primary,secondary]){
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state,'quota-policy.json'),JSON.stringify({version:1,limit:100,timezone:'Asia/Shanghai',activationPeriod:'2026-10',initialKnownZero:known}));
 }
 const clock=()=>Date.parse('2026-10-27T04:00:00Z');
 const a=new QuotaLedger(primary,{clock}),b=new QuotaLedger(secondary,{clock,ledgerState:primary});
 return {root,primary,secondary,a,b,close(){a.close();b.close();fs.rmSync(root,{recursive:true,force:true});}};
}

test('two assistants consume one budget and one reservation ledger',()=>{
 const f=fixture();try{
  f.a.reserve('first-call',60);f.a.start('first-call');
  assert.equal(f.b.view().reserved_tokens,60);
  assert.throws(()=>f.b.reserve('second-call',50),/PRODUCT_TOKEN_BUDGET/);
  f.a.settle('first-call',20);
  assert.equal(f.b.view().used_tokens,20);assert.equal(f.b.view().remaining,80);
  f.b.reserve('second-call',70);f.b.start('second-call');f.b.settle('second-call',30);
  assert.equal(f.a.view().used_tokens,50);assert.equal(f.a.view().reserved_tokens,0);
  assert.equal(fs.existsSync(path.join(f.secondary,'quota.sqlite3')),false);
 }finally{f.close();}
});

test('a secondary policy cannot increase the shared primary limit',()=>{
 const f=fixture();try{
  const file=path.join(f.secondary,'quota-policy.json');const p=JSON.parse(fs.readFileSync(file));p.limit=999999;fs.writeFileSync(file,JSON.stringify(p));
  assert.equal(f.b.view().limit,100);assert.throws(()=>f.b.reserve('too-large',101),/PRODUCT_TOKEN_BUDGET/);
  const primary=path.join(f.primary,'quota-policy.json');p.limit=40;fs.writeFileSync(primary,JSON.stringify(p));
  assert.equal(f.a.view().limit,40);assert.equal(f.b.view().limit,40);
 }finally{f.close();}
});

test('a new assistant cannot initialize unknown shared history from its own empty chat',async()=>{
 const f=fixture({known:false});try{
  let nativeReads=0;
  await assert.rejects(ensureQuotaHistory({runtime:{config:{current(){nativeReads++;throw Error('must not request only secondary history');}}}},f.b),/primary assistant/);
  assert.equal(nativeReads,0);
  f.a.seed('2026-10',55,{complete:true,asOf:'2026-10-27T04:00:00Z'});
  assert.equal(f.b.view().used_tokens,55);assert.equal(f.b.view().remaining,45);
 }finally{f.close();}
});
