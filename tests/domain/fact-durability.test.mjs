import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {transition,defaults} from '../../extensions/dafeiyu-domain/core/domain.mjs';
import {registerFactMemory} from '../../extensions/dafeiyu-domain/memory/fact-hooks.mjs';
import {fixture,peer,enable,userSource,hookRuntime,loadChannelSource,hostRoot} from './fact-test-fixtures.mjs';
const p=peer(),filename=fileURLToPath(import.meta.url);

async function channelFactApi(){
 const require=createRequire(hostRoot+'/package.json');
 const sdk=await import(pathToFileURL(require.resolve('openclaw/plugin-sdk/channel-outbound')));
 const {module}=await loadChannelSource('messaging/fact-ingress.ts');
 return {...module,bindIngressLifecycleToReplyOptions:sdk.bindIngressLifecycleToReplyOptions};
}
function queueFixture(state){
 const f=fixture();f.seed(state??enable());
 // This controlled queue holds provider identity/time only. Text is a fixed synthetic source fixture,
 // not a new production pending-body store; the native queue's existing payload format is unchanged.
 f.db.exec('CREATE TABLE native_queue(id TEXT PRIMARY KEY,state TEXT,sourceAt INTEGER)');
 f.db.prepare('INSERT INTO native_queue VALUES(?,?,?)').run('synthetic-source','pending',Date.now());return f;
}
function childRun(f,mode='normal',text='我常住上海'){
 const child=spawn(process.execPath,[filename,'--synthetic-child',f.database,mode,text],{
  env:{ZHAOXI_TEST_OPENCLAW_ROOT:hostRoot},stdio:['ignore','ignore','pipe','ipc'],
 });
 let stderr='';child.stderr.on('data',value=>{stderr+=value.toString()});
 const events=[];child.on('message',value=>events.push(value));
 return {child,async event(phase){
  const cached=events.find(e=>e.phase===phase);if(cached)return cached;
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Synthetic child phase timeout: '+phase))},10000);
   const message=value=>{if(value.phase===phase){clearTimeout(timer);child.off('message',message);child.off('exit',exit);resolve(value)}};
   const exit=code=>{clearTimeout(timer);child.off('message',message);reject(Error('Synthetic child exited before '+phase+': '+code+' '+stderr))};
   child.on('message',message);child.once('exit',exit);
  });
 },async kill(){const exit=once(child,'exit');child.kill('SIGKILL');await exit;},async finish(){const result=await this.event('done');if(child.exitCode===null)await once(child,'exit');return result;}};
}
async function runChild(){
 const [, , ,database,mode,text]=process.argv;
 const f=fixture({path:database}),row=f.db.prepare('SELECT * FROM native_queue').get();
 if(row.state==='completed'){f.close();process.send?.({phase:'done',polledCompleted:true,adopted:false});process.disconnect();return;}
 const open=f.api.runtime.state.openKeyedStoreV2;let held=false;
 f.api.runtime.state.openKeyedStoreV2=(...args)=>{
  const store=open(...args);return {...store,async compareAndApply(...values){
   if(!held&&mode==='before-commit'){held=true;process.send?.({phase:'before-commit'});await new Promise(()=>{});}
   const result=await store.compareAndApply(...values);
   if(!held&&mode==='after-commit'){held=true;process.send?.({phase:'after-commit'});await new Promise(()=>{});}
   if(!held&&mode==='unknown-commit'){held=true;throw Error('Synthetic uncertain commit response');}
   return result;
  }};
 };
 hookRuntime.clearInternalHooks();registerFactMemory(f.api);
 const api=await channelFactApi();
 const assertAdmissionCurrent=()=>{if(f.db.prepare('SELECT state FROM native_queue').get().state!=='pending')throw Error('Synthetic claim no longer current')};
 const completion=api.emitVerifiedFactIngress({...p,assertAdmissionCurrent,sources:[{receivedAt:row.sourceAt,message:{message_id:row.id,from_user_id:p.sender,message_type:1,create_time_ms:row.sourceAt,item_list:[{type:1,text_item:{text}}]}}]});
 let adopted=false;
 const lifecycle=api.withFactAdoptionBarrier({abortSignal:new AbortController().signal,onDeferred(){},onAbandoned(){},onAdopted(){assertAdmissionCurrent();f.db.prepare("UPDATE native_queue SET state='completed'").run();adopted=true;}},completion,assertAdmissionCurrent);
 const bound=api.bindIngressLifecycleToReplyOptions(lifecycle);
 try{await bound.turnAdoptionLifecycle.onAdopted();}catch{}
 const receipt=await completion;
 if(mode==='after-adopted'){process.send?.({phase:'after-adopted'});await new Promise(()=>{});}
 f.close();process.send?.({phase:'done',adopted,receipt});process.disconnect();
}

