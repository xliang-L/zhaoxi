const $ = id => document.getElementById(id);
const titles = {wechat: '微信连接', persona: '人设', stories: '故事包', settings: '模型与额度'};
const phases = {unbound: '未绑定', waiting: '等待扫码', scanned: '已扫码', verifying: '正在核验', starting: '正在启动', connected: '已连接', stopped: '已暂停', expired: '二维码已过期', error: '需要处理'};
let actor, setupRequired, activeId, status, persona, settings, packs, qrGeneration;
let personaDirty = false;
const pendingButtons = new Set();

async function api(url, body, method = 'POST') {
  const headers = activeId ? {'X-Zhaoxi-Agent': activeId} : {};
  const options = {headers, credentials: 'same-origin'};
  if (body !== undefined) {
    options.method = method;
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  if (response.status === 401) {
    $('console').hidden = true;
    $('auth').hidden = false;
    throw Error('登录已过期，请重新登录。');
  }
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    throw Error(typeof value.detail === 'string' ? value.detail : '操作未完成，请检查填写内容后重试。');
  }
  return response.json();
}

function feedback(message, error = false) {
  $('feedback').textContent = message;
  $('feedback').dataset.error = String(error);
}

async function run(action, button) {
  if (button) {pendingButtons.add(button.id); button.disabled = true;}
  try { await action(); }
  catch (error) { feedback(error.message, true); }
  finally {
    if (button) {pendingButtons.delete(button.id); button.disabled = false;}
    updateConnectionButtons();
  }
}

function updateConnectionButtons() {
  const bot = status?.connections.find(bot => bot.id === activeId);
  if (!bot) return;
  $('connect').disabled = !status.engine_ready || !status.model_ready || Boolean(bot.qr_generation) || pendingButtons.has('connect');
  $('resume').disabled = !bot.connected || bot.running || pendingButtons.has('resume');
  $('stop').disabled = (!bot.running && !bot.qr_generation) || pendingButtons.has('stop');
  $('disconnect').disabled = !bot.connected || pendingButtons.has('disconnect');
}

function panel() {
  const name = Object.hasOwn(titles, location.hash.slice(1)) ? location.hash.slice(1) : 'wechat';
  for (const element of document.querySelectorAll('[data-panel]')) element.hidden = element.dataset.panel !== name;
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  $('page-title').textContent = titles[name];
}
window.addEventListener('hashchange', panel);
panel();

function stat(label, value) {
  const element = document.createElement('div');
  element.className = 'stat';
  const small = document.createElement('small');
  small.textContent = label;
  const strong = document.createElement('strong');
  strong.textContent = value;
  element.append(small, strong);
  return element;
}

async function refreshStatus() {
  status = await api('/api/status');
  activeId ??= status.selected;
  if (activeId !== status.selected) {
    feedback('其他页面切换了机器人。请刷新此页面后再编辑。', true);
    return;
  }
  $('bot-select').replaceChildren(...status.connections.map(bot => new Option(bot.label, bot.id, false, bot.id === activeId)));
  const bot = status.connections.find(bot => bot.id === activeId);
  const usage = status.usage ? status.usage.tokens.toLocaleString() : '待同步';
  const limit = status.monthly_token_limit === null ? '不限额' : status.monthly_token_limit.toLocaleString();
  $('stats').replaceChildren(stat('OPENCLAW', status.engine_ready ? '已就绪' : '等待安装运行包'), stat('本月 Token', usage), stat('月额度 · 所有机器人共享', limit));
  if (!bot) return;
  $('connection-phase').textContent = phases[bot.phase] || bot.phase;
  $('connection-error').textContent = bot.last_error || '';
  updateConnectionButtons();
  $('verify-form').hidden = !['waiting', 'scanned', 'verifying'].includes(bot.phase);
  const body = $('connection-body');
  if (bot.qr_ready) {
    if (qrGeneration !== bot.qr_generation) {
      const image = document.createElement('img');
      image.className = 'qr'; image.alt = '微信绑定二维码';
      image.src = '/api/me/qr.png?t=' + Date.now();
      const hint = document.createElement('p');
      hint.className = 'muted'; hint.textContent = '请使用自己的微信扫码，并在手机上确认。';
      body.replaceChildren(image, hint);
      qrGeneration = bot.qr_generation;
    }
  } else {
    qrGeneration = null;
    const icon = document.createElement('div');
    icon.className = 'qr-placeholder'; icon.textContent = bot.phase === 'connected' ? '已连接' : '微信';
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = bot.phase === 'connected' ? '现在可以在微信里聊天了。' :
      !status.model_ready ? '先到「模型与额度」填写模型服务。' :
      !status.engine_ready ? '运行 python scripts/install_runtime.py 准备运行包，再回到这里绑定。' :
      bot.qr_generation ? '正在准备扫码连接，请稍候…' :
      bot.connected ? '微信授权已保留，可以恢复连接。' : '点击下方按钮生成绑定二维码。';
    body.replaceChildren(icon, hint);
  }
}

