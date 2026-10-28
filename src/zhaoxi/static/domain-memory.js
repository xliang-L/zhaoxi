/* Account-scoped choices. Reads never grant permission; only explicit clicks POST. */
(() => {
  const byId = id => document.getElementById(id);
  const acknowledgement = byId('memory-notice-ack');
  let state = null, domain = null, busy = false, feedback = '', pendingOperation = null, confirmationOpen = false;
  const publicNotice = text => text.replaceAll('在你的独立服务中', '在朝夕中').replaceAll('独立服务', '朝夕服务').replaceAll('现有聊天模型', '现有聊天 AI').replaceAll('提供给模型', '交给聊天 AI');
  const message = (value, status, fallback) => window.userMessage(value, status, fallback);
  const known = () => state && typeof state.conversationAccess === 'boolean' && !state.pending;
  const uncertain = () => !known() || (state.recordingEnabled && !state.conversationAccess);
  const canEnable = () => state && state.available && !state.requiresConnection && !uncertain() && !!state.noticeText && Number.isInteger(state.noticeVersion) && state.noticeVersion > 0 && typeof state.choiceRevision === 'string' && state.choiceRevision.length > 0 && !!domain?.autoFactMemory;
  const effective = kind => ['enable', 'revoke', 'stop'].includes(kind) && known() && !state.requiresConnection && (kind === 'enable'
    ? state.conversationAccess === true && state.recordingEnabled === true
    : kind === 'revoke' ? state.conversationAccess === false && state.recordingEnabled === false
    : state.recordingEnabled === false);
  const time = value => {
    if (value == null || !Number.isFinite(new Date(value).getTime())) return '时间待确认';
    return displayTime(value);
  };
  function renderSuggestions() {
    const target = byId('auto-fact-suggestions');
    target.replaceChildren();
    const items = domain?.autoFactMemory?.suggestions || [];
    if (!items.length) return;
    const heading = document.createElement('h3');
    heading.textContent = '对话里需要核对的信息';
    target.append(heading);
    for (const item of items) {
      const article = document.createElement('article'), text = document.createElement('p'), provenance = document.createElement('small'), button = document.createElement('button');
      text.textContent = item.text;
      provenance.textContent = '来自对话 · ' + time(item.sourceTime ?? item.sourceAt ?? item.createdAt) + ' · 有效至 ' + time(item.expiresAt);
      button.type = 'button';
      button.textContent = '确认并保存这条信息';
      button.disabled = busy || !!domain.factMemoryPaused || item.status !== 'awaiting_confirmation' || !(new Date(item.expiresAt).getTime() > Date.now());
      button.addEventListener('click', () => {
        if (button.disabled || busy) return;
        perform('suggestion', { id: item.id, expectedRevision: item.revision });
      });
      article.append(text, provenance, button);
      target.append(article);
    }
  }
  function render() {
    const unresolved = uncertain(), connected = state && !state.requiresConnection;
    let badge = '状态未确认', reading = '未确认', recording = '未确认', status = '请刷新核对设置，尚不能确认是否生效。';
    if (state) {
      if (!state.available) {
        badge = '暂不可用'; status = '这项功能尚未准备好，当前不能开启。已有授权请以下方核对结果为准。';
      } else if (!connected) {
        badge = '请先连接微信'; status = '连接本人微信后，才能核对设置并选择开启。暂停连接不等于撤销读取授权。';
      } else if (unresolved) {
        badge = '正在核对'; status = '设置尚未确认生效，请稍后刷新；已提交选择不代表已获授权。';
      } else if (state.conversationAccess && state.recordingEnabled) {
        badge = '自动记忆已开启'; status = '只按说明中的有限范围整理信息，不确定的内容仍需你确认。';
      } else if (state.conversationAccess) {
        badge = '自动记忆已停止'; status = '已停止自动保存和取用；读取对话的授权仍然保留。';
      } else {
        badge = '尚未授权读取'; status = '尚未授权读取对话，自动记忆未开启。你可以继续手动管理下方记录。';
      }
      if (connected && !unresolved) {
        reading = state.conversationAccess ? '已允许' : '未允许';
        recording = state.recordingEnabled ? (domain?.factMemoryPaused ? '已开启，写入已暂停' : '已开启') : '已停止';
      } else if (!connected) {
        reading = '连接后核对'; recording = '当前未运行';
      }
    }
    if (busy) { badge = '正在确认'; reading = '正在核对'; recording = '正在核对'; }
    byId('memory-access-badge').textContent = badge;
    byId('memory-reading-state').textContent = reading;
    byId('memory-recording-state').textContent = recording;
    byId('memory-access-status').textContent = status;
    byId('memory-notice-text').textContent = state?.noticeText ? publicNotice(state.noticeText) : '说明尚未读取完整，暂不能开启。请刷新后重试。';
    const enabled = known() && state.conversationAccess && state.recordingEnabled;
    byId('memory-enable-group').hidden = !!enabled;
    acknowledgement.disabled = busy || !canEnable();
    byId('memory-enable').disabled = busy || !canEnable() || !acknowledgement.checked;
    byId('memory-enable').textContent = pendingOperation?.kind === 'enable' ? '重试上次开启' : state?.conversationAccess ? '同意并恢复自动记忆' : '同意并开启';
    byId('memory-stop-group').hidden = !state?.recordingEnabled;
    byId('memory-auto-stop').disabled = busy || !known();
    byId('memory-auto-stop').textContent = pendingOperation?.kind === 'stop' ? '重试停止自动记忆' : '停止自动记忆';
    byId('memory-revoke-group').hidden = !(state?.requested || state?.conversationAccess || pendingOperation?.kind === 'revoke');
    byId('memory-revoke-open').disabled = busy || !known();
    byId('memory-revoke-confirmation').hidden = !confirmationOpen;
    byId('memory-revoke-confirm').disabled = busy || !known();
    byId('memory-revoke-cancel').disabled = busy;
    byId('memory-revoke-cancel').textContent = pendingOperation?.kind === 'revoke' ? '关闭确认' : '暂不撤销';
    byId('memory-access-refresh').disabled = busy;
    byId('memory-connect-link').hidden = !state?.requiresConnection;
    byId('memory-access-feedback').textContent = feedback;
    renderSuggestions();
  }
  async function request(path, body) {
    let response;
    try {
      const headers = await window.agentHeaders();
      response = await fetch(path, body ? { method: 'POST', credentials: 'same-origin', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { credentials: 'same-origin', headers });
    } catch {
      throw new Error('连接中断，操作结果尚未确认。');
    }
    let data;
    try { data = await response.json(); } catch { const error = new Error('返回结果不完整，操作结果尚未确认。'); error.status = response.status; throw error; }
    if (!response.ok) { const error = new Error(message(data.detail, response.status, '操作未完成，请刷新核对当前状态。')); error.status = response.status; throw error; }
    return data;
  }
  async function readState(refreshRecords = false) {
    const next = await request('/api/me/memory-access');
    const fields = ['available', 'requiresConnection', 'requested', 'pending', 'recordingEnabled'];
    if (!next || fields.some(key => typeof next[key] !== 'boolean') || ![true, false, null].includes(next.conversationAccess) || typeof next.choiceRevision !== 'string' || !next.choiceRevision) throw new Error('设置返回不完整，当前状态尚未确认。');
    if (state?.noticeVersion !== next.noticeVersion || state?.choiceRevision !== next.choiceRevision) acknowledgement.checked = false;
    state = next;
    domain = await request('/api/me/domain');
    if (refreshRecords) {
      await refresh();
      if (typeof current === 'object') domain = current;
    }
  }
  function discardStaleEnable() {
    if (pendingOperation?.kind !== 'enable' || !state || state.pending || effective('enable')) return false;
    if (pendingOperation.noticeVersion === state.noticeVersion && pendingOperation.expectedChoiceRevision === state.choiceRevision) return false;
    pendingOperation = null;
    acknowledgement.checked = false;
    feedback = '之前的开启选择已失效。已刷新当前设置，请重新阅读说明、勾选并选择；不会自动开启。';
    return true;
  }
  async function reload() {
    if (busy) return;
    busy = true; render();
    try {
      await readState();
      if (!discardStaleEnable() && pendingOperation && effective(pendingOperation.kind)) {
        pendingOperation = null;
        acknowledgement.checked = false;
        feedback = '已重新读取当前设置，请以下方显示的状态为准。';
      }
    } catch (error) {
      state = null;
      feedback = '当前设置尚未核实。' + message(error.message, null, '请稍后刷新重试。');
    } finally { busy = false; render(); }
  }
  async function perform(kind, value = {}) {
    if (busy) return;
    if (kind === 'enable' && (!canEnable() || !acknowledgement.checked)) return;
    if (kind !== 'suggestion' && !known()) return;
    const same = pendingOperation?.kind === kind && pendingOperation?.id === value.id;
    const operation = same ? pendingOperation : { kind, ...value, requestId: crypto.randomUUID(), noticeVersion: state?.noticeVersion, expectedChoiceRevision: state?.choiceRevision };
    if (kind === 'enable' && (operation.noticeVersion !== state.noticeVersion || operation.expectedChoiceRevision !== state.choiceRevision)) {
      feedback = '说明或选择已更新，请重新阅读、勾选并选择。'; acknowledgement.checked = false; pendingOperation = null; render(); return;
    }
    pendingOperation = operation;
    busy = true; feedback = ''; render();
    const body = { action: kind === 'stop' ? 'fact.auto.disable' : kind === 'suggestion' ? 'fact.auto.confirm' : kind, requestId: operation.requestId };
    if (kind === 'enable') Object.assign(body, { noticeVersion: operation.noticeVersion, acknowledged: true, expectedChoiceRevision: operation.expectedChoiceRevision });
    if (kind === 'suggestion') Object.assign(body, { id: operation.id, expectedRevision: operation.expectedRevision });
    try {
      await request(kind === 'stop' || kind === 'suggestion' ? '/api/me/domain' : '/api/me/memory-access', body);
      await readState(kind === 'suggestion');
      if (kind === 'enable' && discardStaleEnable()) return;
      if (kind === 'suggestion') {
        pendingOperation = null; feedback = '建议列表已更新，请核对下方已保存记录。';
      } else if (effective(kind)) {
        pendingOperation = null; acknowledgement.checked = false;
        if (kind === 'revoke') { feedback = '当前已核对为不再允许读取，自动记忆已停止；已有记录仍保留。'; confirmationOpen = false; }
        if (kind === 'stop') feedback = '自动保存和取用已停止，读取对话的授权仍然保留。';
        if (kind === 'enable') feedback = '已核对读取授权和自动记忆均已开启。';
      } else feedback = '请求已提交，但当前状态尚未确认生效。请刷新核对，不要把提交当作成功。';
    } catch (error) {
      const requiresNewChoice = kind === 'enable' && error.status === 409;
      if (requiresNewChoice) { pendingOperation = null; acknowledgement.checked = false; }
      const prefix = kind === 'revoke' ? '撤销尚未确认。' : kind === 'stop' ? '停止自动记忆尚未确认。' : kind === 'enable' ? '开启尚未确认。' : '保存建议尚未确认。';
      feedback = prefix + message(error.message, null, '请刷新核对当前状态。');
      try {
        await readState(kind === 'suggestion');
        feedback += '已重新读取设置，请核对当前状态。';
        if (requiresNewChoice) {
          acknowledgement.checked = false;
          feedback += '之前的开启选择已失效，请重新阅读说明、勾选并选择；不会自动重试授权。';
        } else if (kind === 'enable' && discardStaleEnable()) {
          // A newer choice supersedes the uncertain enable request.
        } else if (kind !== 'suggestion' && effective(kind)) {
          pendingOperation = null; acknowledgement.checked = false;
          feedback += '本次操作的当前状态已核对，请以状态栏为准。';
        } else feedback += '如需重试，会沿用同一次请求，不会自动重新提交。';
      } catch {
        state = null; feedback += requiresNewChoice ? '旧开启选择已作废，目前也无法读取设置；请先刷新，再重新阅读并选择。' : '目前也无法读取设置，请先刷新状态；不会自动重试提交。';
      }
    } finally { busy = false; render(); }
  }
  acknowledgement.addEventListener('change', render);
  byId('memory-enable').addEventListener('click', () => perform('enable'));
  byId('memory-auto-stop').addEventListener('click', () => perform('stop'));
  byId('memory-access-refresh').addEventListener('click', reload);
  byId('memory-revoke-open').addEventListener('click', () => { confirmationOpen = true; render(); byId('memory-revoke-cancel').focus(); });
  byId('memory-revoke-cancel').addEventListener('click', () => { confirmationOpen = false; render(); });
  byId('memory-revoke-confirm').addEventListener('click', () => perform('revoke'));
  document.addEventListener('domain-refreshed', event => { domain = event.detail; render(); });
  if (typeof current === 'object') domain = current;
  render();
  reload();
})();