if(process.argv[2]==='--synthetic-child')await runChild();
else{
 for(const phase of ['before-commit','after-commit','after-adopted'])test('process crash '+phase+' never completes an input ahead of the fact decision',async()=>{
  const f=queueFixture();const stopped=childRun(f,phase);await stopped.event(phase);
  const before=f.read();assert.equal(f.db.prepare('SELECT state FROM native_queue').get().state,phase==='after-adopted'?'completed':'pending');
  assert.equal(Object.keys(before.facts).length,phase==='before-commit'?0:1);await stopped.kill();
  const recovered=await childRun(f).finish();assert.equal(f.db.prepare('SELECT state FROM native_queue').get().state,'completed');
  assert.equal(f.read().facts['auto:profile.city'].value,'上海');assert.equal(f.read().facts['auto:profile.city'].revision,1);
  if(phase==='after-commit')assert.deepEqual(recovered.receipt.outcomes,['duplicate']);
  const revision=f.read().revision;const repeated=await childRun(f).finish();assert.equal(repeated.polledCompleted,true);assert.equal(f.read().revision,revision);f.close();
 });
 test('an uncertain committed response stays unacknowledged, then reconciles the same message receipt',async()=>{
  const f=queueFixture(),first=await childRun(f,'unknown-commit').finish();
  assert.equal(first.adopted,false);assert.equal(first.receipt.settled,false);assert.equal(f.db.prepare('SELECT state FROM native_queue').get().state,'pending');assert.equal(Object.keys(f.read().facts).length,1);
  const second=await childRun(f).finish();assert.equal(second.adopted,true);assert.deepEqual(second.receipt.outcomes,['duplicate']);assert.equal(f.read().facts['auto:profile.city'].revision,1);f.close();
 });
 test('off committed during a crashed input is rechecked before replay can store a fact',async()=>{
  const f=queueFixture(),stopped=childRun(f,'before-commit');await stopped.event('before-commit');await stopped.kill();
  f.seed(transition(f.read(),{action:'fact.auto.disable',requestId:'synthetic-off'},userSource(p),Date.now()).state);
  const result=await childRun(f).finish();assert.equal(result.adopted,true);assert.deepEqual(result.receipt.outcomes,['memory_off']);assert.deepEqual(f.read().facts,{});f.close();
 });
 test('delete tombstone committed before restart blocks the unseen queued statement',async()=>{
  const f=queueFixture();const first=await childRun(f).finish();assert.equal(first.adopted,true);
  f.db.prepare("UPDATE native_queue SET id='unseen-delayed-source',state='pending'").run();
  const stopped=childRun(f,'before-commit');await stopped.event('before-commit');await stopped.kill();
  const fact=f.read().facts['auto:profile.city'];let step=transition(f.read(),{action:'fact.delete.prepare',id:fact.id,expectedRevision:fact.revision,requestId:'delete-prepare'},userSource(p),Date.now());
  step=transition(step.state,{action:'fact.delete.confirm',id:fact.id,expectedRevision:fact.revision,requestId:'delete-confirm',value:{nonce:step.result.nonce}},userSource(p),Date.now());f.seed(step.state);
  const result=await childRun(f).finish();assert.equal(result.adopted,true);assert.deepEqual(result.receipt.outcomes,['stale']);assert.deepEqual(f.read().facts,{});assert.ok(f.read().factTombstones['profile.city']);f.close();
 });
 test('secret filtering and a disabled user have durable terminal decisions without a pending raw body',async()=>{
  for(const [state,text,expected] of [[enable(),'我常住上海，token=SYNTHETIC_NOT_PERSISTED','filtered'],[undefined,'我常住上海','memory_off']]){
   const f=queueFixture(state??defaults());
   const result=await childRun(f,'normal',text).finish();assert.equal(result.adopted,true);assert.deepEqual(result.receipt.outcomes,[expected]);assert.deepEqual(f.read().facts,{});
   const stored=JSON.stringify(f.db.prepare('SELECT value FROM records').all());assert.equal(stored.includes('SYNTHETIC_NOT_PERSISTED'),false);assert.equal(stored.includes('pendingBody'),false);assert.equal(stored.includes('registerCompletion'),false);f.close();
  }
 });
 test('missing fact handler refuses adoption and concurrent duplicate adoption waits on one decision',async()=>{
  hookRuntime.clearInternalHooks();const api=await channelFactApi();let adopted=0;
  const sources=[{receivedAt:Date.now(),message:{message_id:'missing-handler',from_user_id:p.sender,message_type:1,create_time_ms:Date.now(),item_list:[{type:1,text_item:{text:'我常住上海'}}]}}];
  const completion=api.emitVerifiedFactIngress({...p,sources,assertAdmissionCurrent(){}});
  const life=api.withFactAdoptionBarrier({onAdopted(){adopted++}},completion,()=>{});await assert.rejects(()=>life.onAdopted(),/unconfirmed/);assert.equal(adopted,0);
  let release;const delayed=new Promise(resolve=>release=resolve),barrier=api.withFactAdoptionBarrier({onAdopted(){adopted++}},delayed,()=>{});
  const a=barrier.onAdopted(),b=barrier.onAdopted();assert.equal(a,b);assert.equal(adopted,0);release({settled:true,outcomes:['filtered']});await Promise.all([a,b]);assert.equal(adopted,1);
 });
 test('a source created before new consent is intentionally settled without later backfill',async()=>{
  const f=queueFixture();f.seed(transition(f.read(),{action:'fact.auto.disable',requestId:'off-before-consent'},userSource(p),Date.now()).state);
  f.seed(transition(f.read(),{action:'fact.auto.enable',requestId:'new-consent',value:{noticeVersion:1}},userSource(p),Date.now()+1).state);
  const result=await childRun(f).finish();assert.equal(result.adopted,true);assert.deepEqual(result.receipt.outcomes,['before_consent']);assert.deepEqual(f.read().facts,{});f.close();
 });
 test('measure the added local persistence wait before acknowledgement',async t=>{
  hookRuntime.clearInternalHooks();const f=fixture();f.seed(enable());registerFactMemory(f.api);const api=await channelFactApi(),samples=[];
  for(let n=0;n<20;n++){
   const sourceAt=Date.now(),id='latency-'+n,start=performance.now();
   const completion=api.emitVerifiedFactIngress({...p,assertAdmissionCurrent(){},sources:[{receivedAt:sourceAt,message:{message_id:id,from_user_id:p.sender,message_type:1,create_time_ms:sourceAt,item_list:[{type:1,text_item:{text:'我喜欢摄影'}}]}}]});
   const life=api.withFactAdoptionBarrier({onAdopted(){assert.equal(f.read().facts['auto:interest.photography'].sourceMessageId,id)}},completion,()=>{});
   await api.bindIngressLifecycleToReplyOptions(life).turnAdoptionLifecycle.onAdopted();samples.push(performance.now()-start);
  }
  samples.sort((a,b)=>a-b);t.diagnostic('FACT_LOCAL_LATENCY '+JSON.stringify({samples:samples.length,medianMs:+samples[10].toFixed(3),p95Ms:+samples[18].toFixed(3),maxMs:+samples[19].toFixed(3),modelCalls:0,scope:'synthetic local SQLite contract fixture, not production SLA'}));f.close();
 });
}
