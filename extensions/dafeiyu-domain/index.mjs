import {createRuntimeAdapters} from './core/runtime-adapters.mjs';
import {registerControls} from './core/controls.mjs';
import {createDomainService} from './core/service.mjs';
import {registerFactMemory} from './memory/fact-hooks.mjs';
import {registerMatterTools} from './matters/matter-tools.mjs';
const actions=['fact.propose','list','plan.create','plan.update','plan.postpone','plan.complete','plan.cancel','plan.delete','preferences.propose','preferences.pause','preferences.disable'];
export function registerDomain(api,{proactiveAdapters={},deliveryAdapter,greetingGenerator}={}){
 registerControls(api,{proactiveAdapters,deliveryAdapter,greetingGenerator});
registerFactMemory(api);
 registerMatterTools(api);
 api.registerTool({contextVersion:2,create(ctx){
  return {name:'dafeiyu_plan',label:'个人计划与偏好草稿',description:'仅操作当前已认证用户的计划、提醒和偏好。除 list 查询外，这个工具只提出待本人确认的提议，不能自行执行或代替用户同意。创建、改期、修改、完成、取消、删除和提醒设置都先说明 summary 中的具体事项与时间，询问是否照做；用户本人接着回复“同意”“就这么办”“好的”后，微信入站会直接处理并确认结果。不得要求用户发送任何 /fish 指令，不展示内部 ID、版本、nonce 或原始 JSON。明确确认的计划到时提醒本人，不需要开启日常问候；只处理当前提议的事项，不扩大到其他提醒或记忆。一次可提议至多十项，同一轮会汇总确认。想修改提议时先 list 读取实际状态，重新提出，不得把待确认的预览说成已经保存。自动记忆仍只记录已授权本人明确说出的常住城市、兴趣和回复偏好；用户接着口头同意后后台保存，不要求复制命令。fact.propose 的手动偏好同样先自然核对再由本人同意。天气和 AI 自动资讯尚未开放，不能声称已启用；不猜定位。提醒设置须说清类别、时间、次数与安静时段，只作用于本人。用户可直接说查看计划、查看提醒设置、暂停主动问候或关闭主动问候；不要在普通回复中暴露调试协议。',parameters:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:actions},id:{type:'string'},expectedRevision:{type:'integer'},requestId:{type:'string'},value:{type:'object'}}},
   async execute(_callId,args){
    try{
     if(!actions.includes(args.action))throw Error('Unsupported action');
     const service=createDomainService(api,ctx);
     const result=args.action==='list'?await service.read():await service.propose(args);
     return {content:[{type:'text',text:JSON.stringify(result)}],details:result};
    }catch(error){return {isError:true,content:[{type:'text',text:error.message}]};}
   }};
 }},{name:'dafeiyu_plan',optional:true,workspaceAccess:false});
}
export default {id:'dafeiyu-domain',name:'大肥鱼个人计划与偏好',register(api){registerDomain(api,createRuntimeAdapters(api))}};
