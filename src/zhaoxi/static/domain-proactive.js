/* Uses only the published candidate's own-account domain contract. */
(() => {
  const $ = id => document.getElementById(id), form = $('prefs'), followupForm = $('proactive-followup');
  const labels = { reminder: '课表与计划提醒', weather: '天气关心', interest: '兴趣话题', greeting: '计划完成后的问候', memory: '记忆的一次跟进' };
  const reasons = { release_unavailable:'暂不可用，当前不会自动发送', settings_changed:'设置已变更，旧资料不会继续用于主动联系', partial:'资料不完整，暂不采用', empty:'暂无可靠新消息', blocked:'来源目前无法读取', unsupported:'资料来源尚未接通', needs_explicit_city:'城市或天气位置待确认', needs_configuration:'资料尚未配置完整', needs_explicit_interest:'还没有选择兴趣主题', approved_transport_unavailable:'资料来源尚未接通', approved_topic_adapter_unavailable:'该主题的资料来源尚未接通', provider_error:'资料读取暂时失败，请稍后再看', no_fresh_verified_item:'暂时没有可核对的新消息', no_evidence:'暂无可靠新资料', ready:'已有可核对的资料', disabled:'未开启或已暂停', paused:'记录写入已暂停', reviewed_facts_only:'只使用你另行审核过的记录', beijing_window:'当前不在北京时间 09:00–24:00 内', greeting_limit:'今日共享问候次数已达上限', cooldown:'仍在两次问候的间隔内', conversation_active:'正在聊天，暂缓主动消息', eligible:'符合当前条件，仍需发送前核对',greeting_deferred:'这次稍后再联系',recent_chat:'刚聊过天，稍后再来',preferred_active_hours:'优先等待你常聊天的时段',learning_activity_hours:'正在了解你的聊天习惯，稍后再来' };
  let data = null, known = false, busy = false, serial = 0, editVersion = 0, dirty = false, draft = null, followupDraft = null, pendingRequest = null, maxRevision = -1;
  const uuid = () => crypto.randomUUID();
  const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])) : v);
  const editableKeys = ['enabled','paused','timezone','quietStart','quietEnd','greetingLimit','cooldownMinutes','dailyGreetingEnabled','dailyGreetingTime','city','weatherLocation','interests','categories'];
  const comparable = p => Object.fromEntries(editableKeys.map(k=>[k,p?.[k]??null]));
  const contractReady = () => known && data && Number.isInteger(data.revision) && typeof data.proactiveStatus?.deliveryReady === 'boolean' && typeof data.preferences?.categories?.memory === 'boolean' && Object.hasOwn(data.preferences,'weatherLocation') && Number.isInteger(data.preferences.cooldownMinutes);
  const reason = value => reasons[value] || '状态待核对，暂不确认可发送';
  const showTime = value => value == null ? '尚未核对' : Number.isFinite(new Date(value).getTime()) ? displayTime(value) : '时间待核对';
  const text = (id, value) => { $(id).textContent = value; };
  function invalidatePreview(note) {
    draft = null; $('preview').replaceChildren(); text('proactive-edit-state', note || '正在编辑，尚未保存。');
  }
  function fill(p) {
    form.elements.enabled.checked = !!p.enabled && !p.paused;
    for (const k of ['timezone','quietStart','quietEnd','greetingLimit','cooldownMinutes']) form.elements[k].value = p[k] ?? '';
    form.elements.dailyGreetingEnabled.checked = p.dailyGreetingEnabled === true;
    form.elements.dailyGreetingTime.value = p.dailyGreetingTime || '18:30';
    form.elements.city.value = p.city ?? '';
    form.elements.interests.value = (p.interests || []).join('\n');
    form.elements.latitude.value = p.weatherLocation?.latitude ?? '';
    form.elements.longitude.value = p.weatherLocation?.longitude ?? '';
    $('weather-location-ack').checked = false; $('proactive-source-ack').checked = false;
    for (const key of Object.keys(labels)) {
      let checkbox = form.elements['category-'+key];
      if (!checkbox) {
        const label = document.createElement('label'); checkbox = document.createElement('input'); checkbox.type='checkbox'; checkbox.name='category-'+key;
        label.append(checkbox,document.createTextNode(' '+labels[key]+(data?.availableCategories?.[key]===false?'（暂不可用）':''))); $('categories').append(label);
      }
      checkbox.checked = data?.availableCategories?.[key]!==false && p.categories?.[key] === true;
    }
    dirty = false;
  }
  function accept(next, forceFill = false) {
    if (!next || !next.preferences || !Number.isInteger(next.revision)) return false;
    if (next.revision < maxRevision) return false;
    const oldHash = data ? stable(comparable(data.preferences)) : null;
    maxRevision = next.revision; data = next; known = true;
    if(!current||!Number.isInteger(current.revision)||next.revision>=current.revision) current=next;
    const changedPreferenceRevision=draft&&Number.isInteger(draft.basePreferencesRevision)&&Number.isInteger(next.preferencesRevision)&&draft.basePreferencesRevision!==next.preferencesRevision;
    if (draft && (changedPreferenceRevision || (!busy && oldHash && oldHash !== stable(comparable(next.preferences))))) { invalidatePreview('已保存设置发生变化，请刷新核对后重新预览。'); $('proactive-source-ack').checked=false; pendingRequest=null; }
    if (!dirty || forceFill) fill(next.preferences);
    if (followupDraft) {
      const f=(next.facts||[]).find(f=>f.id===followupDraft.id);
      if (!f || f.revision!==followupDraft.revision) { followupDraft=null; $('followup-preview-area').replaceChildren(); text('followup-feedback','记录已变更，请重新选择并审核这次跟进。'); }
    }
    render(); return true;
  }
  function render() {
    const p=data?.preferences, capable=contractReady();
    form.elements.enabled.disabled = !capable;
    form.elements.dailyGreetingEnabled.disabled = busy || !capable;
    form.elements.dailyGreetingTime.disabled = busy || !capable;
    for (const k of Object.keys(labels)) if(form.elements['category-'+k]) form.elements['category-'+k].disabled=!capable||data?.availableCategories?.[k]===false;
    $('proactive-preview').disabled=busy || !capable || !$('proactive-source-ack').checked;
    $('pause').disabled=busy; $('off').disabled=busy; $('proactive-refresh').disabled=busy;
    for(const button of $('preview').querySelectorAll('button')) button.disabled=busy||!draft||draft.version!==editVersion;
    for(const button of $('followup-preview-area').querySelectorAll('button')) button.disabled=busy||!followupDraft||!$('followup-source-ack')?.checked;
    if (busy) { text('proactive-readiness','正在核对，编辑或提交本身尚不代表生效。'); text('proactive-effective-state','正在核对更改，尚未确认生效…'); text('status','正在核对更改，尚未确认生效…'); }
    else if (!known) { text('proactive-readiness','无法读取最新设置，尚不能确认是否生效。'); text('proactive-effective-state','已保存状态尚未确认'); text('status','暂时无法核对主动消息状态，请刷新后再操作。'); }
    else {
      const active=p.enabled&&!p.paused;
      text('proactive-effective-state',active?'已保存主动联系许可':p.paused?'已暂停主动消息':'尚未允许主动联系');
      const readiness=!capable?'设置尚未准备完整，当前不能保存新增范围。':data.shadowOnly?'自动发送尚未启用，当前不会主动发送。':data.proactiveStatus.deliveryReady!==true?'天气、兴趣和记忆跟进仍在接入，目前不会主动发送。':'发送能力已就绪；仍须同时满足资料、时段、次数与间隔条件。';
      const matterReminders=(data.matters??[]).filter(m=>m.status==='active'&&m.reminders?.some(r=>Date.parse(r.at)>Date.now()));
      text('proactive-readiness',readiness); text('status',matterReminders.length&&!data.shadowOnly?`已保存 ${matterReminders.length} 项事项提醒，按你确认的时间安排。日常主动联系${active?'按设置开启。':'未开启或已暂停。'}`:(active?'主动设置已保存。':'主动消息未开启或已暂停。')+readiness);
    }
    text('proactive-edit-state',dirty?'你正在编辑，尚未保存；右侧显示的是已保存设置。':draft?'请核对预览后，明确点击确认保存。':'这里显示的是已读取的设置；更改需要预览并确认。');
    text('weather-missing',!form.elements.city.value.trim()?'未填写城市，天气资料尚未配置。':!form.elements.latitude.value||!form.elements.longitude.value?'城市已填写，天气坐标仍待确认；不会从设备时区补全。':'请核对城市及坐标来源，再预览设置。');
    renderSources(); renderFacts();
  }
  function renderSources() {
    const target=$('proactive-source-status'); target.replaceChildren();
    if(!data) return;
    const p=data.preferences, sources={...(data.sourceStatus||{}),...(data.proactiveStatus?.sources||{})};
    const daily=document.createElement('article'),dailyTitle=document.createElement('h3'),dailyState=document.createElement('p');dailyTitle.textContent='日常问候';dailyState.textContent=p.dailyGreetingEnabled?(p.enabled&&!p.paused?'已选择；':'已选择，主动消息当前暂停；')+'在允许联系时段内参考聊天活跃时间、上下文和角色近况择机联系，每天最多 '+p.greetingLimit+' 次，不要求发满；忙时顺延，内容过时重新生成。':'尚未选择，不会发送日常问候。';daily.append(dailyTitle,dailyState);target.append(daily);
    const values={weather:!p.city||p.weatherLocation?.city!==p.city?'城市或天气坐标待确认':reason(sources.weather),interest:!p.interests?.length?'还没有选择兴趣主题':reason(sources.interest),memory:data.factMemoryPaused?'记录写入已暂停':(data.facts||[]).some(f=>f.proactive)?reason(data.proactiveStatus?.memory??sources.memory):'还没有另行审核过的一次跟进用途'};
    for(const k of ['weather','interest','memory']) {
      const section=document.createElement('article'), h=document.createElement('h3'), pnode=document.createElement('p');h.textContent=labels[k];
      pnode.textContent=(p.categories?.[k]?'已选择此类关心；':'尚未选择此类关心；')+(data.availableCategories?.[k]===false?'暂不可用，当前不会自动发送':values[k]);section.append(h,pnode);target.append(section);
    }
    if(sources.dispatch) {const pnode=document.createElement('p');pnode.className='proactive-field-note';pnode.textContent=reason(sources.dispatch);target.append(pnode);}
    const notices=(data.proactiveStatus?.candidateReasons||[]).map(item=>labels[item.category]&&reasons[item.reason]?labels[item.category]+'：'+reason(item.reason):'').filter(Boolean);
    for(const value of [...new Set(notices)].slice(0,4)){const pnode=document.createElement('p');pnode.className='domain-footnote';pnode.textContent=value;target.append(pnode);}
    text('proactive-last-check','资料更新：'+showTime(data.proactiveStatus?.lastRefreshAt)+'；条件核对：'+showTime(data.proactiveStatus?.lastCheckAt));
  }
  function renderFacts() {
    const select=followupForm.elements.fact, selected=select.value, facts=(data?.facts||[]).filter(f=>['user-stated','user-correction'].includes(f.sourceKind)&&f.confidence===1&&f.status!=='deleted');
    select.replaceChildren(new Option('请明确选择一条记录',''));
    for(const f of facts) select.append(new Option(f.text,f.id));
    if(facts.some(f=>f.id===selected)) select.value=selected;
    text('followup-availability',!contractReady()?'一次跟进设置尚未准备完整，暂不能保存。':data.factMemoryPaused?'记录写入已暂停，暂不能新增跟进；已有用途仍可撤销。':!facts.length?'暂无可供你审核的已确认记录。请先在“记忆与偏好”中添加或核对。':'请选择本人、非敏感、真实的信息；不会自动挑选，也不会读取聊天记忆。');
    $('followup-preview').disabled=busy||!contractReady()||data.factMemoryPaused||!facts.length;
    const list=$('followup-list');list.replaceChildren();
    for(const f of (data?.facts||[]).filter(f=>f.proactive)) {
      const article=document.createElement('article'), h=document.createElement('h3'), p=document.createElement('p'), button=document.createElement('button');
      h.textContent=f.proactive.label;p.textContent='开始：'+showTime(f.proactive.at)+'；最迟有效至 '+showTime(f.proactive.expiresAt);button.type='button';button.textContent='撤销这次跟进';button.disabled=busy;
      button.addEventListener('click',()=>clearFollowup(f));article.append(h,p,button);list.append(article);
    }
  }
  async function request(body) {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try {
      let response;
      try {const scope=await window.agentHeaders();response=await fetch('/api/me/domain',body?{method:'POST',credentials:'same-origin',headers:{...scope,'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal}:{credentials:'same-origin',headers:scope,signal:controller.signal});}catch{throw Error('连接中断或等待超时，操作结果尚未确认。');}
      let value;try{value=await response.json();}catch{throw Error('返回结果不完整，请刷新核对。');}
      if(!response.ok){const e=Error(window.userMessage(value.detail,response.status,'操作未完成，请刷新核对。'));e.status=response.status;throw e;}return value;
    } finally {clearTimeout(timer);}
  }
  async function reload(forceFill=false) {
    const token=++serial;busy=true;render();
    try{const value=await request();if(token!==serial)return;if(!accept(value,forceFill))throw Error('未取得最新的完整状态，请稍后刷新。');}
    catch(e){if(token!==serial)return;known=false;text('proactive-feedback',e.message);}
    finally{if(token===serial){busy=false;render();}}
  }
  function collectPreferences() {
    const f=form.elements;for(const k of ['weather','interest'])if(data?.availableCategories?.[k]===false&&f['category-'+k].checked)throw Error('天气与AI自动资讯暂不可用，不能开启自动发送。');const city=f.city.value.trim()||null, interests=f.interests.value.split(/\n+/).map(x=>x.trim()).filter(Boolean);
    const limit=Number(f.greetingLimit.value),cooldown=Number(f.cooldownMinutes.value);
    if(!Number.isInteger(limit)||limit<0||limit>5)throw Error('每天共享上限只能为 0–5 次。');
    if(!Number.isInteger(cooldown)||cooldown<60||cooldown>10080)throw Error('两次问候至少间隔 60 分钟，可进一步延长。');
    if(interests.length>20||interests.some(x=>x.length>40))throw Error('兴趣最多 20 个，每个最多 40 字。');
    const lat=f.latitude.value.trim(),lon=f.longitude.value.trim();let weatherLocation=null;
    if(lat||lon){if(!city||!lat||!lon)throw Error('请同时填写城市、纬度和经度，或先保留为待配置。');const latitude=Number(lat),longitude=Number(lon);if(!Number.isFinite(latitude)||Math.abs(latitude)>90||!Number.isFinite(longitude)||Math.abs(longitude)>180)throw Error('请核对有效的纬度和经度范围。');const old=data.preferences.weatherLocation;const unchanged=old&&city===old.city&&latitude===old.latitude&&longitude===old.longitude;if(!unchanged&&!$('weather-location-ack').checked)throw Error('请先明确核对这个城市及坐标。');weatherLocation={city,latitude,longitude,source:unchanged?old.source:'user-selected'};}
    return {enabled:f.enabled.checked,paused:!f.enabled.checked,timezone:f.timezone.value.trim(),quietStart:f.quietStart.value,quietEnd:f.quietEnd.value,greetingLimit:limit,cooldownMinutes:cooldown,dailyGreetingEnabled:f.dailyGreetingEnabled.checked,dailyGreetingTime:f.dailyGreetingTime.value,city,weatherLocation,interests,categories:Object.fromEntries(Object.keys(labels).map(k=>[k,f['category-'+k].checked]))};
  }
  function reusable(kind,key,makeBody) {
    if(pendingRequest?.kind===kind&&pendingRequest.key===key)return pendingRequest.body;
    const body=makeBody();pendingRequest={kind,key,body};return body;
  }
  function appendSummary(target,values) {const list=document.createElement('dl');for(const [label,value] of values){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;list.append(dt,dd);}target.append(list);}
  async function propose(event) {
    event.preventDefault();if(busy||!contractReady()||!$('proactive-source-ack').checked)return;
    let value;try{value=collectPreferences();}catch(e){text('proactive-feedback',e.message);return;}
    const version=editVersion,baseHash=stable(comparable(data.preferences)),key=stable(value),body=reusable('propose',key,()=>({action:'preferences.propose',id:uuid(),requestId:uuid(),value}));
    const token=++serial;busy=true;render();text('proactive-feedback','');
    try{
      const result=await request(body);if(token!==serial)return;
      if(version!==editVersion){invalidatePreview('输入已改变，这份预览已作废。请重新预览。');return;}
      if(!result.preferences||!Number.isInteger(result.confirmationRevision)||typeof result.confirmationNonce!=='string')throw Error('确认信息尚未完整，未保存更改。请刷新后重试。');
      draft={id:body.id,expectedRevision:result.confirmationRevision,nonce:result.confirmationNonce,preferences:result.preferences,version,baseHash,basePreferencesRevision:data.preferencesRevision,requestId:uuid()};pendingRequest=null;
      const area=$('preview');area.replaceChildren();const h=document.createElement('h3');h.textContent='请核对来源和联系范围';area.append(h);
      const p=result.preferences;appendSummary(area,[['主动联系',p.enabled&&!p.paused?'允许所选范围':'暂停或关闭'],['日常问候',p.dailyGreetingEnabled?'允许联系时段内弹性联系，参考聊天习惯与近况；偏好参考时间 '+p.dailyGreetingTime+'，忙时顺延':'未开启'],['其他类别',Object.keys(labels).filter(k=>p.categories?.[k]).map(k=>labels[k]).join('、')||'全部关闭'],['共享上限',p.greetingLimit+' 次/天，至少间隔 '+p.cooldownMinutes+' 分钟'],['发送时段','北京时间 09:00–24:00 内，并避开 '+p.quietStart+'–'+p.quietEnd+'（'+p.timezone+'）'],['天气城市',p.city||'未配置'],['天气位置来源',p.weatherLocation?(p.weatherLocation.source==='approved-geocode'?'已审核城市资料':'本人明确选择')+'；'+p.weatherLocation.latitude+'，'+p.weatherLocation.longitude:'坐标尚未确认，天气资料待配置'],['兴趣',p.interests?.join('、')||'未选择']]);
      const note=document.createElement('p');note.textContent='保存后仍须符合连接、最近互动、时段和次数限制；其他类别还需相应资料或用途。日常问候和计划回访结合最近私聊和角色近况生成，计入当月 Token 额度；不会同时开启个人事实记忆。';area.append(note);
      const confirm=document.createElement('button');confirm.type='button';confirm.className='primary';confirm.textContent='确认保存这些设置';confirm.addEventListener('click',confirmPreferences);area.append(confirm);text('proactive-edit-state','请核对服务器返回的预览后，再明确确认保存。');
    }catch(e){if(token!==serial)return;text('proactive-feedback','预览未确认。'+e.message);}
    finally{if(token===serial){busy=false;render();}}
  }
  async function confirmPreferences() {
    if(busy||!draft)return;
    if(draft.version!==editVersion||draft.baseHash!==stable(comparable(data.preferences))){invalidatePreview('设置或输入已变化，请重新核对来源并预览。');$('proactive-source-ack').checked=false;return;}
    const expected=draft,body={action:'preferences.confirm',id:draft.id,expectedRevision:draft.expectedRevision,requestId:draft.requestId};const token=++serial;busy=true;render();
    try{await request(body);if(token!==serial)return;const latest=await request();if(token!==serial)return;if(!accept(latest,false))throw Error('返回状态已过期，请刷新核对。');
      if(stable(comparable(latest.preferences))!==stable(comparable(expected.preferences)))throw Error('已提交，但尚未核对到这些设置。请刷新确认实际状态。');
      dirty=false;draft=null;pendingRequest=null;$('preview').replaceChildren();fill(latest.preferences);text('proactive-feedback','已核对设置已保存。'+(latest.proactiveStatus?.deliveryReady===true&&!latest.shadowOnly?'发送仍须满足全部条件。':'天气、兴趣和记忆跟进仍在接入，目前不会主动发送。'));
    }catch(e){if(token!==serial)return;if(e.status===409){draft=null;pendingRequest=null;$('preview').replaceChildren();$('proactive-source-ack').checked=false;}
      text('proactive-feedback','保存尚未确认。'+e.message+' 请刷新核对；不会自动重新提交。');try{accept(await request(),false);}catch{known=false;}}
    finally{if(token===serial){busy=false;render();}}
  }
  async function stop(action) {
    if(busy)return;const body=reusable(action,action,()=>({action,requestId:uuid()}));const token=++serial;busy=true;draft=null;$('preview').replaceChildren();$('proactive-source-ack').checked=false;render();
    try{await request(body);if(token!==serial)return;const latest=await request();if(token!==serial)return;if(!accept(latest,true))throw Error('返回状态已过期，请刷新核对。');
      if(action==='preferences.pause'?!latest.preferences.paused:latest.preferences.enabled||!latest.preferences.paused)throw Error('尚未核对到停止状态。');
      pendingRequest=null;text('proactive-feedback',action==='preferences.pause'?'已核对主动消息已暂停。':'已核对主动消息已关闭。');
    }catch(e){if(token!==serial)return;text('proactive-feedback','停止尚未确认。'+e.message+' 请刷新核对。');try{accept(await request(),false);}catch{known=false;}}
    finally{if(token===serial){busy=false;render();}}
  }
  function previewFollowup(event) {
    event.preventDefault();if(busy||!contractReady()||data.factMemoryPaused)return;
    const f=(data.facts||[]).find(f=>f.id===followupForm.elements.fact.value);if(!f){text('followup-feedback','请明确选择一条已确认记录。');return;}
    const label=followupForm.elements.label.value.trim();if(!label||label.length>40){text('followup-feedback','请核对不超过 40 字的非敏感用途。');return;}
    let at;try{at=zonedIso(followupForm.elements.at.value,'Asia/Shanghai');if(!at)throw Error('请填写时间。');}catch(e){text('followup-feedback',e.message);return;}
    followupDraft={id:f.id,revision:f.revision,label,at,requestId:uuid()};const area=$('followup-preview-area');area.replaceChildren();const h=document.createElement('h3');h.textContent='只审核这一次跟进';area.append(h);
    appendSummary(area,[['记录',f.text],['用途',label],['开始时间',showTime(at)],['有效期','所选时间起 6 小时内；过时不补发']]);
    const ackLabel=document.createElement('label'),ack=document.createElement('input');ack.type='checkbox';ack.id='followup-source-ack';ackLabel.className='proactive-check';ackLabel.append(ack,document.createTextNode('我已核对这是本人、非敏感、真实资料，并明确同意仅用于这一次主动跟进。'));
    const button=document.createElement('button');button.type='button';button.className='primary';button.textContent='确认保存这次跟进';button.disabled=true;ack.addEventListener('change',()=>{button.disabled=!ack.checked||busy;});button.addEventListener('click',saveFollowup);area.append(ackLabel,button);
  }
  async function saveFollowup() {
    if(busy||!followupDraft||!$('followup-source-ack')?.checked)return;const d=followupDraft,f=(data.facts||[]).find(f=>f.id===d.id);
    if(!f||f.revision!==d.revision){followupDraft=null;$('followup-preview-area').replaceChildren();text('followup-feedback','记录已变更，请重新审核用途。');return;}
    await mutateFollowup({action:'fact.followup.set',id:d.id,expectedRevision:d.revision,requestId:d.requestId,value:{label:d.label,at:d.at}},d);
  }
  async function clearFollowup(f) {if(busy)return;const body=reusable('followup-clear',f.id+':'+f.revision,()=>({action:'fact.followup.clear',id:f.id,expectedRevision:f.revision,requestId:uuid()}));await mutateFollowup(body,null);}
  async function mutateFollowup(body,expected) {
    const token=++serial;busy=true;render();
    try{await request(body);if(token!==serial)return;const latest=await request();if(token!==serial)return;if(!accept(latest,false))throw Error('返回状态已过期，请刷新核对。');const f=(latest.facts||[]).find(f=>f.id===body.id);
      const matches=expected?f?.proactive?.label===expected.label&&new Date(f.proactive.at).getTime()===new Date(expected.at).getTime():!!f&&!f.proactive;
      if(!matches)throw Error('尚未核对到预期用途状态，请刷新查看。');
      followupDraft=null;pendingRequest=null;$('followup-preview-area').replaceChildren();text('followup-feedback',expected?'已核对这次用途已保存；是否发送仍取决于已保存许可和发送状态。':'已核对这次跟进用途已撤销。');await refresh();
    }catch(e){if(token!==serial)return;if(e.status===409){followupDraft=null;$('followup-preview-area').replaceChildren();pendingRequest=null;}
      text('followup-feedback','操作尚未确认。'+e.message+' 请刷新核对；不会自动重试。');try{accept(await request(),false);}catch{known=false;}}
    finally{if(token===serial){busy=false;render();}}
  }
  form.addEventListener('input',event=>{if(event.target!==$('proactive-source-ack'))$('proactive-source-ack').checked=false;dirty=true;editVersion++;invalidatePreview();if(event.target===form.elements.city){form.elements.latitude.value='';form.elements.longitude.value='';$('weather-location-ack').checked=false;}render();});
  form.addEventListener('change',event=>{if(event.target!==$('proactive-source-ack'))$('proactive-source-ack').checked=false;dirty=true;editVersion++;invalidatePreview();render();});
  followupForm.addEventListener('input',()=>{followupDraft=null;$('followup-preview-area').replaceChildren();});
  form.addEventListener('submit',propose); followupForm.addEventListener('submit',previewFollowup);
  $('pause').addEventListener('click',()=>stop('preferences.pause'));$('off').addEventListener('click',()=>stop('preferences.disable'));$('proactive-refresh').addEventListener('click',()=>reload(false));
  document.addEventListener('domain-refreshed',event=>accept(event.detail,false));
  if(typeof current==='object'&&current)accept(current,true);
  reload(true);
})();
