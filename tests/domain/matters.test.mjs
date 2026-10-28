import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {stageMatterSource,readMatterSource,searchMatterSources} from '../../extensions/dafeiyu-domain/matters/matter-sources.mjs';
import {createBoundDomainService} from '../../extensions/dafeiyu-domain/core/service.mjs';
import {businessChat} from '../../extensions/dafeiyu-domain/core/business-chat.mjs';
import {schedulerTransition} from '../../extensions/dafeiyu-domain/core/business-scheduler.mjs';
import {transition} from '../../extensions/dafeiyu-domain/core/domain.mjs';
import {fixture,peer,userSource} from './fact-test-fixtures.mjs';
import {registerMatterTools} from '../../extensions/dafeiyu-domain/matters/matter-tools.mjs';

const p=peer(),other=peer('primary','synthetic-bob');let serial=0;
async function setup(peers=[p]){
 const f=fixture({peers});f.config.agents={entries:{}};
 for(const who of peers){const workspace=path.join(f.directory,who.id);await fs.mkdir(workspace,{recursive:true});f.config.agents.entries[who.id]={workspace}}
 f.config.plugins.entries['dafeiyu-domain'].config.shadowOnly=false;return f;
}
const service=(f,who=p,run='run-'+(++serial))=>createBoundDomainService(f.api,who,()=>{},{kind:'authenticated-user',sessionKey:who.sessionKey,runId:run});
const answer=(f,text='同意',extra={},who=p)=>businessChat(f.api,{...who,text,directText:true,receivedAt:Date.now()+5,messageId:'reply-'+(++serial),assertAdmissionCurrent(){},...extra});
async function intake(f,body='周五交实验报告，PDF格式，先找老师签字。',who=p,file=false){
 const attachments=[];
 if(file){const name='志愿服务证明.txt',input=path.join(f.config.agents.entries[who.id].workspace,name);await fs.writeFile(input,'志愿服务证明\n2026年10月公益服务8小时。');attachments.push({path:input,fileName:name,mime:'text/plain'})}
 return stageMatterSource(f.api,who,()=>{},{messageId:'input-'+(++serial),body,attachments});
}
function proposal(source,id='lab'){
 const deadlineAt=new Date(Date.now()+86400000).toISOString();
 return {action:'matter.create',id,requestId:'proposal-'+(++serial),value:{title:'实验报告',summary:'交PDF实验报告，需先签字。',sourceIds:[source.id],deadlineAt,submitTo:'课程平台',
  requirements:['PDF格式','老师签字'],preparations:[{text:'找老师签字',done:false},{text:'导出PDF并核对命名',done:false}],
  reminders:[{at:new Date(Date.now()+60000).toISOString(),text:'先带报告找老师签字，之后再导出PDF。'},{at:new Date(Date.now()+3600000).toISOString(),text:'核对签字和PDF命名后，提交到课程平台。'}]}};
}
async function active(f,id='lab'){
 const source=await intake(f),command=proposal(source,id);await service(f).propose(command,Date.now()-5);await answer(f);return f.read().matters[id];
}
test('forwarded notice is a proposal until natural approval; four reminders and facts remain independently scoped',async()=>{
 const f=await setup();try{
  const source=await intake(f),command=proposal(source),draft=await service(f).propose(command,Date.now()-10);
  assert.match(draft.summary,/签字.*PDF/s);assert.match(draft.summary,/北京时间/);assert.doesNotMatch(draft.summary,/src-|\/fish-|nonce/);
  assert.equal(f.read().matters,undefined);assert.equal(f.read().matterSources[source.id].archived,false);assert.deepEqual(f.read().plans,{});
  const reply=await answer(f,'就这么办'),s=f.read();assert.match(reply,/实验报告/);assert.equal(s.matters.lab.status,'active');assert.equal(s.matters.lab.planIds.length,2);
  assert.equal(s.matterSources[source.id].archived,true);assert.equal(s.preferences.enabled,false);assert.equal(s.autoFactMemory?.enabled??false,false);assert.deepEqual(s.facts,{});
  for(const id of s.matters.lab.planIds){assert.equal(s.plans[id].status,'active');assert.equal(s.plans[id].reminderConsent.consent,'verified-chat-confirmation')}
 }finally{f.close()}
});
test('revised notice retains the original evidence, previews changes and atomically replaces old reminders',async()=>{
 const f=await setup();try{
  const old=await active(f),oldPlanIds=[...old.planIds],source=await intake(f,'通知更正：提前到明晚，纸质交办公室，电子版不交。');
  const deadlineAt=new Date(Date.now()+12*3600000).toISOString(),svc=service(f);
  const draft=await svc.propose({action:'matter.update',id:old.id,expectedRevision:old.revision,requestId:'revise',value:{deadlineAt,submitTo:'学院办公室',requirements:['纸质报告','老师签字'],sourceIds:[source.id],
   reminders:[{at:new Date(Date.now()+120000).toISOString(),text:'打印签字版，送到学院办公室。'}]}},Date.now()-10);
  assert.match(draft.summary,/截止：.*→/s);assert.match(draft.summary,/学院办公室/);assert.equal(f.read().matters.lab.revision,1);assert.equal(f.read().plans[oldPlanIds[0]].status,'active');
  await answer(f);const s=f.read(),m=s.matters.lab;assert.equal(m.revision,2);assert.equal(m.history.length,1);assert.equal(m.sourceIds.length,2);assert.equal(m.history[0].submitTo,'课程平台');
  assert.equal(s.plans[oldPlanIds[1]].status,'cancelled');assert.ok(s.plans[oldPlanIds[0]].revision>2);assert.equal(m.planIds.length,1);assert.equal(Object.keys(s.plans).length,2);
  const due=Date.parse(s.plans[m.planIds[0]].dueAt),claim=schedulerTransition(s,'claim',{},due),lease={attemptId:claim.result.attemptId,lease:claim.result.lease};
  const begun=schedulerTransition(claim.state,'begin',lease,due),checked=schedulerTransition(begun.state,'validate',lease,due);
  assert.match(checked.result.message,/打印签字版.*学院办公室/s);assert.doesNotMatch(checked.result.message,/提交到课程平台/);
 }finally{f.close()}
});
test('self-reported completion after the confirmed matter stops every pending reminder once',async()=>{
 const f=await setup();try{
  const m=await active(f),messageId='done-same';const reply=await answer(f,'交了',{messageId});assert.match(reply,/标记完成.*停止/s);
  const s=f.read();assert.equal(s.matters.lab.status,'completed');for(const id of m.planIds)assert.equal(s.plans[id].status,'cancelled');
  assert.equal(await answer(f,'交了',{messageId}),reply);assert.equal(f.read().matters.lab.revision,2);
  assert.equal(schedulerTransition(s,'claim',{},Date.now()+3600000).result.ready,false);
 }finally{f.close()}
});
test('quotes, unrelated chat and an old admission cannot complete an unrelated matter',async()=>{
 const f=await setup();try{
  await active(f);assert.equal(await answer(f,'交了',{directText:false}),null);assert.equal(f.read().matters.lab.status,'active');
  await service(f).focusMatter('lab');assert.equal(await answer(f,'交了',{receivedAt:1}),null);assert.equal(f.read().matters.lab.status,'active');
  await answer(f,'今天吃火锅');assert.equal(await answer(f,'搞定了'),null);assert.equal(f.read().matters.lab.status,'active');
  await answer(f,'实验报告交了');assert.equal(f.read().matters.lab.status,'completed');
 }finally{f.close()}
});
test('a delivered preparation reminder establishes context for a later natural completion',async()=>{
 const f=await setup();try{
  await active(f);let s=f.read();delete s.matterFocus;const due=Date.parse(s.plans[s.matters.lab.planIds[0]].dueAt);
  const claim=schedulerTransition(s,'claim',{},due),lease={attemptId:claim.result.attemptId,lease:claim.result.lease};
  const begin=schedulerTransition(claim.state,'begin',lease,due),checked=schedulerTransition(begin.state,'validate',lease,due);
  const sent=schedulerTransition(checked.state,'settle',{...lease,outcome:'accepted'},due);assert.equal(sent.state.matterFocus.id,'lab');
  f.seed(sent.state);await answer(f,'搞定了',{receivedAt:due+1});assert.equal(f.read().matters.lab.status,'completed');
 }finally{f.close()}
});
test('archive retrieves the original filename and searchable content after its incoming source is gone',async()=>{
 const f=await setup();try{
  const source=await intake(f,'这是我的公益时证明',p,true),read=await readMatterSource(f.api,p,()=>{},source.id);
  assert.equal(read.attachments[0].available,true);assert.match(read.extractedText,/8小时/);
  await service(f).propose({action:'matter.archive',id:'proof',requestId:'archive-proof',value:{sourceIds:[source.id],title:'十月志愿服务证明',tags:['综测','志愿时长']}},Date.now()-10);
  assert.equal((await searchMatterSources(f.api,p,()=>{},'志愿')).length,0);await answer(f,'同意');
  await fs.unlink(path.join(f.config.agents.entries[p.id].workspace,'志愿服务证明.txt'));
  const found=await searchMatterSources(f.api,p,()=>{},'8小时');assert.equal(found.length,1);assert.equal(found[0].id,source.id);
  const again=await readMatterSource(f.api,p,()=>{},source.id,{now:Date.now()+3*86400000});assert.equal(again.attachments[0].name,'志愿服务证明.txt');
  assert.match(await fs.readFile(again.attachments[0].path,'utf8'),/公益服务8小时/);assert.deepEqual(f.read().plans,{});
 }finally{f.close()}
});
test('unknown dates may be saved without invented midnight deadlines or reminders',async()=>{
 const f=await setup();try{
  const source=await intake(f,'通知说周五交，但原发布时间不明。'),command=proposal(source);Object.assign(command.value,{deadlineAt:null,reminders:[]});
  const draft=await service(f).propose(command,Date.now()-10);assert.match(draft.summary,/截止时间尚未注明/);await answer(f);assert.equal(f.read().matters.lab.deadlineAt,null);assert.deepEqual(f.read().plans,{});
 }finally{f.close()}
});
test('stale changes, duplicate titles and forged source IDs do not create extra jobs',async()=>{
 const f=await setup();try{
  const m=await active(f),source=await intake(f),svc=service(f);
  await assert.rejects(svc.propose(proposal(source,'duplicate')),/同名事项/);
  await assert.rejects(svc.propose({action:'matter.update',id:m.id,expectedRevision:0,requestId:'stale',value:{summary:'changed'}}),/已经变化/);
  const fake=proposal({id:'forged-source'},'fake');fake.value.title='另一个报告';await assert.rejects(svc.propose(fake),/失效/);
  assert.equal(Object.keys(f.read().plans).length,2);assert.equal(f.read().matters.lab.revision,1);
  const plan=f.read().plans[m.planIds[0]];assert.throws(()=>transition(f.read(),{action:'plan.cancel',id:plan.id,expectedRevision:plan.revision,requestId:'orphan'},userSource(p),Date.now()),/修改原事项/);
 }finally{f.close()}
});
test('sources, original files and tasks are private to each website user / bot tenant',async()=>{
 const f=await setup([p,other]);try{
  const source=await intake(f,'只属于Alice的实验报告',p,true);await readMatterSource(f.api,p,()=>{},source.id);await service(f).propose(proposal(source),Date.now()-10);await answer(f);
  await assert.rejects(readMatterSource(f.api,other,()=>{},source.id),/过期/);assert.deepEqual(await searchMatterSources(f.api,other,()=>{},'实验'),[]);
  const foreign=path.join(f.config.agents.entries[p.id].workspace,'志愿服务证明.txt');
  await assert.rejects(stageMatterSource(f.api,other,()=>{},{messageId:'steal',body:'file',attachments:[{path:foreign}]}),/不属于当前账号/);
  assert.equal(f.read(other).matters,undefined);assert.deepEqual(f.read(other).plans,{});
 }finally{f.close()}
});
test('proposal and original attachments survive restart; refusal leaves the live matter unchanged',async()=>{
 let f=await setup(),db=f.database,cfg=f.config;const source=await intake(f,'重启后仍要保留',p,true);await readMatterSource(f.api,p,()=>{},source.id);await service(f).propose(proposal(source),Date.now()-10);f.close();
 f=fixture({path:db});Object.assign(f.config,cfg);
 try{
  await answer(f);assert.equal(f.read().matters.lab.status,'active');assert.equal((await readMatterSource(f.api,p,()=>{},source.id)).attachments[0].available,true);
  const old=f.read().matters.lab;await service(f).propose({action:'matter.cancel',id:old.id,expectedRevision:old.revision,requestId:'cancel-refused'},Date.now()-10);
  await answer(f,'先不用');assert.equal(f.read().matters.lab.status,'active');
 }finally{f.close()}
});
test('actual tool registration binds every action to the current authenticated private invocation',async()=>{
 const f=await setup();try{
  let factory;f.api.registerTool=value=>factory=value;registerMatterTools(f.api);
  const ctx={agentId:p.id,agentAccountId:p.account,requesterSenderId:p.sender,messageChannel:'openclaw-weixin',sessionKey:p.sessionKey,assertInvocationCurrent(){},assertInputCommitAllowed(){},runId:'real-tool'};
  const tool=factory.create(ctx),source=await intake(f);const read=await tool.execute('read',{action:'source.read',sourceId:source.id});assert.equal(read.isError,undefined);
  const command=proposal(source);const preview=await tool.execute('proposal',{action:'create',id:'tool-matter',value:command.value});assert.equal(preview.isError,undefined);assert.equal(f.read().matters,undefined);
  await answer(f);assert.equal(f.read().matters['tool-matter'].status,'active');
  ctx.assertInvocationCurrent=()=>{throw Error('stale invocation')};const denied=await tool.execute('denied',{action:'list'});assert.equal(denied.isError,true);
 }finally{f.close()}
});

