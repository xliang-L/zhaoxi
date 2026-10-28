import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire,stripTypeScriptTypes} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {identityId,defaults,transition} from '../../extensions/dafeiyu-domain/core/domain.mjs';
export const hostRoot=process.env.ZHAOXI_TEST_OPENCLAW_ROOT??fileURLToPath(new URL('../../data/runtime/source',import.meta.url));
const hostRequire=createRequire(join(hostRoot,'package.json'));
export const hookRuntime=await import(pathToFileURL(hostRequire.resolve('openclaw/plugin-sdk/hook-runtime')));
export const peer=(account='primary',sender='synthetic-alice')=>{const id=identityId(account,sender);return {id,account,sender,agentId:id,sessionKey:`agent:${id}:openclaw-weixin:${account}:direct:${sender}`};};
export const binding=p=>({agentId:p.id,match:{channel:'openclaw-weixin',accountId:p.account,peer:{kind:'direct',id:p.sender}}});
export const userSource=p=>({kind:'authenticated-portal',account:p.account,sender:p.sender,sessionKey:p.sessionKey,consent:'verified-web-choice'});
export function enable(state=defaults(),p=peer(),now=Date.now()-1000){return transition(state,{action:'fact.auto.enable',value:{noticeVersion:1},requestId:'enable:'+now},userSource(p),now).state;}
export const message=(text,id='m1',sourceAt=Date.now())=>({text,messageId:id,sourceAt,receivedAt:sourceAt});
export const envelope=(p,messages,assertAdmissionCurrent=()=>{})=>({...p,channelId:'openclaw-weixin',messages,assertAdmissionCurrent});
export function fixture({path,peers=[peer()]}={}){
 const directory=path?resolve(path,'..'):mkdtempSync(join(tmpdir(),'dafeiyu-facts-'));
 const database=path??join(directory,'synthetic.sqlite');const db=new DatabaseSync(database);
 db.exec('CREATE TABLE IF NOT EXISTS records(namespace TEXT,key TEXT,revision INTEGER,value TEXT,PRIMARY KEY(namespace,key))');
 const config={bindings:peers.map(binding),plugins:{entries:{'dafeiyu-domain':{config:{shadowOnly:true},hooks:{allowConversationAccess:true}}}}};
 const methods={},typed={},logs=[];let conflictOnce=false;
 const api={runtime:{config:{current:()=>config},state:{openKeyedStoreV2({namespace},{assertCurrent=()=>{}}={}){
  const lookup=key=>{assertCurrent();const row=db.prepare('SELECT * FROM records WHERE namespace=? AND key=?').get(namespace,key);return row?{value:JSON.parse(row.value),comparison:row.revision}:{value:null,comparison:0};};
  return {async lookup(key){return lookup(key).value},async observe(key){return lookup(key)},async compareAndApply(key,comparison,operation){
   assertCurrent();let row=lookup(key);
   if(conflictOnce){conflictOnce=false;const value=structuredClone(row.value??defaults());value.independentWriter=true;db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?,?)').run(namespace,key,row.comparison+1,JSON.stringify(value));row=lookup(key);}
   if(row.comparison!==comparison)return {status:'conflict',current:row};
   assertCurrent();if(operation.operation==='delete')db.prepare('DELETE FROM records WHERE namespace=? AND key=?').run(namespace,key);
   else db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?,?)').run(namespace,key,comparison+1,JSON.stringify(operation.value));return {status:'applied'};
  }};
 }}},logger:{warn:s=>logs.push(s)},registerHook(name,fn){hookRuntime.registerInternalHook(name,fn)},on(name,fn){typed[name]=fn},registerGatewayMethod(name,fn){methods[name]=fn},registerCommand(){},registerTool(){}};
 return {api,config,methods,typed,logs,directory,database,db,close:()=>db.close(),conflict:()=>{conflictOnce=true},read(p=peers[0]){const row=db.prepare("SELECT value FROM records WHERE namespace='tenant-domain-v1' AND key=?").get(p.id);return row?JSON.parse(row.value):defaults();},seed(state,p=peers[0]){db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?,?)').run('tenant-domain-v1',p.id,1,JSON.stringify(state));}};
}
let compiled=0;
/** Execute the actual TypeScript entry modules, replacing external I/O only. */
export async function loadChannelSource(relative,mocks={},replacements={}){
 const directory=mkdtempSync(join(tmpdir(),'dafeiyu-channel-'));
 const fixtureName='__dafeiyuFixture'+compiled++;globalThis[fixtureName]=mocks;
 let source=stripTypeScriptTypes(readFileSync(fileURLToPath(new URL('../../extensions/tencent-weixin/src/'+relative,import.meta.url)),'utf8'),{mode:'transform'});
 source=source.replace(/import\s+(\{[\s\S]*?\}|[A-Za-z_$][\w$]*)\s+from\s+(["'])([^"']+)\2;/g,(all,names,quote,specifier)=>{
  if(replacements[specifier])return `import ${names} from ${JSON.stringify(replacements[specifier])};`;
  if(specifier.startsWith('node:'))return all;
  if(specifier==='openclaw/plugin-sdk/hook-runtime')return `import ${names} from ${JSON.stringify(pathToFileURL(hostRequire.resolve(specifier)).href)};`;
  const exported=names.startsWith('{')?names.slice(1,-1).split(',').map(x=>x.trim().split(/\s+as\s+/)[0]).filter(Boolean):['default'];
  const filename=join(directory,'dependency'+compiled+++'.mjs');
  writeFileSync(filename,exported.map(name=>name==='default'?`export default globalThis[${JSON.stringify(fixtureName)}][${JSON.stringify(specifier)}]?.default;`:`export const ${name}=globalThis[${JSON.stringify(fixtureName)}][${JSON.stringify(specifier)}]?.[${JSON.stringify(name)}];`).join('\n'));
  return `import ${names} from ${JSON.stringify(pathToFileURL(filename).href)};`;
 });
 const filename=join(directory,'module.mjs');writeFileSync(filename,source);return {module:await import(pathToFileURL(filename)),url:pathToFileURL(filename).href};
}