async function loadPersona() {
  persona = await api('/api/me/persona');
  const form = $('persona-form');
  for (const [name, value] of Object.entries(persona)) if (form.elements[name]) form.elements[name].value = value;
  personaDirty = false;
  $('persona-state').textContent = '已载入当前人设。';
  $('persona-preview').hidden = true;
}

async function loadSettings() {
  settings = await api('/api/settings');
  const form = $('settings-form');
  for (const [name, value] of Object.entries(settings)) if (form.elements[name] && name !== 'api_key') form.elements[name].value = value ?? '';
  form.elements.api_key.value = '';
  form.elements.clear_api_key.checked = false;
  form.elements.unlimited.checked = settings.monthly_token_limit === null;
  form.elements.monthly_token_limit.disabled = form.elements.unlimited.checked;
  $('key-state').textContent = settings.api_key_configured ? '密钥已保存' : '尚未设置密钥';
}

async function loadPacks() {
  packs = await api('/api/story-packs');
  const container = $('pack-list');
  container.replaceChildren();
  for (const pack of packs.packs) {
    const card = document.createElement('article');
    card.className = 'pack';
    const title = document.createElement('h3'); title.textContent = pack.name;
    const info = document.createElement('p'); info.textContent = `${pack.cards} 张卡片 · ${pack.language || '未指定语言'} · ${pack.enabled ? '已启用' : '已关闭'}`;
    const id = document.createElement('p'); id.textContent = pack.id;
    const actions = document.createElement('div'); actions.className = 'actions';
    const toggle = document.createElement('button'); toggle.type = 'button';
    toggle.textContent = pack.enabled ? '关闭' : '启用';
    toggle.onclick = () => run(async () => {
      await api('/api/story-packs/' + encodeURIComponent(pack.id), {revision: packs.revision, enabled: !pack.enabled}, 'PUT');
      await loadPacks(); feedback('故事包设置已生效。');
    }, toggle);
    const download = document.createElement('a');
    download.textContent = '导出 JSON'; download.href = '/api/story-packs/' + encodeURIComponent(pack.id) + '/export';
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移除'; remove.className = 'danger';
    remove.onclick = () => {
      if (!confirm('移除此故事包？需要保留内容时，请先导出 JSON。')) return;
      run(async () => {
        await api('/api/story-packs/' + encodeURIComponent(pack.id) + '?revision=' + packs.revision, {}, 'DELETE');
        await loadPacks(); feedback('故事包已移除。');
      }, remove);
    };
    actions.append(toggle, download, remove); card.append(title, info, id, actions); container.append(card);
  }
  if (!packs.packs.length) container.textContent = '还没有故事包。可以导入自己的 JSON 素材。';
}

async function openConsole() {
  $('auth').hidden = true; $('console').hidden = false;
  activeId = actor.space_id;
  await refreshStatus();
  await Promise.all([loadPersona(), loadSettings(), loadPacks()]);
  if (!status.model_ready) location.hash = '#settings';
}

$('auth-form').onsubmit = async event => {
  event.preventDefault();
  const form = event.target, button = form.querySelector('button'); button.disabled = true;
  try {
    actor = (await api('/api/auth/' + (setupRequired ? 'setup' : 'login'), {username: form.elements.username.value, password: form.elements.password.value})).actor;
    form.elements.password.value = '';
    setupRequired = false;
    await openConsole();
  } catch (error) { $('auth-feedback').textContent = error.message; }
  finally { button.disabled = false; }
};
$('logout').onclick = () => run(async () => { await api('/api/auth/logout', {}); location.reload(); });

