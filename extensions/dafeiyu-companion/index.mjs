import {createHash} from 'node:crypto';
import {createStoryLibrary} from './stories.mjs';
import {loadStoryPacks} from './packs.mjs';

const tenantId = (account, sender) => 'wx-' + createHash('sha256').update(JSON.stringify([account, sender])).digest('hex').slice(0, 32);
function scopeFor(api, ctx) {
  if (typeof ctx.assertInvocationCurrent !== 'function') throw Error('Live private invocation required');
  ctx.assertInvocationCurrent(); ctx.assertInputCommitAllowed?.();
  const account = ctx.agentAccountId, sender = ctx.requesterSenderId;
  if (typeof account !== 'string' || !account || typeof sender !== 'string' || !sender) throw Error('Verified private identity required');
  const id = tenantId(account, sender), config = api.runtime.config.current();
  const expected = `agent:${id}:openclaw-weixin:${account}:direct:${sender}`;
  if (ctx.messageChannel !== 'openclaw-weixin' || ctx.agentId !== id || ctx.sessionKey?.toLowerCase() !== expected.toLowerCase() ||
      !config.bindings?.some(b => b.agentId === id && b.match?.channel === 'openclaw-weixin' && b.match.accountId === account && b.match.peer?.kind === 'direct' && b.match.peer.id === sender) ||
      typeof ctx.sessionId !== 'string' || !ctx.sessionId || typeof ctx.runId !== 'string' || !ctx.runId) throw Error('Verified private session required');
  return {tenant: id, session: ctx.sessionId, run: ctx.runId};
}
export function registerCompanion(api, library = createStoryLibrary({loadPack: () => loadStoryPacks(api)})) {
  api.registerTool({contextVersion: 2, create(ctx) {
    return {name: 'dafeiyu_story', label: '原创虚构小剧场',
      description: '仅在用户欢迎故事或共创时，按需取一张原创虚构卡；普通闲聊不强制使用。先讲开头、慢慢听或一点点听用find取首层；明确续讲用continue。仅明确要求一次讲完或全篇才用full，不因“讲个故事”选择全篇。query只给简短主题，不写剧情或讲述指令。剧情改动用branchDiverged，停止取原剧情。不要故事用pause，再次明确邀请才resume；reset不解除暂停。最多每推理轮一张卡，只留会话内卡ID/层级，不能保存为用户事实、执行任务或主动发信。',
      parameters: {type: 'object', additionalProperties: false, required: ['action'], properties: {
        action: {type: 'string', enum: ['find', 'continue', 'full', 'pause', 'resume', 'reset']},
        query: {type: 'string', maxLength: 120, description: '简短主题关键词，例如便签或饭勺；不写剧情、人物设定、讲述方式或整句请求。'}, branchDiverged: {type: 'boolean'}}},
      async execute(callId, args) {
        try {
          const scope = scopeFor(api, ctx);
          const result = library.request(scope, callId, args, () => scopeFor(api, ctx));
          return {content: [{type: 'text', text: JSON.stringify(result)}], details: result};
        } catch {return {isError: true, content: [{type: 'text', text: '当前会话暂不能调取故事素材；请正常接话，不编造检索成功。'}]};}
      }};
  }}, {name: 'dafeiyu_story', optional: true, workspaceAccess: false});
}
export default {id: 'dafeiyu-companion', name: '大肥鱼闲聊素材', register: registerCompanion};
