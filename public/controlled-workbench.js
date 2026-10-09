import { createControllerClient } from './controller-client.js';
import { createCallLifecycle, createDeviceMediaOwner, microphoneMessages } from './call-lifecycle.js';
import { createConversationModel } from './conversation-model.js';
import { createConversationView, renderConversationUtterance } from './conversation-view.js';
import { createMicrophoneInput } from './microphone-input.js';
import { createAudioOutput } from './audio-output.js';

// Loaded only by the server's explicit /controlled surface. The default local
// workbench does not use session cookies, controller leases or this SDK owner.
export async function startControlledWorkbench() {
  const $ = id => document.getElementById(id);
  let client;
  let disposed = false;
  let view = 'workspace';
  let eventSource = null;
  let eventRetry = null;
  let eventRetries = 0;
  let device = null;
  let sdkCall = null;
  let sdkCallId = null;
  let sdkAccepted = false;
  let joinDeadline = null;
  let muted = false;
  let model = null;
  let record = null;
  let canonicalConversation = false;
  let captionState = null;
  let localError = '';
  const history = [];
  const terminal = status => ['completed', 'failed', 'canceled', 'busy', 'no-answer', 'rejected'].includes(status);
  const statusNames = { connecting: '正在连接', ringing: '等待对方接听', active: '通话中', ending: '线路清理中', completed: '通话已结束', failed: '通话未完成' };
  const phaseNames = {
    loading: '正在检查登录与状态',
    booting: '正在检查登录与状态', acquiring: '正在取得控制权', renewing: '正在续约控制权',
    preparing: '正在准备通话', microphone: '正在准备麦克风', creating: '正在准备电话许可',
    voice: '正在准备 Voice 加入许可', connecting: '正在连接浏览器电话', ending: '正在确认线路清理',
    releasing: '正在释放控制权', cleanup: '正在确认线路清理',
  };
  const conversation = createConversationView({
    container: $('transcript'), scrollContainer: $('transcript-scroll'), emptyNode: $('empty-conversation'),
    latestButton: $('conversation-latest'), historyStatus: $('conversation-history-status'),
  });
  const lifecycle = createCallLifecycle({
    requestMedia: navigator.mediaDevices?.getUserMedia ? constraints => navigator.mediaDevices.getUserMedia(constraints) : null,
    onChange: attempt => {
      $('microphone-actual').textContent = attempt?.microphoneReady
        ? `当前采音：${attempt.microphoneName || '浏览器未提供设备名称'}` : '麦克风未启用。';
      $('call-hint').textContent = attempt?.microphoneReady ? muted ? '麦克风已静音' : '麦克风已启用' : '麦克风未启用';
    },
  });
  const microphone = createMicrophoneInput({ mediaDevices: navigator.mediaDevices, onChange: snapshot => {
    const selected = snapshot.selectedId;
    const options = [new Option('系统默认麦克风', '')];
    for (const entry of snapshot.devices) {
      const option = new Option(entry.label, entry.deviceId); option.disabled = !entry.available; options.push(option);
    }
    $('microphone-input').replaceChildren(...options); $('microphone-input').value = selected;
    $('microphone-input-status').textContent = snapshot.message;
    $('refresh-microphones').disabled = snapshot.status !== 'idle' || Boolean(sdkCall);
  } });
  const output = createAudioOutput({ onChange: snapshot => {
    const options = snapshot.devices.length ? snapshot.devices.map(entry => new Option(entry.label, entry.deviceId)) : [new Option('系统默认输出', 'default')];
    $('audio-output').replaceChildren(...options);
    $('audio-output').value = snapshot.selectedId || 'default';
    $('audio-output').disabled = !snapshot.supported || snapshot.status !== 'idle' || !device;
    $('test-audio-output').disabled = !device || snapshot.status !== 'idle';
    $('audio-output-status').textContent = snapshot.message;
  } });

  function text(id, value) { if ($(id)) $(id).textContent = value; }
  function note(message) { localError = message || ''; render(client?.state); }
  function clearMedia() {
    clearTimeout(joinDeadline); joinDeadline = null;
    const oldCall = sdkCall; const oldDevice = device;
    sdkCall = null; device = null; sdkCallId = null; sdkAccepted = false; muted = false;
    lifecycle.cancel(); output.bind(null);
    try { oldCall?.disconnect(); } catch { /* Every stale call is retired. */ }
    try { oldDevice?.destroy(); } catch { /* Server cleanup remains authoritative. */ }
    $('mute-button').setAttribute('aria-pressed', 'false');
    $('mute-button').querySelector('span').textContent = '静音';
    text('browser-playback', '浏览器电话未连接；字幕不代表译音已播放。');
  }

  function render(snapshot) {
    if (!snapshot || disposed) return;
    document.documentElement.dataset.controllerPhase = snapshot.phase;
    const pending = Boolean(phaseNames[snapshot.phase]);
    const lease = snapshot.lease;
    // Server deadlines and the client generation fence retire a pending SDK or
    // microphone owner. A status reconnect alone never revives that owner.
    if ((!lease || snapshot.cleanupPending || terminal(snapshot.call?.status)) && (device || lifecycle.current)) clearMedia();
    const call = snapshot.call;
    const live = Boolean(call && !terminal(call.status));
    $('enable-device').disabled = pending || (!lease && !snapshot.canAcquire);
    text('enable-device', lease ? live ? '结束并释放控制' : '释放控制权' : '取得本页控制权');
    $('keep-online-toggle').disabled = $('enable-device').disabled;
    $('keep-online-toggle').classList.toggle('on', Boolean(lease));
    $('keep-online-toggle').setAttribute('aria-checked', String(Boolean(lease)));
    $('renew-control').disabled = !snapshot.canRenew;
    $('start-call').disabled = !snapshot.canStart || live || pending || snapshot.cleanupPending || output.snapshot.status !== 'idle';
    $('phone-number').disabled = live || pending;
    $('erase-number').disabled = $('phone-number').disabled;
    for (const key of document.querySelectorAll('.dial-key')) key.disabled = $('phone-number').disabled;
    $('microphone-input').disabled = live || pending;
    $('end-call').disabled = !snapshot.canHangup && !lifecycle.current;
    text('end-call-label', snapshot.cleanupPending ? '重试确认挂断' : pending && !live ? '取消准备' : '结束通话');
    $('mute-button').disabled = !snapshot.canMute || !sdkAccepted || !sdkCall;
    const failure = localError || snapshot.error?.message || '';
    text('app-error', failure); $('app-error').hidden = !failure;
    text('local-state', snapshot.connection === 'connected' ? '会话状态已连接' : '状态连接中断');
    const readonly = !lease;
    const controlText = !snapshot.authenticated ? '尚未登录，无法取得控制权'
      : snapshot.cleanupPending ? '线路清理待确认，暂不能开始下一通'
        : readonly ? snapshot.controller?.mode === 'held' ? '只读标签页 · 控制权在其他页面' : '只读标签页 · 点击取得本页控制权'
          : snapshot.renewPaused ? '控制权仍在期限内 · 请显式续约恢复续租' : '本页持有控制权';
    text('device-state', phaseNames[snapshot.phase] || controlText);
    $('device-dot').classList.toggle('online', Boolean(lease));
    document.querySelector('.availability').classList.toggle('ready', Boolean(lease));
    text('readiness-title', phaseNames[snapshot.phase] || controlText);
    text('readiness-copy', snapshot.cleanupPending ? '两腿线路结束尚未确认；退出或刷新不能证明已挂断。'
      : !snapshot.authenticated ? '需要已验证的登录会话。此页面不提供或猜测登录方式。'
        : snapshot.connection !== 'connected' ? '状态中断会暂停续租；重连只读状态，不会延长控制权。'
          : snapshot.busy && !live && !pending ? '服务仍在确认准备或清理状态，暂不能开始下一通。请刷新状态。'
          : lease ? `${Math.max(0, Math.ceil((lease.expiresAt - Date.now()) / 1000))} 秒内有效。页面可见且状态连接时按租约续租；返回页面后须显式续约。`
            : '同一会话的其他标签页可以阅读状态。活动电话或清理待确认时不能接管。');
    let connectionText = call ? statusNames[call.status] || '等待电话状态确认' : '等待开始';
    if (call?.status === 'active' && (!sdkAccepted || sdkCallId !== call.id)) connectionText = '服务器通话已开始 · 本页音频未确认连接';
    else if (call?.status === 'active' && !call.translationReady) connectionText = '电话已接通 · 译音线路准备中';
    if (sdkAccepted && call?.status !== 'active') connectionText = '浏览器音频已连接 · 等待对方接听';
    if (snapshot.cleanupPending) connectionText = '线路关闭待确认';
    text('connection-text', connectionText);
    text('connection-mode-label', 'Pocket Michael 英文译音 · 英文原声回程');
    text('bridge-caption', call?.status === 'active' && sdkAccepted && call.translationReady ? '译音线路已就绪 · 请按字幕辅助交流' : '等待电话接通与译音线路就绪');
    text('return-audio-label', 'English 原声 + 中文字幕');
    $('connection-status').classList.toggle('active', call?.status === 'active' && sdkAccepted);
    text('caption-status', captionState?.state === 'failed' ? '中文字幕暂不可用；英文原声走独立线路。' : captionState?.state === 'ready' ? '中文字幕旁路已就绪。' : '英文原声独立传送；字幕就绪情况按服务事件显示。');
    $('caption-status').hidden = !call;
    applySession(call, snapshot);
  }

  function applySession(call, snapshot) {
    if (call && record?.id !== call.id) {
      if (record && !history.some(entry => entry.id === record.id)) history.unshift(record);
      if (history.length > 30) history.length = 30;
      record = { id: call.id, number: call.to || call.from || '', status: call.status, startedAt: Date.now(), model: createConversationModel(call.id) };
      model = record.model; canonicalConversation = false; captionState = null; conversation.reset();
      renderHistory();
    }
    if (call && record?.id === call.id) record.status = call.status;
    if (record && (terminal(record.status) || (!call && !snapshot.busy && !snapshot.cleanupPending))) {
      record.endedAt ||= Date.now();
      if (!terminal(record.status)) record.status = 'completed';
    }
    text('transcript-subtitle', record ? `${record.number} · ${statusNames[record.status] || '通话状态待确认'} · 文字仅辅助理解` : '直接听对方英文原声，中文字幕帮助理解');
  }
  function renderConversation() {
    const change = model?.getLastChange();
    if (!change || change.orderChanged || !conversation.update(model.getUtterance(change.id))) conversation.render(model?.getUtterances() || []);
    $('export-current').disabled = conversation.count === 0;
  }
  function receiveConversation(kind, value) {
    if (!record || value?.sessionId !== record.id || !model) return;
    if (kind === 'conversation') {
      if (!model.apply(value)) return;
      canonicalConversation = true;
    } else if (canonicalConversation || !model.applyTranscript(value)) return;
    renderConversation();
  }
  function renderHistory() {
    const list = $('history-list'); const entries = [...(record ? [record] : []), ...history].filter((entry, index, all) => all.findIndex(item => item.id === entry.id) === index);
    text('history-count', String(entries.length)); list.replaceChildren();
    if (!entries.length) { text('history-list', '此页面尚未收到通话记录。'); text('history-detail', '记录仅保留在当前页面内存；刷新后不会恢复。'); return; }
    for (const entry of entries) {
      const button = document.createElement('button'); button.className = 'secondary-button full-width';
      button.textContent = `${entry.number || '通话'} · ${statusNames[entry.status] || '状态待确认'}`;
      button.addEventListener('click', () => {
        const detail = $('history-detail'); detail.replaceChildren();
        for (const utterance of entry.model.getUtterances()) detail.append(renderConversationUtterance(utterance));
        if (!entry.model.getUtterances().length) detail.textContent = '尚未收到该通话的字幕。';
      }); list.append(button);
    }
  }

  function stopEvents() { clearTimeout(eventRetry); eventRetry = null; eventSource?.close(); eventSource = null; }
  function connectEvents() {
    if (disposed || eventSource || eventRetry || !client.state.authenticated) return;
    const source = new EventSource('/api/events'); eventSource = source;
    const current = () => !disposed && eventSource === source;
    source.onopen = () => { if (!current()) return; eventRetries = 0; client.setConnectionState(true); client.refresh().catch(() => {}); };
    for (const kind of ['snapshot', 'call', 'conversation', 'transcript', 'caption-status', 'error']) source.addEventListener(kind, event => {
      if (!current() || !event.data) return;
      let value;
      try { value = JSON.parse(event.data); } catch { note('状态数据无法读取，请刷新状态；尚未确认线路已结束。'); return; }
      if (kind === 'snapshot' || kind === 'call') { client.handleEvent(kind, value); renderHistory(); }
      else if (kind === 'conversation' || kind === 'transcript') receiveConversation(kind, value);
      else if (kind === 'caption-status' && value?.sessionId === record?.id) { captionState = value; render(client.state); }
      else if (kind === 'error') { client.handleEvent(kind, value); }
    });
    source.onerror = event => {
      if (!current()) return;
      // A named application `event: error` is still a healthy SSE transport.
      if (typeof event?.data === 'string') return;
      client.setConnectionState(false);
      // Native EventSource reconnect only restores reads. It never acquires or
      // renews a lease and cannot restore an old Voice join capability.
      if (source.readyState !== EventSource.CLOSED) return;
      source.close(); eventSource = null;
      const delay = [1000, 3000, 10000][eventRetries++];
      if (delay === undefined) { note('状态连接未恢复。请刷新状态；重连后仍须显式续约控制权。'); return; }
      eventRetry = setTimeout(() => { eventRetry = null; connectEvents(); }, delay);
    };
  }

  async function startCall() {
    if ($('start-call').disabled || disposed) return;
    const to = $('phone-number').value.replace(/[\s()-]/g, '');
    if (!/^\+1\d{10}$/.test(to)) { text('phone-error', '请输入 +1 加十位美国号码。'); $('phone-number').setAttribute('aria-invalid', 'true'); return; }
    text('phone-error', ''); $('phone-number').removeAttribute('aria-invalid'); localError = '';
    let attempt = null;
    await client.startCall(to, {
      prepareMedia: async ({ isCurrent }) => {
        clearMedia(); attempt = lifecycle.begin();
        const constraints = await microphone.constraints();
        if (!isCurrent() || !lifecycle.isCurrent(attempt)) throw Object.assign(new Error('本次准备已取消。'), { code: 'CALL_CANCELLED' });
        await lifecycle.prepareMicrophone(attempt, constraints);
        if (!isCurrent() || !lifecycle.isCurrent(attempt)) { lifecycle.cancel(attempt); throw Object.assign(new Error('本次准备已取消。'), { code: 'CALL_CANCELLED' }); }
      },
      connectVoice: async (prepared, { isCurrent, callId }) => {
        if (!isCurrent() || !lifecycle.isCurrent(attempt)) return null;
        if (!window.Twilio?.Device) throw Object.assign(new Error('电话组件尚未加载。'), { code: 'VOICE_SDK_UNAVAILABLE' });
        lifecycle.update(attempt, { sessionId: callId });
        const mediaOwner = createDeviceMediaOwner(lifecycle);
        const next = new window.Twilio.Device(prepared.token, {
          logLevel: 'silent', closeProtection: true, enableImprovedSignalingErrorPrecision: true,
          maxCallSignalingTimeoutMs: 30000, getUserMedia: constraints => mediaOwner.getUserMedia(constraints),
        });
        device = next; attempt.device = next; attempt.mediaOwner = mediaOwner;
        const owns = () => isCurrent() && lifecycle.isCurrent(attempt) && device === next && !disposed;
        // Existing media can fail while this page is hidden or SSE is offline.
        // Cleanup still belongs to this exact SDK owner; only new admission and
        // success events need visibility and a live status connection.
        const ownsMedia = () => lifecycle.isCurrent(attempt) && device === next && !disposed;
        next.on?.('error', () => { if (ownsMedia()) { note('浏览器电话连接失败；正在确认线路清理。'); clearMedia(); client.cancel().catch(() => {}); } });
        next.on?.('incoming', incoming => { try { incoming.reject(); } catch { /* Incoming permission is disabled. */ } });
        const expireJoin = () => {
          if (ownsMedia() && !sdkAccepted && Date.now() >= prepared.grant.expiresAt) {
            note('浏览器连接许可已到期，本次连接准备已取消。'); clearMedia(); client.cancel().catch(() => {});
          }
        };
        joinDeadline = setTimeout(expireJoin, Math.max(1, prepared.grant.expiresAt - Date.now()));
        next.on?.('tokenWillExpire', () => {
          // The short token authorizes one join. Once joined, this call is
          // governed by its current controller/budget, not the first ticket's
          // deadline. Do not sign or refresh another token from this event.
          expireJoin();
        });
        output.bind(next.audio || null);
        const call = await mediaOwner.connect(attempt, () => next.connect({ params: prepared.params }));
        if (!call || !owns()) { try { call?.disconnect(); } catch { /* Late results are never usable. */ } try { next.destroy(); } catch { /* Independent server cleanup continues. */ } return null; }
        sdkCall = call; sdkCallId = callId; sdkAccepted = false; muted = false;
        call.on?.('accept', () => { if (owns() && sdkCall === call) { sdkAccepted = true; clearTimeout(joinDeadline); joinDeadline = null; text('browser-playback', '浏览器音频连接已建立；译音实际播放以线路确认和耳听为准。'); client.markVoiceAccepted(callId); } });
        const disconnected = () => {
          if (!ownsMedia() || sdkCall !== call) return;
          clearMedia(); client.handleVoiceDisconnected(callId); render(client.state);
        };
        call.on?.('disconnect', disconnected); call.on?.('cancel', disconnected);
        call.on?.('error', () => { if (ownsMedia() && sdkCall === call) { note('浏览器电话中断；线路结束尚待确认。'); disconnected(); } });
        render(client.state); return call;
      },
    }).catch(() => note(microphoneMessages[attempt?.failureCode] || client.state.error?.message || '准备通话失败，线路结束尚待确认。'));
    if (!client.state.call || terminal(client.state.call.status) || client.state.cleanupPending || !client.state.lease) clearMedia();
    render(client.state);
  }

  async function release() {
    if (disposed) return;
    localError = '';
    const ownsControl = Boolean(client.state.lease || lifecycle.current || client.state.phase === 'acquiring');
    clearMedia();
    if (ownsControl) await client.cancel().catch(() => {});
    render(client.state);
  }
  function navigate(next) {
    if (!['workspace', 'history', 'settings'].includes(next)) return;
    if (view === 'workspace' && next !== view) release();
    view = next;
    for (const name of ['workspace', 'history', 'settings']) $(`${name}-view`).hidden = name !== next;
    for (const button of document.querySelectorAll('[data-view]')) {
      button.classList.toggle('active', button.dataset.view === next);
      if (button.dataset.view === next) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    }
    text('page-crumb', next === 'workspace' ? '通话工作台' : next === 'history' ? '当前页通话记录' : '接入说明');
    renderHistory();
  }

  // Reuse the actual workbench layout while replacing local-only explanations.
  document.querySelector('.preview-pill').textContent = 'CONTROLLED · 受控接入';
  document.querySelector('.preference-row h3').textContent = '保持本页控制权';
  document.querySelector('.preference-row p').textContent = '可见且状态连接时续租；其他标签只读。退出工作台会结束并释放控制。';
  const renew = document.createElement('button'); renew.id = 'renew-control'; renew.className = 'secondary-button'; renew.textContent = '续约控制权'; renew.disabled = true;
  $('enable-device').before(renew);
  const refresh = document.querySelector('.preview-notice .text-button'); refresh.removeAttribute('data-navigate'); refresh.id = 'refresh-controlled-state'; refresh.textContent = '刷新状态';
  const engine = $('translation-engine'); engine.replaceChildren(new Option('Pocket Michael 边讲边播', 'pocket-prefix')); engine.disabled = true;
  text('translation-engine-help', '中文按可靠小节译成英文，由固定 Michael 声音输出。对方英文原声直达，中文字幕独立更新。');
  text('translation-engine-status', '受控接入使用 Pocket-prefix；不切换为双向合成或本人声线。');
  text('transcript-engine-note', '每句原文与译文配对；临时文字、译音待播放与线路确认播放分别标明。');
  text('audio-delivery-remote', '英文原声 → 电脑：与中文字幕独立传送');
  text('translation-timing-remote', '中文字幕生成计时不代表英文原声播放延迟。');
  document.querySelector('.dial-footnote').textContent = '取得本页控制权后拨号。连接和线路结束以确认状态为准。';
  document.querySelector('.workspace-footer span:last-child').textContent = '保持本页与线路连接 · 关闭或刷新会失去控制权';
  const empty = $('empty-conversation'); empty.querySelector('p').textContent = '取得本页控制权，再输入号码拨打。\n这里只显示服务端实际收到的字幕。';
  $('incoming-banner').hidden = true; $('accept-call').disabled = true; $('reject-call').disabled = true;
  $('history-view').querySelector('.page-heading p').textContent = '只保留当前页面收到的文字；不写入浏览器存储，刷新后不会恢复。';
  text('clear-history', '清空过去记录');
  $('settings-view').querySelector('.page-heading h1').textContent = '准备受控电话接入。';
  $('settings-view').querySelector('.page-heading p').textContent = '登录与持久存储方案尚待决定，此页面不编辑凭据或创建新权限。';
  $('settings-view').querySelector('.settings-grid').hidden = true;
  document.querySelector('[data-view="settings"]').lastChild.textContent = '接入说明';
  $('help-dialog').querySelector('h2').textContent = '先取得控制权，再开始通话。';
  const help = $('help-dialog').querySelector('ol'); help.replaceChildren();
  for (const message of ['通过已验证会话打开此入口。取得本页控制权后，其他标签页保持只读。', '拨号时才请求麦克风。请等待电话接通与译音线路就绪后开始交流。', '结束通话后等待线路清理确认。导航、退出或刷新会撤销控制，不能证明线路已结束。']) { const item = document.createElement('li'); item.textContent = message; help.append(item); }
  $('help-dialog').querySelector('.dialog-note').textContent = '目前正在验证网页控制流程；真实电话接入、声音与听到译音的等待仍须另行验收。';
  for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => navigate(button.dataset.view));
  for (const button of document.querySelectorAll('[data-navigate]')) button.addEventListener('click', () => navigate(button.dataset.navigate));
  document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); navigate('workspace'); });
  for (const symbol of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#']) {
    const button = document.createElement('button'); button.className = 'dial-key'; button.textContent = symbol;
    button.addEventListener('click', () => { if (!$('phone-number').disabled && $('phone-number').value.length < 24) $('phone-number').value += symbol; }); document.querySelector('.keypad').append(button);
  }
  $('erase-number').addEventListener('click', () => { if (!$('erase-number').disabled) $('phone-number').value = $('phone-number').value.slice(0, -1); });
  const control = async () => {
    if ($('enable-device').disabled) return;
    localError = '';
    if (client.state.lease) await release(); else await client.acquire().catch(() => {});
    render(client.state);
  };
  $('enable-device').addEventListener('click', control); $('keep-online-toggle').addEventListener('click', control);
  renew.addEventListener('click', () => { if (!renew.disabled) { localError = ''; client.renew().catch(() => {}); } });
  const refreshState = () => {
    localError = ''; eventRetries = 0; stopEvents(); client.setConnectionState(false);
    client.refresh().then(() => connectEvents()).catch(() => {});
  };
  refresh.addEventListener('click', refreshState); $('refresh-status').addEventListener('click', refreshState);
  $('start-call').addEventListener('click', startCall);
  $('end-call').addEventListener('click', () => { if (!$('end-call').disabled) { localError = ''; clearMedia(); client.cancel({ releaseControl: false }).catch(() => {}); } });
  $('mute-button').addEventListener('click', () => {
    if ($('mute-button').disabled || !sdkCall) return;
    try { const next = !muted; sdkCall.mute(next); muted = next; $('mute-button').setAttribute('aria-pressed', String(muted)); $('mute-button').querySelector('span').textContent = muted ? '取消静音' : '静音'; text('call-hint', muted ? '麦克风已静音' : '麦克风已启用'); }
    catch { note('静音状态未能确认，请检查浏览器电话连接。'); }
  });
  $('refresh-microphones').addEventListener('click', () => microphone.refresh());
  $('microphone-input').addEventListener('change', () => microphone.select($('microphone-input').value));
  $('audio-output').addEventListener('change', () => output.select($('audio-output').value));
  $('test-audio-output').addEventListener('click', () => output.test());
  $('export-current').addEventListener('click', () => {
    const lines = model?.getUtterances().map(item => `${item.role === 'local' ? '你' : '对方'}\n原文：${item.original?.text || '待更新'}\n译文：${item.translation?.text || '待更新'}`) || [];
    if (!lines.length) return;
    const url = URL.createObjectURL(new Blob([lines.join('\n\n')], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'conversation.txt'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('clear-history').addEventListener('click', () => { history.length = 0; $('history-detail').replaceChildren(); renderHistory(); });
  $('help-button').addEventListener('click', () => $('help-dialog').showModal());
  $('close-help').addEventListener('click', () => $('help-dialog').close());
  $('help-start').addEventListener('click', () => { $('help-dialog').close(); navigate('workspace'); });
  document.addEventListener('visibilitychange', () => { client.setVisible(!document.hidden); if (!document.hidden) client.refresh().catch(() => {}); });
  window.addEventListener('offline', () => client.setConnectionState(false));
  window.addEventListener('pagehide', () => {
    if (disposed) return;
    disposed = true; stopEvents(); clearInterval(clock); clearMedia(); microphone.dispose(); conversation.dispose();
    client.dispose(); document.documentElement.dataset.phoneReady = 'false';
  });
  window.addEventListener('pageshow', event => {
    // A bfcache-restored document must not resurrect an expired proof or SDK.
    if (event.persisted && disposed) window.location.reload();
  });
  const clock = setInterval(() => {
    if (!disposed) {
      const seconds = record ? Math.max(0, Math.floor(((record.endedAt || Date.now()) - record.startedAt) / 1000)) : 0;
      text('call-timer', `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`);
      render(client?.state);
    }
  }, 1000);
  client = createControllerClient({ onChange: render });
  render(client.state); renderHistory();
  await client.boot().catch(() => {});
  if (!disposed) { document.documentElement.dataset.phoneReady = 'true'; connectEvents(); }
}