$('bot-select').onchange = event => {
  const next = event.target.value;
  if (personaDirty && !confirm('人设还有未保存的修改，切换机器人会放弃这些修改。继续吗？')) {
    event.target.value = activeId;
    return;
  }
  run(async () => {
    actor = (await api('/api/me/agents/' + next + '/select', {})).actor;
    activeId = actor.space_id; qrGeneration = null;
    await refreshStatus(); await loadPersona(); feedback('已切换机器人。');
  });
};
$('add-bot').onclick = () => {
  const name = prompt('新机器人的名字');
  if (!name?.trim()) return;
  run(async () => { await api('/api/me/agents', {name: name.trim()}); await refreshStatus(); feedback('机器人已创建，可以从右上角切换后绑定。'); });
};
for (const [id, action] of [['connect','login'], ['resume','start'], ['stop','stop'], ['disconnect','disconnect']]) {
  $(id).onclick = () => {
    if (action === 'disconnect' && !confirm('移除当前机器人保存在本机的微信凭证？人设、记忆和计划仍会保留。')) return;
    run(async () => { await api('/api/me/connection/' + action, {}); await refreshStatus(); feedback(action === 'login' ? '正在准备二维码…' : '已提交操作。'); }, $(id));
  };
}
$('verify-form').onsubmit = event => {
  event.preventDefault();
  run(async () => { await api('/api/me/connection/verify', {code: event.target.elements.code.value}); feedback('验证码已提交，正在核验。'); });
};

$('persona-form').oninput = () => { personaDirty = true; $('persona-state').textContent = '有尚未保存的修改。'; };
$('persona-template').onchange = async event => {
  if (!event.target.value) return;
  const soul = (await api('/api/persona-templates/' + event.target.value)).soul;
  $('persona-form').elements.soul.value = soul;
  personaDirty = true; $('persona-state').textContent = '模板已载入，保存后才会应用。'; event.target.value = '';
};
function personaValue() {
  const value = Object.fromEntries(new FormData($('persona-form')));
  return {...value, revision: persona.revision};
}
$('preview-persona').onclick = () => {
  const value = personaValue();
  const additions = [['名字','name'],['身份','identity'],['性格','personality'],['说话方式','speaking_style'],['生活与背景','background'],['相处边界','boundaries']]
    .filter(([,key]) => value[key].trim()).map(([title,key]) => '## ' + title + '\n\n' + value[key].trim());
  $('persona-preview').textContent = value.soul.trimEnd() + '\n\n' + additions.join('\n\n');
  $('persona-preview').hidden = false; $('persona-preview').scrollIntoView({block:'nearest'});
};
$('persona-form').onsubmit = event => {
  event.preventDefault();
  run(async () => {
    persona = await api('/api/me/persona', personaValue(), 'PUT');
    personaDirty = false; $('persona-state').textContent = '已保存，下一轮对话开始使用。';
    await refreshStatus(); feedback('人设已保存。');
  }, event.submitter);
};

$('pack-file').onchange = event => {
  const file = event.target.files[0]; if (!file) return;
  run(async () => {
    if (file.size > 1024 * 1024) throw Error('故事包请控制在1 MB以内。');
    const pack = JSON.parse(await file.text());
    await api('/api/story-packs', {revision: packs.revision, pack}); await loadPacks();
    feedback('故事包已导入，核对后可以启用。');
  }).finally(() => { event.target.value = ''; });
};
$('settings-form').elements.unlimited.onchange = event => { $('settings-form').elements.monthly_token_limit.disabled = event.target.checked; };
$('settings-form').onsubmit = event => {
  event.preventDefault();
  run(async () => {
    const form = event.target, value = Object.fromEntries(new FormData(form));
    delete value.unlimited;
    value.monthly_token_limit = form.elements.unlimited.checked ? null : Number(value.monthly_token_limit);
    value.context_tokens = Number(value.context_tokens); value.max_tokens = Number(value.max_tokens);
    value.clear_api_key = form.elements.clear_api_key.checked; value.revision = settings.revision;
    const saved = await api('/api/settings', value, 'PUT');
    await loadSettings(); await refreshStatus();
    $('settings-state').textContent = '已保存。';
    feedback(saved.reconnecting ? `设置已保存，${saved.reconnecting} 个机器人正在重新连接。` : '设置已保存。');
  }, event.submitter);
};
window.addEventListener('beforeunload', event => { if (personaDirty) {event.preventDefault();event.returnValue = '';} });

try {
  const session = await api('/api/auth/session');
  setupRequired = session.setup_required; actor = session.actor;
  $('auth-title').textContent = setupRequired ? '设置管理员' : '登录管理台';
  $('auth-description').textContent = setupRequired ? '为这份部署设置一个管理员。没有公开注册入口。' : '管理你的微信助理。';
  if (actor) await openConsole(); else $('auth').hidden = false;
} catch (error) { $('auth').hidden = false; $('auth-feedback').textContent = error.message; }
setInterval(() => { if (actor && !$('console').hidden && document.visibilityState === 'visible') run(refreshStatus); }, 6000);
