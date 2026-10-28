import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {QuotaLedger,wrapQuotaStream,historicalSeed,monthKey} from './quota.mjs';
const ledgers=new Map();
const reject=()=>{throw Error('Quota requires one authenticated private account')};
const initializing=new Map();

export async function ensureQuotaHistory(api,ledger){
 try{return ledger.view()}catch(error){if(!/verified initialization/.test(error.message))throw error}
 if(ledger.ledgerState!==ledger.state)throw Error('Quota shared history must be initialized by the primary assistant');
 if(!initializing.has(ledger.state)){
  const job=(async()=>{
   const cfg=api.runtime.config.current(),binding=cfg.bindings?.[0];if(!binding)reject();
   const require=createRequire(path.join(process.env.ZHAOXI_OPENCLAW_ROOT,'package.json'));
   const {callGatewayFromCli}=await import(pathToFileURL(require.resolve('openclaw/plugin-sdk/gateway-runtime')));
   const period=monthKey(),today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(Date.now());
   const report=await callGatewayFromCli('sessions.usage',{timeout:'10000',json:true,port:String(cfg.gateway?.port),expectUrl:`ws://127.0.0.1:${cfg.gateway?.port}`},
    {agentId:binding.agentId,startDate:period+'-01',endDate:today,mode:'specific',timeZone:'Asia/Shanghai',groupBy:'family',limit:1},{scopes:['operator.read']});
   quotaFor(api);const seed=historicalSeed(report);ledger.seed(period,seed.tokens,seed);return ledger.view();
  })();initializing.set(ledger.state,job);
  void job.finally(()=>{if(initializing.get(ledger.state)===job)initializing.delete(ledger.state)}).catch(()=>{});
 }
 return initializing.get(ledger.state);
}

/** No sender, store path or user ID is accepted from model arguments. */
export function quotaFor(api,ctx={}){
 const cfg=api.runtime.config.current();if(cfg.plugins?.entries?.['zhaoxi-native']?.config?.quotaEnabled!==true)return null;
 const bindings=cfg.bindings??[],entries=cfg.agents?.entries??{};
 if(bindings.length!==1||Object.keys(entries).length!==1)reject();
 const b=bindings[0],m=b.match??{},p=m.peer??{};
 if(m.channel!=='openclaw-weixin'||m.accountId!=='primary'||p.kind!=='direct'||typeof p.id!=='string'||!p.id||p.id==='*')reject();
 const raw=process.env.OPENCLAW_STATE_DIR;if(!raw||fs.lstatSync(raw).isSymbolicLink())reject();
 const state=fs.realpathSync(raw),root=path.dirname(state),workspace=entries[b.agentId]?.workspace;
 if(typeof workspace!=='string'||!fs.realpathSync(workspace).startsWith(root+path.sep))reject();
 if(ctx.workspaceDir){const resolved=fs.realpathSync(ctx.workspaceDir),own=fs.realpathSync(workspace);if(resolved!==own&&!resolved.startsWith(own+path.sep))reject()}
 const policy=JSON.parse(fs.readFileSync(path.join(state,'quota-policy.json'),'utf8'));
 const fingerprint=createHash('sha256').update(JSON.stringify(['primary',p.id.toLowerCase()])).digest('hex');
 if(policy.spaceId!==path.basename(root)||policy.bindingFingerprint!==fingerprint)reject();
 let ledgerState=state;
 if(policy.ledgerSpaceId&&policy.ledgerSpaceId!==path.basename(root)){
  if(!/^[a-f0-9]{32}$/.test(policy.ledgerSpaceId))reject();
  const target=path.join(path.dirname(root),policy.ledgerSpaceId,'openclaw');
  if(fs.lstatSync(path.dirname(target)).isSymbolicLink()||fs.lstatSync(target).isSymbolicLink())reject();
  ledgerState=fs.realpathSync(target);
  if(!ledgerState.startsWith(path.dirname(root)+path.sep))reject();
  const primary=JSON.parse(fs.readFileSync(path.join(ledgerState,'quota-policy.json'),'utf8'));
  if(primary.spaceId!==policy.ledgerSpaceId||primary.ledgerSpaceId&&primary.ledgerSpaceId!==primary.spaceId)reject();
  if(typeof policy.principalId!=='string'||!policy.principalId||primary.principalId!==policy.principalId)reject();
 }
 if(!ledgers.has(state))ledgers.set(state,new QuotaLedger(state,{ledgerState}));return ledgers.get(state);
}

export function registerQuota(api){
 const wrap=ctx=>{const ledger=quotaFor(api,ctx);return ledger?wrapQuotaStream(ctx.streamFn,ledger,async()=>{if(quotaFor(api,ctx)!==ledger)reject();await ensureQuotaHistory(api,ledger)}):ctx.streamFn};
 api.registerProvider({id:'zhaoxi',label:'现有模型路由',auth:[],wrapStreamFn:wrap,wrapSimpleCompletionStreamFn:wrap,
  classifyFailoverReason:({errorMessage})=>/Quota |PRODUCT_TOKEN_BUDGET/.test(errorMessage)?'format':undefined});
 api.registerGatewayMethod('zhaoxi.quota.status',async options=>{
  try{if(Object.keys(options.params??{}).length||options.hasCurrentClientAuthority?.()!==true)reject();const ledger=quotaFor(api);const models=api.runtime.config.current().models?.providers?.zhaoxi?.models??[];const minimum=Math.max(...models.map(m=>(m.contextTokens??256000)+(m.maxTokens??8192)),1);const view=ledger?await ensureQuotaHistory(api,ledger):null;if(options.hasCurrentClientAuthority?.()!==true)reject();options.respond(true,ledger?{enabled:true,...view,min_request_tokens:minimum}:{enabled:false})}
  catch{options.respond(false,undefined,{code:'UNAVAILABLE',message:'Quota status unavailable; no model request admitted'})}
 },{scope:'operator.read'});
 api.on('gateway_stop',()=>{for(const ledger of ledgers.values())ledger.close();ledgers.clear()});
}
