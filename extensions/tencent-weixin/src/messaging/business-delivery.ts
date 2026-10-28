/** Internal Tencent sender for the application-owned, self-only proactive scheduler.
 * No RPC/model arguments can construct this adapter or retained credential capability.
 */
import {createHash} from 'node:crypto';
import {loadWeixinAccount,resolveWeixinAccount} from '../auth/accounts.js';
import {readFrameworkAllowFromList} from '../auth/pairing.js';
import {assertSessionActive} from '../api/session-guard.js';
import {readPersistedContextToken} from './inbound.js';
import {applyWeixinMessageSendingHook,emitWeixinMessageSent} from './outbound-hooks.js';
import {sendMessageWeixin} from './send.js';
import {hasPrivateRoute} from './private-route.js';

type Tenant={id:string;account:string;sender:string};
type Context={runtime:{config:{current:()=>any}}};
const fail=(message:string):never=>{throw Error(message)};
export function createWeixinBusinessDeliveryAdapter(api:Context){
 const retained=new WeakMap<object,{tenant:Tenant;token:string;baseUrl:string;contextToken?:string;preview:string;used:boolean}>();
 function check(tenant:Tenant,assertCurrent:()=>void){
  assertCurrent();const cfg=api.runtime.config.current();
  const entries=cfg.plugins?.entries;
  if(entries?.['dafeiyu-domain']?.enabled===false||entries?.['openclaw-weixin']?.enabled===false||entries?.['dafeiyu-domain']?.config?.shadowOnly!==false)fail('Business transport is not enabled');
  const bindings=cfg.bindings??[],b=bindings[0],m=b?.match;
  const expected='wx-'+createHash('sha256').update(JSON.stringify([tenant.account,tenant.sender])).digest('hex').slice(0,32);
  if(bindings.length!==1||tenant.account!=='primary'||tenant.id!==expected||b?.agentId!==expected||m?.channel!=='openclaw-weixin'||m.accountId!==tenant.account||m.peer?.kind!=='direct'||m.peer.id!==tenant.sender)fail('Verified private business target required');
  const section=cfg.channels?.['openclaw-weixin'];
  if(section?.enabled!==true||section.accounts?.[tenant.account]?.enabled!==true)fail('Receiver is disabled');
  const stored=loadWeixinAccount(tenant.account),account=resolveWeixinAccount(cfg,tenant.account);
  if(!account.configured||!account.enabled||stored?.userId!==tenant.sender)fail('Credential owner mismatch');
  // Match the existing authenticated channel admission in process-message.ts.
  // QR adoption may have no separate framework pairing file. Never create one
  // or expand the verified credential owner into other users' permission.
  const paired=readFrameworkAllowFromList(tenant.account);
  const admitted=paired.length?paired:stored.userId?.trim()?[stored.userId.trim()]:[];
  if(admitted.length!==1||admitted[0]!==tenant.sender||!hasPrivateRoute(cfg,tenant.account,{from_user_id:tenant.sender},admitted))fail('Paired business target required');
  const u=new URL(account.baseUrl);
  if(u.protocol!=='https:'||u.hostname!=='ilinkai.weixin.qq.com'||u.username||u.password||u.port||u.search||u.hash||!['','/'].includes(u.pathname))fail('Unapproved Weixin endpoint');
  assertSessionActive(tenant.account);
   const contextToken=readPersistedContextToken(tenant.account,tenant.sender);
   if(!contextToken)fail('Verified private context is unavailable; wait for a new Weixin message');
   return {token:account.token!,baseUrl:account.baseUrl,contextToken};
 }
 return {
  async authorize({tenant,assertCurrent,previewMessage}:{tenant:Tenant;assertCurrent:()=>void;previewMessage:string}){
   if(typeof previewMessage!=='string'||!previewMessage.trim()||Buffer.byteLength(previewMessage)>4096)fail('Bounded prepared message required');
   const initial=check(tenant,assertCurrent);
   // Existing formal message_sending hooks finish BEFORE final scheduler admission.
   const hook=await applyWeixinMessageSendingHook({to:tenant.sender,text:previewMessage,accountId:tenant.account,failClosed:true});
   if(hook.cancelled||hook.text!==previewMessage)fail('Prepared business message cancelled or rewritten by channel');
   const capability={assertCurrent:()=>{
    const current=check(tenant,assertCurrent);
    if(current.token!==initial.token||current.baseUrl!==initial.baseUrl||current.contextToken!==initial.contextToken)fail('Retained business credential changed');
   }};
   capability.assertCurrent();retained.set(capability,{tenant:{...tenant},...initial,preview:previewMessage,used:false});return capability;
  },
  send({tenant,capability,message,idempotencyKey}:{tenant:Tenant;capability:{assertCurrent:()=>void};message:string;idempotencyKey:string}){
   const value=retained.get(capability);
   if(!value||value.used||value.tenant.id!==tenant.id||value.tenant.account!==tenant.account||value.tenant.sender!==tenant.sender||message!==value.preview||!/^business-reminder:[a-f0-9-]{36}$/.test(idempotencyKey))fail('Unretained or consumed business send');
   capability.assertCurrent();value.used=true;
   // No asynchronous credential/hook lookup between this assertion and API fetch.
   const pending=sendMessageWeixin({to:tenant.sender,text:message,opts:{token:value.token,baseUrl:value.baseUrl,contextToken:value.contextToken,accountId:tenant.account,runId:idempotencyKey,clientId:'openclaw-weixin-'+idempotencyKey.split(':')[1],timeoutMs:20000}});
   return pending.then(result=>{
    emitWeixinMessageSent({to:tenant.sender,content:message,success:result.platformAccepted===true,accountId:tenant.account,runId:idempotencyKey});
    return result.platformAccepted===true?{messageId:result.messageId,...(result.serverMessageId?{serverMessageId:result.serverMessageId}:{})}:{};
   },error=>{emitWeixinMessageSent({to:tenant.sender,content:message,success:false,accountId:tenant.account,runId:idempotencyKey});throw error;});
  },
 };
}