test('two confirmed matters or a combined reminder never interpret an ambiguous done as the last item',async()=>{
 const f=await setup();try{
  const a=await intake(f),b=await intake(f,'还有一份报名表'),svc=service(f,p,'same-batch');const first=proposal(a,'first'),second=proposal(b,'second');second.value.title='报名表';
  const at=new Date(Date.now()+60000).toISOString();first.value.reminders=[{at,text:'报告要签字'}];second.value.reminders=[{at,text:'报名表要盖章'}];
  await svc.propose(first,Date.now()-10);await svc.propose(second,Date.now()-5);await answer(f);
  assert.equal(await answer(f,'交了'),null);assert.ok(Object.values(f.read().matters).every(m=>m.status==='active'));
  const current=f.read(),due=Date.parse(at),claim=schedulerTransition(current,'claim',{},due),lease={attemptId:claim.result.attemptId,lease:claim.result.lease};
  const begin=schedulerTransition(claim.state,'begin',lease,due),checked=schedulerTransition(begin.state,'validate',lease,due),sent=schedulerTransition(checked.state,'settle',{...lease,outcome:'accepted'},due);
  assert.equal(sent.state.matterFocus,undefined);f.seed(sent.state);assert.equal(await answer(f,'搞定了',{receivedAt:due+1}),null);
  const reader=service(f,p,'compare-two');await reader.focusMatter('first');await reader.focusMatter('second');assert.equal(f.read().matterFocus.ambiguous,true);
  await answer(f,'实验报告交了');assert.equal(f.read().matters.first.status,'completed');assert.equal(f.read().matters.second.status,'active');
 }finally{f.close()}
});

