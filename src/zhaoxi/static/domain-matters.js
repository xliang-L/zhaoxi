/* The current authenticated agent and the existing domain controls own every action. */
(() => {
  const box=document.getElementById('matters'),files=document.getElementById('documents'),filter=document.getElementById('document-filter');
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const time=(value,zone='Asia/Shanghai')=>value?new Intl.DateTimeFormat('zh-CN',{timeZone:zone,dateStyle:'medium',timeStyle:'short',hourCycle:'h23'}).format(new Date(value))+(zone==='Asia/Shanghai'?' · 北京时间':' · '+zone):'尚未注明';
  const feedback=document.getElementById('matter-feedback');let view={matters:[],documents:[]},busy=false;
  const note=text=>{feedback.hidden=false;feedback.textContent=text};
  function renderDocuments(){
    const query=filter.value.trim().toLowerCase();
    files.innerHTML=(view.documents??[]).filter(d=>[d.title,d.excerpt,...(d.tags??[]),...(d.files??[]).map(f=>f.name)].join(' ').toLowerCase().includes(query)).map(d=>
      `<article class="domain-plan-item"><h3>${escape(d.title)}</h3><p class="domain-footnote">收到于 ${escape(time(d.receivedAt))}${d.tags?.length?' · '+escape(d.tags.join(' / ')):''}</p>${d.excerpt?`<details class="domain-help"><summary>查看原文摘录</summary><p class="matter-source-text">${escape(d.excerpt)}</p></details>`:''}<div class="domain-item-actions">${(d.files??[]).map((f,i)=>`<button type="button" data-document="${escape(d.id)}" data-index="${i}">取回 ${escape(f.name)}</button>`).join('')}<button type="button" data-forget-source="${escape(d.id)}">删除资料…</button></div></article>`).join('')||'<div class="domain-empty domain-empty-small"><h3>先把资料交给她</h3><p>在微信转发文件或截图，说“帮我保存这份资料”。确认后会出现在这里。</p></div>';
  }
  function render(){
    const pending=document.getElementById('matter-pending');pending.textContent=view.pendingConfirmation?'微信里有一份待你确认的整理：\n'+view.pendingConfirmation:'';
    box.innerHTML=(view.matters??[]).map(m=>{
      const active=m.status==='active',sources=(m.sourceIds??[]).map(id=>(view.documents??[]).find(d=>d.id===id)).filter(Boolean);
      return `<article class="domain-plan-item"><div class="domain-plan-title"><h3>${escape(m.title)}</h3><span class="domain-plan-state" data-status="${active?'active':m.status==='completed'?'completed':'cancelled'}">${active?'跟进中':m.status==='completed'?'已完成':'已停止'}</span></div><p>${escape(m.summary)}</p><p class="domain-plan-meta">截止：${escape(time(m.deadlineAt,m.timezone))}${m.submitTo?'\n提交到：'+escape(m.submitTo):''}</p>${m.requirements?.length?'<p>材料与要求：'+m.requirements.map(escape).join('；')+'</p>':''}${m.preparations?.length?'<ul class="matter-preparations">'+m.preparations.map(p=>`<li>${p.done?'✓ 已完成':active?'○ 待准备':'· 原准备项'} ${escape(p.text)}</li>`).join('')+'</ul>':''}${m.reminders?.length?`<details class="domain-help"><summary>${active?m.reminders.length+' 次已确认提醒':'原提醒已停止'}</summary>${m.reminders.map(r=>`<p>${escape(time(r.at,m.timezone))}<br>${escape(r.text)}</p>`).join('')}</details>`:'<p class="domain-footnote">这项尚未设置提醒。</p>'}<details class="domain-help"><summary>来源与变更记录</summary>${sources.map(s=>`<p>${escape(s.title)} · 收到于 ${escape(time(s.receivedAt))}</p>`).join('')||'<p>原资料暂不可用。</p>'}${(m.history??[]).slice().reverse().map(h=>`<p>此前：${escape(h.summary)}<br>截止 ${escape(time(h.deadlineAt,m.timezone))}${h.submitTo?' · '+escape(h.submitTo):''}</p>`).join('')}</details><div class="domain-item-actions">${active?`<button type="button" data-matter="${escape(m.id)}" data-action="matter.complete">我已完成</button><button type="button" data-matter="${escape(m.id)}" data-action="matter.cancel">停止后续提醒</button>`:''}</div></article>`;
    }).join('')||'<div class="domain-empty domain-empty-small"><h3>收到通知，就转给她</h3><p>她会先理清要求和准备步骤，等你同意后，再保存和提醒。</p></div>';
    renderDocuments();if(view.documentCleanupPending)note('有资料已移出资料库，原件尚待清理；刷新页面可重试。');
  }
  document.addEventListener('domain-refreshed',event=>{view=event.detail;render()});filter.addEventListener('input',renderDocuments);
  if(typeof current!=='undefined'&&current){view=current;render()}
  box.addEventListener('click',async event=>{
    const button=event.target.closest('[data-matter]');if(!button||busy)return;
    const matter=view.matters.find(m=>m.id===button.dataset.matter);if(!matter)return;
    busy=true;button.disabled=true;
    try{await api({action:button.dataset.action,id:matter.id,expectedRevision:matter.revision,requestId:request()});await refresh();note(button.dataset.action==='matter.complete'?'已按你的反馈记为完成，后续提醒停止。':'已停止这件事的后续提醒。')}
    catch(error){note(window.userMessage(error.message))}finally{busy=false;button.disabled=false}
  });
  files.addEventListener('click',async event=>{
    const remove=event.target.closest('[data-forget-source]');
    if(remove&&!busy){
      const source=view.documents.find(d=>d.id===remove.dataset.forgetSource);if(!source)return;
      const area=document.getElementById('document-confirm');area.replaceChildren();
      const message=document.createElement('p');message.textContent='删除「'+source.title+'」的归档原文和原件？无法从资料库恢复，关联事项摘要和聊天记录保留。';
      const confirm=document.createElement('button'),cancel=document.createElement('button');confirm.textContent='确认删除这份资料';cancel.textContent='保留资料';area.append(message,confirm,cancel);cancel.onclick=()=>area.replaceChildren();
      confirm.onclick=async()=>{if(busy)return;busy=true;confirm.disabled=true;try{const result=await api({action:'matter.forget',requestId:request(),value:{sourceIds:[source.id]}});area.replaceChildren();await refresh();note(result.cleanupComplete?'已删除这份归档资料和原件。关联事项摘要和聊天记录保留。':'已移出资料库，原件清理尚未完成；刷新页面可重试。')}catch(error){note(window.userMessage(error.message))}finally{busy=false;confirm.disabled=false}};
      return;
    }
    const button=event.target.closest('[data-document]');if(!button||busy)return;busy=true;button.disabled=true;
    try{
      const source=view.documents.find(d=>d.id===button.dataset.document),index=Number(button.dataset.index),scope=await window.agentHeaders();
      const response=await fetch('/api/me/documents/'+encodeURIComponent(source.id)+'/'+index,{headers:scope});
      if(!response.ok){let data={};try{data=await response.json()}catch{}throw Error(window.userMessage(data.detail,response.status))}
      const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=source.files[index].name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);note('已取回原件：'+source.files[index].name);
    }catch(error){note(window.userMessage(error.message))}finally{busy=false;button.disabled=false}
  });
})();
