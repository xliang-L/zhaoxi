/* Translate service failures without exposing implementation details to members. */
let pageAgentScope;
window.agentHeaders = async () => {
  pageAgentScope ??= fetch('/api/auth/session', {credentials:'same-origin'}).then(async response => {
    if (!response.ok) throw new Error('暂时无法确认当前智能体，请刷新后重试。');
    const actor = (await response.json()).actor;
    const label = document.getElementById('current-agent-scope');
    if (actor && label) {
      const response = await fetch('/api/me/agents', {credentials:'same-origin'});
      if (!response.ok) throw new Error('暂时无法核对当前智能体，请刷新后重试。');
      const agent = (await response.json()).agents?.find(agent => agent.id === actor.space_id);
      if (!agent) throw new Error('当前智能体已变更，请刷新后重试。');
      label.textContent = '当前智能体：' + agent.label;
    }
    return actor?.space_id;
  });
  const space = await pageAgentScope;
  return space ? {'X-Zhaoxi-Agent':space} : {};
};
window.userMessage = (detail, status, fallback = '操作未完成，请稍后重试。') => {
  const message = (Array.isArray(detail) ? detail.map(item => item.msg).join('；') : typeof detail === 'string' ? detail : '').trim();
  const translations = [
    [/独立后台未能启动/, '微信连接未能启动，请重试；若仍失败，请联系管理员。'],
    [/独立后台启动超时/, '微信连接超时，请稍后重试。'],
    [/无法.*(?:核实|确认).*后台|后台身份已变化|后台端口尚未释放/, '暂时无法确认微信连接状态，请稍后刷新后再试。'],
    [/独立后台暂时未完成请求/, '微信连接暂时未能完成操作，请稍后重试。'],
    [/这个空间属于另一个微信账号/, '请使用原来绑定的微信重新扫码，已有资料没有被替换。'],
    [/这个微信已经有自己的空间/, '这个微信已绑定其他朝夕账号，请登录原账号后连接。'],
    [/这个空间(?:已有扫码操作|正在连接)/, '正在连接微信，请先等待完成或暂停连接。'],
    [/找不到这个用户空间|空间尚未准备好/, '暂时无法读取账号信息，请稍后重试。'],
    [/只能操作自己的用户空间/, '只能操作自己的账号。'],
    [/需要管理员权限|此接口仅供管理员/, '此操作需要管理员权限。'],
    [/仅接受本机应用页面发起的操作/, '请从朝夕页面发起操作，刷新页面后重试。'],
    [/微信凭证路径不可用/, '微信授权信息暂不可用，请重新扫码。'],
    [/底座|运行包|源码.*构建|pnpm build|本机安装/, '微信连接服务暂不可用，请稍后重试；若仍失败，请联系管理员。'],
    [/Plan revision conflict|Fact.*(?:revision conflict|changed)|Reminder state changed|Settings changed|Concurrent change/, '内容已更新，请刷新后核对，再重新操作。'],
    [/Settings draft missing or expired|Fact confirmation missing, changed or expired|Confirmation nonce.*(?:missing|expired|invalid)|Deletion confirmation missing or expired/, '本次确认已失效，请刷新后重新确认。'],
    [/Unknown or non-draft plan|Unknown plan$|Unknown fact$/, '这条记录已变更或不存在，请刷新后核对。'],
    [/Fact intake paused/, '记录保存已暂停，请先恢复后再添加。'],
    [/capacity|Too many pending settings drafts/i, '已达到当前可保存数量上限，请整理已有记录后再试。'],
    [/End must follow start/, '结束时间必须晚于开始时间。'],
    [/timezone|Timezone/, '请填写有效时区，例如 Asia/Shanghai。'],
    [/dueAt|Invalid recurrence end/, '请检查计划的日期和时间。'],
    [/Term start required for parity/, '单双周计划需要填写学期第一周周一。'],
    [/Invalid quiet hours/, '请填写有效的安静时段。'],
    [/Greeting limit must be 0–5/, '问候每日上限须为 0–5 次。'],
    [/Invalid bounded text/, '请填写内容，并检查是否超出字数限制。'],
    [/Explicit .*?(?:confirmation|consent|choice|review)|Explicit consent receipt/, '请先核对内容并明确确认，本次操作未完成。'],
    [/Tenant binding revoked|tenant.*(?:mismatch|revoked)|Private .*binding required|Portal requires one unambiguous owner binding|Verified Weixin identity required/i, '微信授权暂时无法核验，请到微信连接页检查后重试。'],
    [/authority expired|Request expired|Application request expired/i, '本次操作已过期，请刷新后重试。'],
    [/Business delivery.*(?:not enabled|disabled)/, '主动消息尚未启用，当前不会发送。'],
  ];
  for (const [pattern, text] of translations) if (pattern.test(message)) return text;
  if (status === 401) return '登录已过期，请重新登录。';
  if (status === 403) return '没有权限执行此操作，请检查登录账号。';
  const internal = /模型|路由|工作区|空间|租户|tenant|agent|debug|OpenClaw|Gateway|traceback|stack|底座|后台|进程|端口|凭证|源码|构建|node_modules|\/(?:Users|home|tmp|var)\/|https?:\/\/|(?:api[_ -]?key|secret|token)\s*[:=]/i;
  if (message && /[\u4e00-\u9fff]/.test(message) && !internal.test(message)) return message;
  if (status === 409) return '当前状态已变化，请刷新后核对，再重新操作。';
  return fallback;
};