test('two offset spellings of the same reminder instant are rejected',async()=>{
 const f=await setup();try{
  const input=await intake(f),cmd=proposal(input);const at=Date.now()+60000;
  cmd.value.reminders=[{at:new Date(at).toISOString(),text:'first'},{at:new Date(at+8*3600000).toISOString().replace('Z','+08:00'),text:'same instant'}];
  await assert.rejects(service(f).propose(cmd),/相同时间/);assert.deepEqual(f.read().plans,{});
 }finally{f.close()}
});

test('forgetting an archive needs natural consent, removes original bytes and text, and cannot replay the old intake',async()=>{
 const f=await setup([p,other]);try{
  const input=await intake(f,'只保存这份证明',p,true),original=await readMatterSource(f.api,p,()=>{},input.id);
  await service(f).propose({action:'matter.archive',id:'archive',requestId:'save-for-forget',value:{sourceIds:[input.id],title:'十月证明'}},Date.now()-10);await answer(f);
  const foreign=await intake(f,'另一个人的证明',other,true);await readMatterSource(f.api,other,()=>{},foreign.id);
  await service(f,other).propose({action:'matter.archive',id:'other',requestId:'other-archive',value:{sourceIds:[foreign.id],title:'其他用户的证明'}},Date.now()-10);await answer(f,'同意',{},other);
  const cmd={action:'matter.forget',id:'remove',requestId:'forget-refused',value:{sourceIds:[input.id]}};
  await service(f).propose(cmd,Date.now()-10);assert.equal((await fs.stat(original.attachments[0].path)).isFile(),true);await answer(f,'先不用');assert.equal(f.read().matterSources[input.id].archived,true);
  await service(f).propose({...cmd,requestId:'forget-approved'},Date.now()-10);const reply=await answer(f,'同意');assert.match(reply,/原件和原文已清理/);
  assert.equal(f.read().matterSources[input.id],undefined);assert.ok(f.read().matterSourceTombstones[input.id].purgedAt);
  await assert.rejects(fs.stat(original.attachments[0].path),/ENOENT/);assert.deepEqual(await searchMatterSources(f.api,p,()=>{},'证明'),[]);
  await assert.rejects(readMatterSource(f.api,p,()=>{},input.id),/过期/);
  await assert.rejects(stageMatterSource(f.api,p,()=>{},{messageId:original.messageId,body:original.body,attachments:[]}),/已删除/);
  const otherOriginal=await readMatterSource(f.api,other,()=>{},foreign.id);assert.equal(otherOriginal.attachments[0].available,true);
  const row=f.db.prepare("SELECT value FROM records WHERE namespace='tenant-matter-sources-v1' AND key=?").get(p.id+':'+input.id);assert.equal(row,undefined);
 }finally{f.close()}
});

