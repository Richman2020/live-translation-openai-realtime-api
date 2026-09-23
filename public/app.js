'use strict';

(async () => {
  const { createCallLifecycle, createDeviceMediaOwner, microphoneMessages } = await import('./call-lifecycle.js');
  const $ = id => document.getElementById(id);
  const tokenKey = 'ai-phone-local-token';
  const historyKey = 'ai-phone-calls-v1';
  const preferencesKey = 'ai-phone-preferences-v1';
  const statusNames = { connecting: '正在连接', ringing: '等待接听', active: '通话中', ending: '正在结束', completed: '通话已结束', failed: '通话未完成' };
  const terminal = value => ['completed', 'failed', 'canceled', 'busy', 'no-answer', 'rejected'].includes(value);
  const requiresCleanup = session => session?.cleanupUnconfirmed === true || (session?.status === 'ending' && /^CALL_CLEANUP/.test(session.error || ''));
  const errorMessages = {
    CONFIGURATION_REQUIRED: '请先填写完整的电话与翻译连接信息。',
    LOCAL_ACCESS_ONLY: '此工作台只能在本机打开，请使用桌面「AI 电话」。',
    UNAUTHORIZED: '本机访问凭据已失效，请从桌面「AI 电话」重新打开。',
    REQUEST_FAILED: '服务未能完成操作，请检查配置与网络后重试。',
    CALL_OR_VERIFICATION_IN_PROGRESS: '当前正在通话或验证连接，请完成后再修改设置。',
    INVALID_SETTINGS: '连接信息格式不正确，请检查填写内容。',
    PRIVATE_BOOTSTRAP_SETTING: '本机访问保护只能通过桌面启动器设置。',
    INVALID_PRESENCE: '电话在线状态更新失败，请重新开启通话。',
    INVALID_DESTINATION: '请输入有效的美国电话号码（+1 加十位号码）。',
    CANNOT_DIAL_OWN_NUMBER: '不能拨打自己的 Twilio 号码，请填写对方的测试号码。',
    BROWSER_NOT_READY: '浏览器电话尚未就绪，请先点击「开启通话」。',
    BUSY: '已有一通电话正在进行，请先结束当前通话。',
    SHUTTING_DOWN: '本机服务正在停止，请稍后从桌面重新打开。',
    VERIFICATION_IN_PROGRESS: '正在验证 API 连接，请等待验证完成。',
    VERIFICATION_COOLDOWN: '刚完成一次连接验证，请稍候再试。',
    CALL_CLEANUP_FAILED: '线路关闭待确认。请点击「重试挂断」；确认关闭前不能拨出下一通电话。',
    CALL_CLEANUP_UNCONFIRMED: '线路关闭待确认。请点击「重试挂断」；若仍未成功，请到 Twilio 控制台检查当前通话。',
    CALL_SETUP_TIMEOUT: '通话连接超时，请检查号码与公网隧道后重试。',
    CALL_DURATION_LIMIT: '已达到单次通话时长上限，电话已请求结束。',
    CALL_BUSY: '对方正在通话，请稍后再拨。',
    CALL_NO_ANSWER: '对方未接听，请稍后再拨。',
    CALL_FAILED: '电话未能接通，请检查目标号码与线路配置。',
    CALL_CANCELED: '本次通话已取消。',
    TWILIO_CALL_FAILED: '电话线路连接失败，请检查 Twilio 账户与号码配置。',
    MEDIA_STREAM_FAILED: '电话音频连接失败，请检查公网隧道与网络。',
    INVALID_MEDIA_MESSAGE: '电话音频数据异常，本次通话已请求结束。',
    UNSUPPORTED_AUDIO_FORMAT: '电话音频格式不受支持，请检查线路配置。',
    SESSION_NOT_FOUND: '当前通话已结束或不存在，请刷新状态。',
    INVALID_SESSION: '通话会话已失效，请结束后重新拨打。',
    INVALID_BROWSER_CALL: '浏览器电话验证失败，请重新开启通话。',
    INVALID_INBOUND_CALL: '来电验证失败，请检查号码的语音回调配置。',
    INVALID_TWILIO_SIGNATURE: '电话回调验证失败，请检查 Twilio 凭据与公网地址。',
    INVALID_MEDIA_STREAM: '音频连接验证失败，请检查电话回调配置。',
    UNEXPECTED_CALL_LEG: '电话两端未正确配对，请结束后重新拨打。',
    CALL_SID_MISMATCH: '电话标识不匹配，请检查当前通话状态。',
    TOO_MANY_EVENT_CONNECTIONS: '工作台窗口过多，请关闭多余窗口后重试。',
    NOT_FOUND: '请求的服务入口不存在，请更新并重启工作台。',
    CONNECTION_FAILED: '无法连接服务，请检查网络与密钥。',
    CONNECTION_OR_RESOURCE_FAILED: '连接失败或账户资源不可访问，请检查密钥与资源归属。',
    RESOURCE_MISMATCH: '账户、号码或电话应用配置不匹配，请检查资源和回调地址。',
    SESSION_TIMEOUT: '实时翻译会话连接超时。',
    SESSION_REJECTED: '实时翻译会话被拒绝，请检查模型权限与配置。',
    CLOSED_BEFORE_READY: '实时翻译连接在就绪前关闭。',
    INVALID_RESPONSE: '服务返回了无法识别的数据。',
    SESSION_UPDATED: '实时翻译会话已确认配置。',
    VERIFIED_RESOURCE: '账户资源与配置验证通过。'
  };
  const fields = [
    ['PUBLIC_BASE_URL', '公网隧道地址', false, 'https://你的域名', 'Twilio 用此 HTTPS 地址连接本机。隧道需支持 WebSocket。'],
    ['TWILIO_ACCOUNT_SID', 'Twilio Account SID', false, 'AC…', '使用已有号码所在的账户。'],
    ['TWILIO_AUTH_TOKEN', 'Twilio Auth Token', true, '留空保留现有密钥', '仅保存到本机，不向网页回传。'],
    ['TWILIO_API_KEY_SID', 'Twilio API Key SID', false, 'SK…', '用于生成浏览器电话的短期凭据。'],
    ['TWILIO_API_KEY_SECRET', 'Twilio API Key Secret', true, '留空保留现有密钥', '需与上面的 API Key SID 配对。'],
    ['TWILIO_TWIML_APP_SID', 'Twilio TwiML App SID', false, 'AP…', '应用的语音回调需指向此服务。'],
    ['TWILIO_CALLER_NUMBER', '我的 Twilio 电话号码', false, '+1…', '该账户拥有的美国号码，包含国家区号。'],
    ['OPENAI_API_KEY', 'OpenAI API Key', true, '留空保留现有密钥', '使用具有 Realtime 模型访问权限的密钥。'],
    ['OPENAI_REALTIME_MODEL', '实时翻译模型', false, 'gpt-realtime-1.5', '可用性以你的 OpenAI 账户验证结果为准。']
  ];
  let accessToken = '';
  let state = null;
  let activeSession = null;
  let device = null;
  let deviceMediaOwner = null;
  let sdkCall = null;
  let incomingCall = null;
  let registered = false;
  let enabling = false;
  let dialing = false;
  let acceptingAttempt = null;
  let ending = false;
  let saving = false;
  let verifying = false;
  let muted = false;
  let eventSource = null;
  let eventsOnline = false;
  let heartbeat = null;
  let refreshPending = null;
  let record = null;
  let selectedHistory = null;
  let toastTimer = null;
  let disposed = false;
  const callLifecycle = createCallLifecycle({
    requestMedia: navigator.mediaDevices?.getUserMedia ? constraints => navigator.mediaDevices.getUserMedia(constraints) : null,
    onChange: () => renderStatus(),
  });
  const callPhases = { preparing: '正在准备电话线路', microphone: '等待麦克风授权，请查看地址栏的麦克风或权限图标', signaling: '麦克风已就绪，正在连接电话线路', connected: '浏览器线路已连接，等待电话音频', reconnecting: '电话音频连接中断，正在恢复' };
  const safeRead = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
  let preferences = { saveHistory: false, showOriginal: true, ...safeRead(preferencesKey, {}) };
  preferences = { saveHistory: preferences.saveHistory === true, showOriginal: preferences.showOriginal !== false };
  let historyRecords = safeRead(historyKey, []);
  historyRecords = Array.isArray(historyRecords) ? historyRecords.filter(r => r && typeof r.id === 'string' && Array.isArray(r.lines)).slice(0, 30) : [];
  try {
    const fragment = new URLSearchParams(location.hash.slice(1));
    accessToken = fragment.get('token') || sessionStorage.getItem(tokenKey) || '';
    if (fragment.has('token')) {
      // Remove the credential from browser history even if storage is unavailable.
      window.history.replaceState(null, '', location.pathname + location.search);
      if (accessToken) sessionStorage.setItem(tokenKey, accessToken);
    }
  } catch { window.history.replaceState(null, '', location.pathname + location.search); }

  function element(tag, className = '', text = '') {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
  }
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('icon'); svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', `#i-${name}`); svg.append(use); return svg;
  }
  function cleanMessage(value, fallback = '操作未完成，请检查连接后重试。') {
    if (typeof value !== 'string' || !value.trim()) return fallback;
    if (errorMessages[value]) return errorMessages[value];
    if (/^HTTP_\d{3}$/.test(value)) {
      const code = Number(value.slice(5));
      return code === 401 || code === 403 ? '账户认证或资源权限不足，请检查密钥和所属账户。' : code === 404 ? '未找到对应号码或电话应用，请检查资源标识。' : code === 429 ? '服务请求限额已达到，请稍后重试并检查额度。' : `服务连接未通过（HTTP ${code}），请检查账户和网络。`;
    }
    if (/^[a-z][a-z_]+(?::(?:local|remote))?$/i.test(value) && value.includes('_')) return fallback;
    let result = value.slice(0, 400);
    if (accessToken) result = result.split(accessToken).join('[已隐藏]');
    return result.replace(/(?:Bearer\s+|sk-(?:proj-)?)[A-Za-z0-9_.-]+/gi, '[已隐藏]');
  }
  function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000); }
  function callFailureMessage(session) {
    let message = cleanMessage(typeof session.error === 'string' ? session.error : '', '本次通话未完成，请检查配置及号码后重试。');
    if (session.error !== 'TWILIO_CALL_FAILED') return message;
    // 21216 has several causes; do not infer a specific missing profile or account restriction.
    // https://www.twilio.com/docs/api/errors/21216
    if (session.providerErrorCode === 21216) message = 'Twilio 已拦截这次外呼，请检查 Trust Hub 客户资料审核及号码拨号限制。';
    const diagnostics = [];
    if (Number.isInteger(session.providerErrorCode) && session.providerErrorCode > 0 && session.providerErrorCode <= 999999) diagnostics.push(`Twilio 错误 ${session.providerErrorCode}`);
    if (Number.isInteger(session.providerHttpStatus) && session.providerHttpStatus >= 400 && session.providerHttpStatus <= 599) diagnostics.push(`HTTP ${session.providerHttpStatus}`);
    return diagnostics.length ? `${message}（${diagnostics.join('，')}）` : message;
  }
  function showError(message) { $('app-error').textContent = cleanMessage(message); $('app-error').hidden = false; }
  function clearError() { $('app-error').hidden = true; $('app-error').textContent = ''; }
  function saveLocal(key, data) { try { localStorage.setItem(key, JSON.stringify(data)); return true; } catch { toast('浏览器未能保存记录，本次对话仍可导出。'); return false; } }
  function busy() { return dialing || ending || Boolean(activeSession && (!terminal(activeSession.status) || requiresCleanup(activeSession))) || Boolean(sdkCall || incomingCall); }
  function timeText(seconds) { const n = Math.max(0, Math.floor(seconds || 0)); return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`; }
  function duration(r = record) { return r?.endedAt ? r.duration : r?.connectedAt ? (Date.now() - r.connectedAt) / 1000 : 0; }
  function dateText(value) { return new Date(value || Date.now()).toLocaleString('zh-CN', { hour12: false }); }
  function navigate(view) {
    for (const name of ['workspace', 'history', 'settings']) $(`${name}-view`).hidden = name !== view;
    document.querySelectorAll('[data-view]').forEach(button => { const selected = button.dataset.view === view; button.classList.toggle('active', selected); selected ? button.setAttribute('aria-current', 'page') : button.removeAttribute('aria-current'); });
    $('page-crumb').textContent = { workspace: '通话工作台', history: '通话记录', settings: '连接设置' }[view];
    if (view === 'history') renderHistory();
    window.scrollTo(0, 0);
  }
  async function api(path, options = {}) {
    if (!accessToken) throw new Error('本机访问凭据缺失，请通过桌面「AI 电话」重新打开。');
    const controller = new AbortController();
    // Provider checks run four sequential 15-second requests; allow network overhead.
    const timeout = setTimeout(() => controller.abort(), path === '/api/verify' ? 75000 : 20000);
    try {
      const response = await fetch(path, { ...options, cache: 'no-store', signal: controller.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` } });
      let payload = {}; try { payload = await response.json(); } catch { /* A non-JSON error has a useful HTTP status. */ }
      if (!response.ok) {
        if (response.status === 401 || payload.error === 'UNAUTHORIZED') {
          state = null; eventSource?.close(); eventsOnline = false;
          throw new Error('本机访问凭据已失效，请关闭此窗口，再从桌面「AI 电话」打开。');
        }
        throw new Error(cleanMessage(typeof payload.error === 'string' ? payload.error : payload.message, `操作未完成（HTTP ${response.status}），请检查设置后重试。`));
      }
      return payload;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('本机服务响应超时，请检查服务状态后重试。');
      if (error instanceof TypeError) throw new Error('无法连接本机服务，请从桌面「AI 电话」重新打开。');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });

  function renderStatus() {
    const configured = state?.configured === true;
    const cleanupPending = requiresCleanup(activeSession);
    $('local-state').textContent = state ? '本机服务已连接' : '本机服务未连接';
    $('configuration-badge').textContent = state ? (configured ? '配置已填写' : '需要补充配置') : '未连接';
    $('readiness-title').textContent = !state ? '本机服务未连接' : !configured ? '先完成连接设置' : registered ? '电话已开启' : '配置已填写';
    $('readiness-copy').textContent = !state ? '请从桌面「AI 电话」重新打开。' : !configured ? '填入真实连接信息后，再开启通话。' : registered ? '可以拨号或接听；电话接通后才会产生实际翻译字幕。' : '点击「开启通话」注册线路。配置通过不代表真实通话已验证。';
    if (cleanupPending) { $('readiness-title').textContent = '线路关闭待确认'; $('readiness-copy').textContent = '请重试挂断。确认线路关闭前，工作台会阻止新的拨号。'; }
    $('device-state').textContent = enabling ? '正在开启电话…' : registered ? (eventsOnline ? '已注册 · 可接收来电' : '已注册 · 状态连接恢复中') : '通话尚未开启';
    $('device-dot').classList.toggle('ready', registered && eventsOnline);
    $('enable-device').textContent = enabling ? '正在开启…' : registered ? '关闭通话' : '开启通话';
    $('enable-device').disabled = !state || !configured || enabling || busy() || saving || verifying;
    $('start-call').disabled = !configured || !registered || !eventsOnline || busy() || saving || verifying;
    $('start-call').querySelector('span').textContent = dialing ? '正在拨号…' : busy() ? '通话进行中' : '拨打电话';
    $('phone-number').disabled = busy(); $('erase-number').disabled = busy();
    document.querySelectorAll('.dial-key').forEach(button => { button.disabled = busy(); });
    $('end-call').disabled = (!activeSession && !callLifecycle.current) || (activeSession && terminal(activeSession.status) && !cleanupPending) || ending;
    $('end-call-label').textContent = ending ? '正在结束…' : cleanupPending ? '重试挂断' : !activeSession && callLifecycle.current ? '取消准备' : '结束通话';
    $('mute-button').disabled = !sdkCall || sdkCall === incomingCall || ending;
    $('mute-button').setAttribute('aria-pressed', String(muted)); $('mute-button').querySelector('span').textContent = muted ? '取消静音' : '静音';
    $('call-hint').textContent = callLifecycle.current?.microphoneReady ? (muted ? '你的麦克风已静音' : '麦克风已就绪') : callLifecycle.current?.phase === 'microphone' ? '正在等待麦克风' : '麦克风未启用';
    $('accept-call').disabled = !incomingCall || ending || Boolean(acceptingAttempt); $('reject-call').disabled = !incomingCall || ending;
    $('incoming-banner').hidden = !incomingCall;
    $('save-settings').disabled = !state || busy() || saving || verifying;
    $('verify-connections').disabled = !state || !configured || busy() || saving || verifying;
    $('verify-connections').textContent = verifying ? '正在验证…' : '验证 API 连接';
    $('settings-fields').querySelectorAll('input').forEach(input => { input.disabled = busy() || saving; });
    $('export-current').disabled = !record?.lines.length;
    const currentState = activeSession?.status || (record?.endedAt ? record.status : '');
    const phase = callLifecycle.current?.phase;
    $('connection-text').textContent = cleanupPending ? '线路关闭待确认' : phase === 'reconnecting' ? '正在恢复音频连接' : statusNames[currentState] || '等待开始';
    $('connection-status').classList.toggle('active', currentState === 'active');
    document.body.classList.toggle('is-active', currentState === 'active');
    $('bridge-caption').textContent = phase === 'reconnecting' ? callPhases[phase] : currentState === 'active' ? '中文与英文，正在传递' : phase === 'microphone' ? callPhases[phase] : currentState === 'ringing' ? '正在呼叫对方，等待接听' : callPhases[phase] || '连接后，听见彼此的语言';
    $('call-timer').textContent = timeText(duration());
  }
  function renderChecks() {
    $('configuration-checks').replaceChildren();
    for (const check of state?.checks || []) {
      const row = element('div', 'config-check');
      const label = fields.find(field => field[0] === check.name)?.[1] || { LOCAL_ACCESS_TOKEN: '本机访问保护', API_HOST: '本机监听地址', API_PORT: '本机服务端口' }[check.name] || '其他连接配置';
      row.append(element('span', '', label), element('span', `check-state ${check.status === 'ready' ? 'ready' : 'needs-attention'}`, { ready: '已填写', missing: '未填写', invalid: '格式需检查' }[check.status] || '待检查'));
      $('configuration-checks').append(row);
    }
    if (!state?.checks?.length) $('configuration-checks').append(element('p', 'form-intro', '连接本机服务后显示配置状态。'));
  }
  function makeRecord(session) {
    return { id: session.id, number: session.direction === 'inbound' ? (session.from || '来电') : (session.to || ''), direction: session.direction, status: session.status, startedAt: Date.now(), connectedAt: session.status === 'active' ? Date.now() : null, endedAt: null, duration: 0, lines: [] };
  }
  function finishRecord(status) {
    if (!record || record.endedAt) return;
    record.duration = duration(); record.endedAt = Date.now(); record.status = status;
    if (preferences.saveHistory) { historyRecords = [structuredClone(record), ...historyRecords.filter(r => r.id !== record.id)].slice(0, 30); saveLocal(historyKey, historyRecords); }
    $('transcript-subtitle').textContent = `${statusNames[status] || '通话已结束'} · ${record.lines.length ? '可导出文字记录' : '未收到字幕'}`;
    renderHistory();
  }
  function clearSdkCall() {
    const attempt = callLifecycle.current;
    const wasIncoming = Boolean(incomingCall);
    const oldCall = sdkCall || incomingCall; sdkCall = null; incomingCall = null; acceptingAttempt = null; muted = false;
    try { if (wasIncoming && (!oldCall?.status || oldCall.status() === 'pending')) oldCall?.reject(); else oldCall?.disconnect(); } catch { /* Backend end state remains authoritative. */ }
    callLifecycle.cancel(attempt);
    if (attempt?.mediaOwner?.retireIfPending(attempt) && device === attempt.device) {
      // Destroy only this old Device. A later registration gets a fresh AudioHelper.
      const oldDevice = device; device = null; deviceMediaOwner = null; registered = false;
      clearInterval(heartbeat); heartbeat = null;
      try { oldDevice.destroy(); } catch { /* The stale owner remains retired. */ }
      presence(false).catch(() => {});
    }
  }
  function applySession(session) {
    if (session && (typeof session.id !== 'string' || typeof session.status !== 'string')) return;
    if (session && terminal(session.status) && !requiresCleanup(session)) {
      if (activeSession?.id !== session.id && record?.id !== session.id) return;
      finishRecord(session.status); activeSession = null; dialing = false; ending = false; clearSdkCall();
      if (session.error) showError(callFailureMessage(session));
    } else if (session) {
      if (!record || record.id !== session.id) { if (record && !record.endedAt) finishRecord('completed'); record = makeRecord(session); $('transcript').replaceChildren(); $('empty-conversation').hidden = false; }
      activeSession = session; record.status = session.status;
      if (session.status === 'active' && !record.connectedAt) record.connectedAt = Date.now();
      $('transcript-subtitle').textContent = `${session.direction === 'inbound' ? '来电' : '拨出'} · ${record.number} · ${statusNames[session.status] || session.status}`;
      if (incomingCall) $('incoming-number').textContent = session.from || '收到来电';
      if (requiresCleanup(session)) showError(errorMessages.CALL_CLEANUP_UNCONFIRMED);
    } else if (activeSession) {
      finishRecord('completed'); activeSession = null; dialing = false; ending = false; clearSdkCall();
    }
    renderStatus();
  }
  async function refreshStatus() {
    if (refreshPending) return refreshPending;
    refreshPending = (async () => {
      try { const next = await api('/api/status'); state = next; applySession(next.activeSession || null); renderChecks(); renderStatus(); return next; }
      catch (error) { state = null; renderStatus(); throw error; }
      finally { refreshPending = null; }
    })();
    return refreshPending;
  }
  function connectEvents() {
    if (!accessToken || eventSource || disposed) return;
    eventSource = new EventSource(`/api/events?token=${encodeURIComponent(accessToken)}`);
    eventSource.onopen = () => { eventsOnline = true; renderStatus(); refreshStatus().catch(error => showError(error.message)); };
    const receive = (name, handler) => eventSource.addEventListener(name, event => {
      if (!event.data) return;
      try { handler(JSON.parse(event.data)); } catch { showError('收到的状态数据无法读取，正在重新检查。'); refreshStatus().catch(error => showError(error.message)); }
    });
    receive('snapshot', value => applySession(value.activeSession || null));
    receive('call', applySession);
    receive('transcript', appendTranscript);
    receive('error', value => showError(cleanMessage(value.message || value.error, '通话服务报告错误，请检查连接状态。')));
    eventSource.onerror = () => { eventsOnline = false; renderStatus(); };
  }
  function renderLine(line) {
    const article = element('article', `utterance ${line.role === 'remote' ? 'their' : 'mine'} ${line.kind === 'original' ? 'original-entry' : ''}`);
    article.dataset.transcriptId = line.id;
    const meta = element('div', 'utterance-meta');
    meta.append(element('strong', '', line.role === 'local' ? '你' : '对方'), element('span', '', line.kind === 'original' ? '原文' : '译文'), element('span', 'draft-label', line.final ? '' : '识别中'));
    const at = new Date(line.at); if (!Number.isNaN(at.getTime())) meta.append(element('time', '', at.toLocaleTimeString('zh-CN', { hour12: false })));
    const bubble = element('div', 'speech-bubble'); bubble.append(element('p', 'transcript-text', line.text)); article.append(meta, bubble); return article;
  }
  function appendTranscript(value) {
    if (!value || typeof value.id !== 'string' || typeof value.text !== 'string' || !['local', 'remote'].includes(value.role) || !['original', 'translation'].includes(value.kind)) return;
    if (!record || (value.sessionId && value.sessionId !== record.id)) return;
    const line = { id: value.id, role: value.role, kind: value.kind, text: value.text.slice(0, 20000), final: value.final === true, at: value.at || new Date().toISOString() };
    const index = record.lines.findIndex(old => old.id === line.id);
    if (index >= 0) record.lines[index] = line; else record.lines.push(line);
    const oldNode = [...$('transcript').children].find(node => node.dataset.transcriptId === line.id);
    const scroll = $('transcript-scroll'); const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
    if (oldNode) oldNode.replaceWith(renderLine(line)); else $('transcript').append(renderLine(line));
    $('empty-conversation').hidden = true;
    if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
    $('export-current').disabled = false;
  }
  async function presence(available) { if (accessToken) await post('/api/presence', { available }); }
  async function destroyDevice() {
    clearInterval(heartbeat); heartbeat = null; registered = false;
    const oldDevice = device; device = null; deviceMediaOwner = null;
    try { await oldDevice?.unregister(); } catch { /* Still destroy locally. */ }
    try { oldDevice?.destroy(); } catch { /* Already destroyed. */ }
    await presence(false).catch(() => {}); renderStatus();
  }
  async function enableDevice() {
    if (busy() || enabling) return;
    clearError();
    if (registered) { await destroyDevice(); return; }
    enabling = true; renderStatus();
    try {
      await refreshStatus();
      if (!state.configured) throw new Error('请先完成连接设置。');
      if (!window.Twilio?.Device) throw new Error('电话组件尚未加载，请重新启动桌面工作台。');
      if (device) await destroyDevice();
      const data = await api('/api/token');
      // Official DeviceOptions.getUserMedia receives constraints and returns Promise<MediaStream>.
      // https://www.twilio.com/docs/voice/sdks/javascript/twiliodevice#deviceoptions
      const mediaOwner = createDeviceMediaOwner(callLifecycle);
      const next = new window.Twilio.Device(data.token, {
        logLevel: 'silent', tokenRefreshMs: 60000, closeProtection: true,
        enableImprovedSignalingErrorPrecision: true,
        getUserMedia: constraints => mediaOwner.getUserMedia(constraints),
      });
      device = next; deviceMediaOwner = mediaOwner;
      next.on('registered', () => {
        if (device !== next) return; registered = true; clearInterval(heartbeat);
        presence(true).catch(error => showError(error.message));
        heartbeat = setInterval(() => presence(true).catch(error => showError(error.message)), 15000); renderStatus();
      });
      next.on('unregistered', () => { if (device !== next) return; registered = false; clearInterval(heartbeat); presence(false).catch(() => {}); renderStatus(); });
      next.on('tokenWillExpire', async () => { try { const fresh = await api('/api/token'); if (device === next) next.updateToken(fresh.token); } catch (error) { showError(error.message); if (!busy()) await destroyDevice(); } });
      next.on('error', error => { if (device !== next) return; showError(`电话线路连接失败${Number.isInteger(error.code) ? `（${error.code}）` : ''}，请检查 Twilio 配置与网络。`); });
      next.on('incoming', receiveIncoming);
      await next.register();
    } catch (error) { showError(error.message); await destroyDevice(); }
    finally { enabling = false; renderStatus(); }
  }
  function bindCall(call, attempt) {
    sdkCall = call;
    call.on('accept', () => { if (sdkCall !== call || !callLifecycle.isCurrent(attempt)) return; incomingCall = null; callLifecycle.update(attempt, { phase: 'connected' }); renderStatus(); refreshStatus().catch(error => showError(error.message)); });
    call.on('reconnecting', () => { if (sdkCall === call) callLifecycle.update(attempt, { phase: 'reconnecting' }); });
    call.on('reconnected', () => { if (sdkCall === call) callLifecycle.update(attempt, { phase: 'connected' }); });
    call.on('mute', value => { if (sdkCall !== call) return; muted = value === true; renderStatus(); });
    for (const event of ['disconnect', 'cancel', 'reject']) call.on(event, () => {
      if (sdkCall !== call && incomingCall !== call) return;
      sdkCall = null; incomingCall = null; muted = false;
      callLifecycle.cancel(attempt);
      endCall(attempt).catch(error => showError(error.message)); renderStatus();
    });
    call.on('error', error => {
      if (sdkCall !== call && incomingCall !== call) return;
      showError(microphoneMessages[attempt?.failureCode] || `电话线路连接失败${Number.isInteger(error.code) ? `（${error.code}）` : ''}。请检查网络与电话配置后重试。`);
      endCall(attempt).catch(error => showError(error.message));
    });
  }
  function receiveIncoming(call) {
    if (sdkCall || incomingCall || dialing || ending) { call.reject(); return; }
    const attempt = callLifecycle.begin(activeSession?.id || null);
    Object.assign(attempt, { direction: 'inbound', device, mediaOwner: deviceMediaOwner });
    incomingCall = call; bindCall(call, attempt);
    $('incoming-number').textContent = call.customParameters?.get('from') || call.parameters?.From || activeSession?.from || '收到来电';
    navigate('workspace'); renderStatus(); refreshStatus().catch(error => showError(error.message));
  }
  async function startCall() {
    if (busy() || !registered || !eventsOnline) return;
    const to = $('phone-number').value.replace(/[\s()-]/g, '');
    if (!/^\+[1-9]\d{6,14}$/.test(to)) { $('phone-error').textContent = '请输入含国家区号的号码，例如 +1 加十位美国号码。'; $('phone-number').setAttribute('aria-invalid', 'true'); $('phone-number').focus(); return; }
    dialing = true; clearError(); renderStatus();
    const attempt = callLifecycle.begin();
    const attemptDevice = device;
    Object.assign(attempt, { direction: 'outbound', device: attemptDevice, mediaOwner: deviceMediaOwner });
    let createdId = null;
    try {
      // Permission and device acquisition finish before creating any server-side call.
      await callLifecycle.prepareMicrophone(attempt);
      if (!callLifecycle.isCurrent(attempt)) return;
      const created = await post('/api/calls', { to }); createdId = created.id;
      if (!createdId || !created.connectionParams) throw new Error('电话服务未返回有效连接信息。');
      if (!callLifecycle.isCurrent(attempt)) { await post(`/api/calls/${encodeURIComponent(createdId)}/hangup`).catch(() => {}); return; }
      callLifecycle.update(attempt, { sessionId: createdId });
      applySession(created);
      const call = await attempt.mediaOwner.connect(attempt, () => attemptDevice.connect({ params: created.connectionParams }));
      if (!call) return;
      if (activeSession?.id !== createdId || terminal(activeSession.status)) { call.disconnect(); return; }
      bindCall(call, attempt);
    } catch (error) {
      if (!callLifecycle.isCurrent(attempt)) return;
      const message = microphoneMessages[attempt.failureCode] || error.message;
      showError(message);
      if (createdId) await post(`/api/calls/${encodeURIComponent(createdId)}/hangup`).catch(() => { if (callLifecycle.isCurrent(attempt)) showError('拨号未完成，远端清理仍待确认，请点击结束通话重试。'); });
      if (!callLifecycle.isCurrent(attempt)) return;
      dialing = false; clearSdkCall(); showError(message); await refreshStatus().catch(() => {});
    } finally { if (callLifecycle.isCurrent(attempt)) { dialing = false; renderStatus(); } }
  }
  async function endCall(attempt = callLifecycle.current) {
    if (ending) return;
    if (attempt && callLifecycle.current && !callLifecycle.isCurrent(attempt)) return;
    let id = attempt?.sessionId || activeSession?.id;
    ending = true; dialing = false; clearSdkCall(); renderStatus();
    try {
      if (!id) {
        const next = await api('/api/status');
        if (callLifecycle.current && callLifecycle.current !== attempt) return;
        // Incoming SDK events can precede the server's SSE snapshot.
        if (next.activeSession && (!attempt || next.activeSession.direction === attempt.direction)) {
          id = next.activeSession.id; state = next; applySession(next.activeSession);
        }
      }
      if (id) await post(`/api/calls/${encodeURIComponent(id)}/hangup`);
      if (!callLifecycle.current || callLifecycle.current === attempt) await refreshStatus();
    } catch (error) { if (!callLifecycle.current || callLifecycle.current === attempt) { showError(`结束通话尚未确认：${error.message}`); await refreshStatus().catch(() => {}); } }
    finally { if (!callLifecycle.current || callLifecycle.current === attempt) { ending = false; renderStatus(); } }
  }
  async function acceptCall() {
    const call = incomingCall; if (!call || ending || acceptingAttempt) return;
    const attempt = callLifecycle.current;
    acceptingAttempt = attempt;
    $('accept-call').disabled = true;
    try {
      await callLifecycle.prepareMicrophone(attempt);
      if (incomingCall !== call || !callLifecycle.isCurrent(attempt)) { callLifecycle.cancel(attempt); return; }
      await refreshStatus();
      if (incomingCall !== call || !activeSession || !callLifecycle.isCurrent(attempt)) { callLifecycle.cancel(attempt); return; }
      callLifecycle.update(attempt, { sessionId: activeSession.id });
      attempt.mediaOwner.bind(attempt); call.accept();
    } catch (error) {
      if (callLifecycle.isCurrent(attempt)) { showError(microphoneMessages[attempt.failureCode] || error.message); await endCall(attempt); }
    }
    finally { if (acceptingAttempt === attempt) acceptingAttempt = null; renderStatus(); }
  }
  async function rejectCall() {
    const call = incomingCall; if (!call) return;
    incomingCall = null; if (sdkCall === call) sdkCall = null;
    try { call.reject(); } catch { /* Backend hangup is still attempted. */ }
    await endCall();
  }
  function exportRecord(item) {
    if (!item?.lines.length) return;
    const text = ['AI 电话 — 通话文字记录', `方向：${item.direction === 'inbound' ? '来电' : '拨出'}`, `号码：${item.number}`, `时间：${dateText(item.startedAt)}`, `页面观察时长：${timeText(duration(item))}`, '字幕由语音服务生成，可能存在识别或翻译错误。', '', ...item.lines.map(line => `[${line.role === 'local' ? '你' : '对方'} · ${line.kind === 'original' ? '原文' : '译文'}${line.final ? '' : ' · 未定稿'}] ${line.text}`)].join('\r\n');
    const url = URL.createObjectURL(new Blob(['\uFEFF', text], { type: 'text/plain;charset=utf-8' }));
    const link = element('a'); link.href = url; link.download = `AI电话-通话记录-${new Date(item.startedAt).toISOString().replace(/[:.]/g, '-')}.txt`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  function renderHistory() {
    $('history-count').textContent = historyRecords.length; $('clear-history').disabled = !historyRecords.length; $('history-list').replaceChildren();
    if (!historyRecords.some(r => r.id === selectedHistory)) selectedHistory = historyRecords[0]?.id || null;
    for (const item of historyRecords) {
      const button = element('button', 'history-item'); button.classList.toggle('selected', item.id === selectedHistory); button.setAttribute('aria-pressed', String(item.id === selectedHistory));
      button.append(element('strong', '', item.number), element('small', '', `${item.direction === 'inbound' ? '来电' : '拨出'} · ${statusNames[item.status] || '已结束'}`));
      const meta = element('div', 'history-meta'); meta.append(element('span', '', dateText(item.startedAt)), element('span', '', timeText(item.duration))); button.append(meta);
      button.addEventListener('click', () => { selectedHistory = item.id; renderHistory(); }); $('history-list').append(button);
    }
    $('history-detail').replaceChildren(); const item = historyRecords.find(r => r.id === selectedHistory);
    if (!item) { const empty = element('div', 'empty-conversation'); empty.append(icon('clock'), element('h3', '', '还没有保存的通话'), element('p', '', '可在连接设置中开启「保存通话文字」。')); $('history-detail').append(empty); return; }
    const heading = element('div', 'detail-heading'); const title = element('div'); title.append(element('h2', '', item.number), element('p', '', `${dateText(item.startedAt)} · 普通话 ↔ English`));
    const download = element('button', 'secondary-button', '导出文字'); download.disabled = !item.lines.length; download.addEventListener('click', () => exportRecord(item)); heading.append(title, download);
    $('history-detail').append(heading, ...item.lines.map(renderLine));
  }
  function applyPreferences() {
    document.body.classList.toggle('hide-original', !preferences.showOriginal);
    for (const [id, key] of [['save-history-toggle', 'saveHistory'], ['show-original-toggle', 'showOriginal']]) { $(id).classList.toggle('on', preferences[key]); $(id).setAttribute('aria-checked', String(preferences[key])); }
  }
  function renderSettingsForm() {
    for (const [name, label, secret, placeholder, description] of fields) {
      const group = element('div', 'settings-field'); const heading = element('label', '', label); heading.htmlFor = `setting-${name}`;
      const input = element('input'); input.id = `setting-${name}`; input.name = name; input.type = secret ? 'password' : 'text'; input.autocomplete = secret ? 'new-password' : 'off'; input.placeholder = placeholder; input.spellcheck = false; input.maxLength = 1024;
      const help = element('small', '', description); help.id = `hint-${name}`; input.setAttribute('aria-describedby', help.id); group.append(heading, input, help); $('settings-fields').append(group);
    }
  }
  async function saveSettings(event) {
    event.preventDefault(); if (busy() || saving) return;
    const values = {}; for (const [name] of fields) { const value = $(`setting-${name}`).value.trim(); if (value) values[name] = value; }
    if (!Object.keys(values).length) { $('settings-feedback').textContent = '没有填写新值，现有配置保持不变。'; return; }
    saving = true; $('settings-error').textContent = ''; $('settings-feedback').textContent = ''; renderStatus();
    try {
      await post('/api/settings', values);
      $('settings-form').reset(); await destroyDevice(); await refreshStatus();
      $('settings-feedback').textContent = '已保存到本机。请验证 API 连接，再回到工作台开启通话。';
      $('verification-results').replaceChildren();
    } catch (error) { $('settings-error').textContent = cleanMessage(error.message); }
    finally { for (const [name, , secret] of fields) if (secret) $(`setting-${name}`).value = ''; saving = false; renderStatus(); }
  }
  async function verifyConnections() {
    if (verifying || busy()) return;
    verifying = true; $('verification-results').replaceChildren(element('p', 'form-intro', '正在验证账户、号码、电话应用与实时翻译会话…')); renderStatus();
    try {
      const result = await post('/api/verify'); $('verification-results').replaceChildren();
      const labels = { twilioAccount: 'Twilio 账户', twilioNumber: 'Twilio 号码', twilioApplication: '电话应用', openaiRealtime: 'OpenAI Realtime' };
      for (const check of result.checks || []) {
        const row = element('div', 'config-check'); row.append(element('span', '', labels[check.name] || check.name), element('span', `check-state ${check.status === 'passed' ? 'ready' : 'needs-attention'}`, { passed: '连接验证通过', failed: '验证未通过', missing: '缺少配置' }[check.status] || '待检查'));
        if (check.code) row.title = cleanMessage(String(check.code)); $('verification-results').append(row);
      }
      $('verification-results').append(element('p', 'form-intro', '本次仅验证 API 连接。仍需真实电话确认两个语言方向、听感与端到端延迟。'));
    } catch (error) { $('verification-results').replaceChildren(element('p', 'field-error', cleanMessage(error.message))); }
    finally { verifying = false; renderStatus(); }
  }

  const keypad = document.querySelector('.keypad');
  for (const [digit, letters] of [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['+', '区号'], ['0', ''], ['⌫', '删除']]) {
    const button = element('button', 'dial-key', digit); button.setAttribute('aria-label', digit === '⌫' ? '删除最后一位号码' : `拨号键 ${digit}`); button.append(element('small', '', letters || '\u00a0'));
    button.addEventListener('click', () => { if (busy()) return; const input = $('phone-number'); if (digit === '⌫') input.value = input.value.slice(0, -1); else if (input.value.length < 24) input.value += digit; input.dispatchEvent(new Event('input')); }); keypad.append(button);
  }
  document.querySelectorAll('.wave-line').forEach(wave => [3, 5, 7, 4, 12, 18, 10, 25, 16, 22, 13, 19, 8, 14, 6, 10, 5, 3].forEach((height, index) => { const bar = element('i'); bar.style.setProperty('--bar-height', `${height}px`); bar.style.setProperty('--bar-delay', `${index * -.075}s`); wave.append(bar); }));
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.view)));
  document.querySelectorAll('[data-navigate]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.navigate)));
  document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); navigate('workspace'); });
  $('enable-device').addEventListener('click', enableDevice); $('start-call').addEventListener('click', startCall); $('end-call').addEventListener('click', () => endCall());
  $('accept-call').addEventListener('click', acceptCall); $('reject-call').addEventListener('click', rejectCall);
  $('mute-button').addEventListener('click', () => { if (!sdkCall || sdkCall === incomingCall) return; try { const nextMuted = !muted; sdkCall.mute(nextMuted); muted = nextMuted; renderStatus(); } catch { showError('未能切换麦克风状态，请检查通话连接。'); } });
  $('erase-number').addEventListener('click', () => { if (!busy()) { $('phone-number').value = $('phone-number').value.slice(0, -1); $('phone-number').focus(); } });
  $('phone-number').addEventListener('input', () => { $('phone-error').textContent = ''; $('phone-number').removeAttribute('aria-invalid'); });
  $('phone-number').addEventListener('keydown', event => { if (event.key === 'Enter') startCall(); });
  $('export-current').addEventListener('click', () => exportRecord(record));
  $('refresh-status').addEventListener('click', () => refreshStatus().then(() => toast('已重新检查本机配置。')).catch(error => showError(error.message)));
  $('settings-form').addEventListener('submit', saveSettings); $('verify-connections').addEventListener('click', verifyConnections);
  $('help-button').addEventListener('click', () => $('help-dialog').showModal()); $('close-help').addEventListener('click', () => $('help-dialog').close()); $('help-start').addEventListener('click', () => { $('help-dialog').close(); navigate('workspace'); });
  $('clear-history').addEventListener('click', () => $('clear-dialog').showModal()); $('cancel-clear').addEventListener('click', () => $('clear-dialog').close());
  $('confirm-clear').addEventListener('click', () => { historyRecords = []; selectedHistory = null; saveLocal(historyKey, historyRecords); renderHistory(); $('clear-dialog').close(); });
  for (const [id, key] of [['save-history-toggle', 'saveHistory'], ['show-original-toggle', 'showOriginal']]) $(id).addEventListener('click', () => { preferences[key] = !preferences[key]; saveLocal(preferencesKey, preferences); applyPreferences(); });
  window.addEventListener('beforeunload', event => { if (busy()) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', () => {
    disposed = true; clearInterval(heartbeat); eventSource?.close();
    callLifecycle.cancel();
    // Best effort only; server-side presence expiry and call lifecycle are authoritative.
    if (accessToken) fetch('/api/presence', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` }, body: JSON.stringify({ available: false }) }).catch(() => {});
    try { device?.destroy(); } catch { /* Navigation continues. */ }
  });
  renderSettingsForm(); applyPreferences(); renderHistory(); renderStatus();
  setInterval(() => { $('call-timer').textContent = timeText(duration()); }, 1000);
  setInterval(() => { if (state && !disposed) refreshStatus().catch(error => showError(error.message)); }, 10000);
  if (!accessToken) { showError('请通过桌面「AI 电话」打开此页面，以取得本机访问权限。'); navigate('settings'); }
  else refreshStatus().then(next => { connectEvents(); if (!next.configured) navigate('settings'); }).catch(error => { showError(error.message); navigate('settings'); });
})().catch(() => {
  const banner = document.getElementById('app-error');
  if (banner) { banner.textContent = '电话组件加载失败。请从桌面「AI 电话」重新打开；仍未恢复时请重启本机服务。'; banner.hidden = false; }
  const view = document.getElementById('workspace-view'); if (view) view.hidden = false;
  for (const id of ['enable-device', 'start-call', 'accept-call']) { const button = document.getElementById(id); if (button) button.disabled = true; }
});
