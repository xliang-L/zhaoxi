import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {defaults} from '../core/domain.mjs';

const run=promisify(execFile),day=86400000,maxFile=25*1024*1024;
const check=(ok,message)=>{if(!ok)throw Error(message)};
const inside=(root,file)=>{const r=path.relative(root,file);return r!==''&&!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r)};
const stores=(api,assertCurrent)=>({
 domain:api.runtime.state.openKeyedStoreV2({namespace:'tenant-domain-v1',retention:'retained'},{assertCurrent}),
 sources:api.runtime.state.openKeyedStoreV2({namespace:'tenant-matter-sources-v1',retention:'retained'},{assertCurrent})
});
export async function matterTransaction(store,tenant,assertCurrent,change){
 for(let n=0;n<8;n++){
  assertCurrent();const observed=await store.observe(tenant.id);assertCurrent();
  const next=change(structuredClone(observed.value??defaults()));
  if(JSON.stringify(next.state)===JSON.stringify(observed.value??defaults()))return next.result;
  check(Buffer.byteLength(JSON.stringify(next.state))<900000,'保存的事项较多，请先整理已完成事项。');
  next.state.revision++;assertCurrent();const done=await store.compareAndApply(tenant.id,observed.comparison,{operation:'update',action:'set',value:next.state});assertCurrent();
  if(done.status==='applied')return next.result;
  check(done.status==='conflict','这次保存结果暂时无法确认，请稍后重试。');
 }
 throw Error('资料正在更新，请稍后再试。');
}
function workspaceFor(api,tenant){
 const workspace=api.runtime.config.current().agents?.entries?.[tenant.id]?.workspace;
 check(typeof workspace==='string','当前账号的资料目录尚未就绪。');return workspace;
}
function fileName(value,fallback){
 const name=path.basename(String(value??fallback)).replace(/[\x00-\x1f\\/]/gu,'_');
 return name!=='.'&&name!=='..'&&Buffer.byteLength(name)<=180?name:fallback;
}
async function copyAttachment(api,tenant,assertCurrent,input,directory,index){
 check(input&&typeof input.path==='string','附件接收记录不完整。');
 const workspace=await fs.realpath(workspaceFor(api,tenant)),candidate=await fs.realpath(input.path);
 const roots=[workspace];
 if(process.env.OPENCLAW_STATE_DIR){const inbound=path.join(process.env.OPENCLAW_STATE_DIR,'media','inbound');try{roots.push(await fs.realpath(inbound))}catch{}}
 check(roots.some(root=>inside(root,candidate)),'这个附件不属于当前账号的接收目录。');
 const handle=await fs.open(candidate,'r');let bytes;
 try{const stat=await handle.stat();check(stat.isFile()&&stat.size>0&&stat.size<=maxFile,'单个附件须不超过 25 MB。');bytes=await handle.readFile();check(bytes.length<=maxFile,'单个附件须不超过 25 MB。')}finally{await handle.close()}
 assertCurrent();const name=fileName(input.fileName,path.basename(candidate)),folder=path.join(directory,String(index));
 await fs.mkdir(folder,{recursive:true,mode:0o700});const destination=path.join(folder,name);
 await fs.writeFile(destination,bytes,{flag:'wx',mode:0o600});assertCurrent();
 return {name,path:destination,mime:typeof input.mime==='string'?input.mime.slice(0,120):'application/octet-stream',bytes:bytes.length,mtimeMs:(await fs.stat(destination)).mtimeMs,quoted:input.quoted===true};
}
/** Host-only intake. The model supplies source IDs later, never input paths or identities. */
export async function stageMatterSource(api,tenant,assertCurrent,input,now=Date.now()){
 check(input&&typeof input.messageId==='string'&&input.messageId.length>0&&input.messageId.length<=200,'资料消息编号不完整。');
 check(typeof input.body==='string'&&input.body.length<=16000&&Array.isArray(input.attachments)&&input.attachments.length<=8,'本次资料过长，请分批转发。');
 assertCurrent();const {domain,sources}=stores(api,assertCurrent),id='src-'+Buffer.from(input.messageId).toString('base64url'),key=tenant.id+':'+id;
 check(!(await domain.lookup(tenant.id))?.matterSourceTombstones?.[id],'这条原消息的资料已删除，需要时请重新转发原件。');
 let record=await sources.lookup(key);
 if(!record){
   const workspace=await fs.realpath(workspaceFor(api,tenant)),matters=path.join(workspace,'matters');
   await fs.mkdir(matters,{recursive:true,mode:0o700});check(inside(workspace,await fs.realpath(matters)),'资料目录不可用。');const base=path.join(matters,'sources');
  await fs.mkdir(base,{recursive:true,mode:0o700});check(inside(workspace,await fs.realpath(base)),'资料目录不可用。');
  const directory=path.join(base,randomUUID());await fs.mkdir(directory,{mode:0o700});
  try{
   const attachments=[];for(const [i,attachment] of input.attachments.entries())attachments.push(await copyAttachment(api,tenant,assertCurrent,attachment,directory,i));
   record={id,messageId:input.messageId,receivedAt:now,messageTime:Number.isSafeInteger(input.messageTime)?input.messageTime:null,truncated:input.truncated===true,
    originalMessages:(Array.isArray(input.originalMessages)?input.originalMessages:[]).slice(0,20).map(m=>({messageId:String(m.messageId??'').slice(0,200),body:String(m.body??'').slice(0,3000),receivedAt:m.receivedAt,messageTime:m.messageTime})),
    body:input.body,quote:input.quote?{messageId:String(input.quote.messageId??'').slice(0,200),body:String(input.quote.body??'').slice(0,4000)}:null,attachments,directory};
   assertCurrent();const observed=await sources.observe(key);
   if(observed.value){await fs.rm(directory,{recursive:true,force:true});record=observed.value}
   else{const commit=await sources.compareAndApply(key,observed.comparison,{operation:'update',action:'set',value:record});assertCurrent();
    if(commit.status==='conflict'){await fs.rm(directory,{recursive:true,force:true});record=await sources.lookup(key)}else check(commit.status==='applied','资料接收结果暂时无法确认。');}
  }catch(error){await fs.rm(directory,{recursive:true,force:true});throw error}
 }
 check(record&&record.body===input.body,'相同消息的资料内容已变化，请重新转发。');
 const expired=[];
 try{await matterTransaction(domain,tenant,assertCurrent,s=>{
  s.matterSources??={};
  const protectedIds=new Set(Object.values(s.matters??{}).flatMap(m=>m.sourceIds));
  if(s.conversationChoice?.expiresAt>now)for(const c of s.conversationChoice.commands)for(const sourceId of c.value?.sourceIds??[])protectedIds.add(sourceId);
  const pending=Object.values(s.matterSources).filter(x=>!x.archived&&!protectedIds.has(x.id)).sort((a,b)=>b.receivedAt-a.receivedAt);
  for(const [index,meta] of pending.entries())if(meta.expiresAt<=now||index>=19){expired.push(meta.id);delete s.matterSources[meta.id]}
  if(!s.matterSources[id]){
   check(Object.keys(s.matterSources).length<220,'资料库暂时已满，请先整理不再需要的资料。');
   const total=Object.values(s.matterSources).reduce((n,x)=>n+(x.bytes??0),0)+record.attachments.reduce((n,x)=>n+x.bytes,0);
   check(total<=256*1024*1024,'当前资料已达到 256 MB，请先整理。');
   s.matterSources[id]={id,title:record.attachments[0]?.name??(record.body.split('\n')[0].slice(0,100)||'转发资料'),
    excerpt:record.body.slice(0,500),receivedAt:record.receivedAt,expiresAt:now+day,archived:false,
    bytes:record.attachments.reduce((n,x)=>n+x.bytes,0),files:record.attachments.map(({name,mime,bytes})=>({name,mime,bytes}))};
  }
  return {state:s,result:true};
 })}catch(error){
  const state=await domain.lookup(tenant.id);assertCurrent();
  if(!state?.matterSources?.[id]){
   const observed=await sources.observe(key);assertCurrent();
   if(observed.value?.directory===record.directory){await sources.compareAndApply(key,observed.comparison,{operation:'delete',action:'delete'});await fs.rm(record.directory,{recursive:true,force:true})}
  }
  throw error;
 }
 // Only expired, unreferenced intake files owned by this module are removed.
 for(const oldId of new Set(expired))if(oldId!==id){
  const old=await sources.lookup(tenant.id+':'+oldId);assertCurrent();
  if((await domain.lookup(tenant.id))?.matterSources?.[oldId])continue;
  if(old?.directory){const root=await fs.realpath(path.join(workspaceFor(api,tenant),'matters','sources'));if(inside(root,old.directory))await fs.rm(old.directory,{recursive:true,force:true})}
  const observed=await sources.observe(tenant.id+':'+oldId);assertCurrent();if(observed.value)await sources.compareAndApply(tenant.id+':'+oldId,observed.comparison,{operation:'delete',action:'delete'});
 }
 return {id,receivedAt:record.receivedAt,files:record.attachments.map(({name,mime})=>({name,mime})),body:record.body.slice(0,1500),quote:record.quote?{...record.quote,body:record.quote.body.slice(0,1000)}:null,truncated:record.truncated};
}
export async function readMatterSource(api,tenant,assertCurrent,id,{extract=true,now=Date.now()}={}){
 check(typeof id==='string'&&id.length<=300,'请先查找这份资料。');const {domain,sources}=stores(api,assertCurrent);
 assertCurrent();const state=await domain.lookup(tenant.id),meta=state?.matterSources?.[id];assertCurrent();
 check(meta&&(meta.archived||meta.expiresAt>now),'这份未保存资料已过期，请重新转发。');
 const record=await sources.lookup(tenant.id+':'+id);assertCurrent();check(record,'资料原件暂时不可用，请重新转发。');
 const output=structuredClone(record);
 for(const attachment of output.attachments){
  try{
   const workspace=await fs.realpath(workspaceFor(api,tenant)),resolved=await fs.realpath(attachment.path);
   check(inside(workspace,resolved),'附件目录已变化。');
   const stat=await fs.stat(resolved);check(stat.isFile()&&stat.size===attachment.bytes&&(attachment.mtimeMs===undefined||stat.mtimeMs===attachment.mtimeMs),'附件原件已变化，请重新转发。');
   attachment.available=true;
   if(extract&&!['ready','partial'].includes(attachment.extraction?.status)){
    const project=process.env.ZHAOXI_PROJECT_ROOT??fileURLToPath(new URL('../../../',import.meta.url)),reader=path.join(project,'src/zhaoxi/document_reader.py');
    let python=path.join(project,'.venv/bin/python');try{await fs.access(python)}catch{python=process.env.ZHAOXI_DOCUMENT_PYTHON??'python3'}
    try{const {stdout}=await run(python,[reader,resolved],{timeout:25000,maxBuffer:400000,env:process.env});assertCurrent();attachment.extraction=JSON.parse(stdout)}
    catch{attachment.extraction={status:'unreadable',text:'',warning:'原件可用，但本次未能识别正文；可以重发清晰图片或文字。'}}
   }
  }catch{attachment.available=false;attachment.extraction={status:'unavailable',text:'',warning:'未能读取原件内容，请重新转发清晰图片或可读取文件。'}}
 }
 let remaining=Math.max(0,32000-record.body.length-(record.quote?.body?.length??0)),clipped=false;
 for(const attachment of output.attachments)if(attachment.extraction?.text){
  if(attachment.extraction.text.length>remaining){attachment.extraction.text=attachment.extraction.text.slice(0,remaining);attachment.extraction.status='partial';attachment.extraction.warning='这组附件较长，本次共提供前32000字；其余请将需要的文件单独转发。';clipped=true}
  remaining=Math.max(0,remaining-attachment.extraction.text.length);
 }
 const text=[record.body,record.quote?.body,...output.attachments.map(x=>x.extraction?.text)].filter(Boolean).join('\n').slice(0,32000);
 if(extract){
  const observed=await sources.observe(tenant.id+':'+id);assertCurrent();
  if(observed.value)await sources.compareAndApply(tenant.id+':'+id,observed.comparison,{operation:'update',action:'set',value:{...observed.value,searchText:text,attachments:output.attachments}});
  await matterTransaction(domain,tenant,assertCurrent,s=>{if(s.matterSources?.[id])Object.assign(s.matterSources[id],{excerpt:text.slice(0,1200),readAt:now});return {state:s,result:true}});
 }
 assertCurrent();check((await domain.lookup(tenant.id))?.matterSources?.[id],'这份资料已经删除，未继续提供原文。');
 return {...output,title:meta.title,archived:meta.archived,extractedText:text,untrustedSource:true,
  warning:clipped?'这组附件较长，只提供前32000字；其余文件尚未读完，需要时请单独转发。':record.truncated?'本次消息只接收了前16000字，其余尚未读取，请分批提供。':record.originalMessages?.length>1?'本次合并了连续消息，原消息分别保留在 originalMessages；收到时间不是原通知发布时间。':'收到时间不是原通知发布时间，转发不能核实原作者或原群。'};
}
export async function searchMatterSources(api,tenant,assertCurrent,query){
 check(typeof query==='string'&&query.length<=200,'请输入要查找的资料名称或关键词。');
 const {domain,sources}=stores(api,assertCurrent);assertCurrent();const s=await domain.lookup(tenant.id);assertCurrent();
 const tokens=[...new Set(query.toLowerCase().match(/[a-z0-9]+|[\p{Script=Han}]{2}/gu)??[])];
 const results=[];
 for(const meta of Object.values(s?.matterSources??{}).filter(x=>x.archived)){
  const record=await sources.lookup(tenant.id+':'+meta.id);assertCurrent();
  const hay=[meta.title,record?.searchText??record?.body??meta.excerpt,...(meta.tags??[]),...meta.files.map(f=>f.name)].join(' ').toLowerCase();
  results.push({...meta,score:query?tokens.reduce((n,t)=>n+(hay.includes(t)?1:0),hay.includes(query.toLowerCase())?5:0):1});
 }
 const current=await domain.lookup(tenant.id);assertCurrent();
 return results.filter(x=>x.score>0&&current?.matterSources?.[x.id]).sort((a,b)=>b.score-a.score||b.receivedAt-a.receivedAt).slice(0,10);
}
/** A confirmed removal fences reads first; this retained queue finishes file and text cleanup. */
export async function purgeForgottenSources(api,tenant,assertCurrent){
 const {domain,sources}=stores(api,assertCurrent),state=await domain.lookup(tenant.id);assertCurrent();let count=0;
 for(const [id,tombstone] of Object.entries(state?.matterSourceTombstones??{}))if(!tombstone.purgedAt){
  const key=tenant.id+':'+id;
  for(let n=0;n<8;n++){
   assertCurrent();const observed=await sources.observe(key);assertCurrent();
   if(observed.value?.directory){
    const root=path.join(await fs.realpath(workspaceFor(api,tenant)),'matters','sources');
    check(inside(root,observed.value.directory),'资料清理目录不一致。');await fs.rm(observed.value.directory,{recursive:true,force:true});assertCurrent();
   }
   if(!observed.value)break;
   const deleted=await sources.compareAndApply(key,observed.comparison,{operation:'delete',action:'delete'});
   check(['applied','conflict'].includes(deleted.status),'原件清理结果暂时无法确认。');if(deleted.status==='applied')break;
   check(n<7,'资料正在读取，请刷新后重试清理。');
  }
  await matterTransaction(domain,tenant,assertCurrent,s=>{if(s.matterSourceTombstones?.[id])s.matterSourceTombstones[id].purgedAt=Date.now();return {state:s,result:true}});count++;
 }
 return count;
}