test('deleting a source retains separately confirmed task summaries and a later notice can still update the matter',async()=>{
 const f=await setup();try{
  const old=await active(f),sourceId=old.sourceIds[0];
  await service(f).change({action:'matter.forget',requestId:'web-forget',value:{sourceIds:[sourceId]}},{consent:'verified-web-choice'});
  assert.equal(f.read().matters.lab.status,'active');assert.equal(f.read().matterSources[sourceId],undefined);
  const fresh=await intake(f,'新更正通知：现在改交纸质。');
  await service(f).propose({action:'matter.update',id:old.id,expectedRevision:old.revision,requestId:'after-forget',value:{sourceIds:[fresh.id],summary:'按新通知交纸质。'}},Date.now()-10);await answer(f);
  assert.deepEqual(f.read().matters.lab.sourceIds,[fresh.id]);assert.equal(f.read().matters.lab.revision,2);
 }finally{f.close()}
});

test('natural save language works for archiving and cannot accidentally approve deletion',async()=>{
 const f=await setup();try{
  const input=await intake(f,'证书原件',p,true),raw=await readMatterSource(f.api,p,()=>{},input.id);
  await service(f).propose({action:'matter.archive',id:'natural-archive',requestId:'natural-save',value:{sourceIds:[input.id],title:'证书'}},Date.now()-10);
  assert.match(await answer(f,'好，存吧'),/保存好了/);
  const forget={action:'matter.forget',id:'delete-language',requestId:'language-before',value:{sourceIds:[input.id]}};
  await service(f).propose(forget,Date.now()-10);assert.equal(await answer(f,'保存吧'),null);assert.equal((await fs.stat(raw.attachments[0].path)).isFile(),true);
  await service(f).propose({...forget,requestId:'language-after'},Date.now()-10);assert.match(await answer(f,'删掉吧'),/原件和原文已清理/);
 }finally{f.close()}
});
