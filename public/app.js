'use strict';

(async () => {
  const { createCallLifecycle, createDeviceMediaOwner, microphoneMessages } = await import('./call-lifecycle.js');
  const { createAudioOutput } = await import('./audio-output.js');
  const { createMicrophoneInput } = await import('./microphone-input.js');
  const { createRtcDiagnostics, validatedTwilioEdge } = await import('./rtc-diagnostics.js');
  const { createTranslationEngineSelection, translationEngineLabel, translationReadiness, usesNanoVoice, usesPocketVoice, usesLocalVoice, usesRemoteCaptions } = await import('./translation-engine.js');
  const $ = id => document.getElementById(id);
  const tokenKey = 'ai-phone-local-token';
  const missingAccessMessage = '此标签页未取得本机访问凭据，尚未检查服务状态。请通过桌面「AI 电话」重新打开。';
  const rejectedAccessMessage = '本机访问凭据已失效，请关闭此窗口，再从桌面「AI 电话」打开。';
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
    INVALID_TRANSLATION_ENGINE: '翻译版本无效，请刷新页面后重新选择。',
    TRANSLATION_ENGINE_UNAVAILABLE: '所选翻译版本暂不可用，请选择当前版本，或在连接设置中重新验证。',
    CANNOT_DIAL_OWN_NUMBER: '不能拨打自己的 Twilio 号码，请填写对方的测试号码。',
    BROWSER_NOT_READY: '浏览器电话尚未就绪，请先点击「开启通话」。',
    BUSY: '已有一通电话正在进行，请先结束当前通话。',
    SHUTTING_DOWN: '本机服务正在停止，请稍后从桌面重新打开。',
    VERIFICATION_IN_PROGRESS: '正在验证 API 连接，请等待验证完成。',
    VERIFICATION_COOLDOWN: '刚完成一次连接验证，请稍候再试。',
    CALL_CLEANUP_FAILED: '线路关闭待确认。请点击「重试挂断」；确认关闭前不能拨出下一通电话。',
    CALL_CLEANUP_UNCONFIRMED: '线路关闭待确认。请点击「重试挂断」；若仍未成功，请到 Twilio 控制台检查当前通话。',
    CALL_SETUP_TIMEOUT: '通话连接超时，请检查号码与公网隧道后重试。',
    PUBLIC_CALLBACK_UNREACHABLE: '公网电话入口暂时不可达，本次尚未拨出。请恢复公网隧道后再试。',
    PUBLIC_CALLBACK_WRONG_SERVICE: '公网地址没有连接到此电话服务，本次尚未拨出。请核对隧道地址和电话回调。',
    PUBLIC_CALLBACK_URL_INVALID: '公网电话地址无效，本次尚未拨出。请在连接设置中填写正确的 HTTPS 地址。',
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
    SESSION_MISMATCH: '服务返回的音频或转写模型设置与请求不一致，请检查配置后重新验证。',
    INVALID_OPENAI_TRANSCRIPTION_MODEL: '语音转写模型无效，请选择 whisper-1、gpt-4o-transcribe 或 gpt-4o-mini-transcribe。',
    CLOSED_BEFORE_READY: '实时翻译连接在就绪前关闭。',
    INVALID_RESPONSE: '服务返回了无法识别的数据。',
    SESSION_UPDATED: '实时翻译会话已确认配置。',
    SESSION_UPDATED_BOTH_LANGUAGES: '中英双向连续翻译会话已确认配置。',
    NANO_AND_CONTINUOUS_READY: '本机本人声线已预热，中英双向连续翻译连接已就绪。',
    NANO_CAPTIONS_READY: '本人声线 B 版（稍慢、音量增强）、出程翻译和回程字幕连接已就绪。',
    CONTINUOUS_CAPTIONS_READY: '连续英文直出与回程字幕连接已就绪；出程使用模型声音。',
    NANO_READY: '本机本人声线已完成预热。',
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
    ['OPENAI_REALTIME_MODEL', '当前版本的翻译模型', false, 'gpt-realtime-1.5', '仅用于当前版本。连续翻译实验版使用独立模型，无需改这里。'],
    ['OPENAI_TRANSCRIPTION_MODEL', '当前版本的语音转写模型', false, 'whisper-1', '仅用于当前版本；支持 whisper-1、gpt-4o-transcribe 或 gpt-4o-mini-transcribe。改变后请重新验证并实测。']
  ];
  let accessToken = '';
  let localAccessRejected = false;
  let displayedErrorSource = null;
  let state = null;
  let activeSession = null;
  let device = null;
  let deviceMediaOwner = null;
  let sdkCall = null;
  let callDiagnostics = null;
  let incomingCall = null;
  let registered = false;
  let enabling = false;
  let enableEpoch = 0;
  let registrationRetryTimer = null;
  let registrationRetryAttempt = 0;
  let desktopEngine = null;
  let dialing = false;
  let acceptingAttempt = null;
  let ending = false;
  let saving = false;
  let verifying = false;
  let muted = false;
  let eventSource = null;
  let eventRetryTimer = null;
  let eventRetryAttempt = 0;
  let eventRetriesExhausted = false;
  let tokenRenewal = null;
  let eventsOnline = false;
  let heartbeat = null;
  let refreshPending = null;
  let record = null;
  const transcriptRows = new Map();
  let transcriptOrderEngine = null;
  let selectedHistory = null;
  let toastTimer = null;
  let disposed = false;
  const recoveringTranslationRoles = new Set();
  let translationRecoveryHint = false;
  let captionStatus = null;
  const audioDelivery = new Map();
  const translationTiming = new Map();
  const translationEngine = createTranslationEngineSelection();
  const audioOutput = createAudioOutput({ onChange: () => renderStatus() });
  const microphoneInput = createMicrophoneInput({ mediaDevices: navigator.mediaDevices, onChange: snapshot => renderMicrophoneInput(snapshot) });
  const callLifecycle = createCallLifecycle({
    requestMedia: navigator.mediaDevices?.getUserMedia ? constraints => navigator.mediaDevices.getUserMedia(constraints) : null,
    onChange: () => renderStatus(),
  });
  const callPhases = { preparing: '正在准备电话线路', checking: '正在检查公网电话入口', microphone: '等待麦克风授权，请查看地址栏的麦克风或权限图标', signaling: '麦克风已就绪，正在连接电话线路', connected: '浏览器线路已连接，等待电话音频', reconnecting: '电话音频连接中断，正在恢复' };
  const safeRead = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
  let preferences = { saveHistory: false, showOriginal: true, ...safeRead(preferencesKey, {}) };
  preferences = { saveHistory: preferences.saveHistory === true, showOriginal: preferences.showOriginal !== false, keepOnline: preferences.keepOnline === true };
  let historyRecords = safeRead(historyKey, []);
  historyRecords = Array.isArray(historyRecords) ? historyRecords.filter(r => r && typeof r.id === 'string' && Array.isArray(r.lines)).slice(0, 30) : [];
  try {
    const fragment = new URLSearchParams(location.hash.slice(1));
    accessToken = fragment.get('token') || sessionStorage.getItem(tokenKey) || '';
    if (accessToken && fragment.get('online') === '1') {
      preferences.keepOnline = true;
      saveLocal(preferencesKey, preferences);
      if (['pocket-captions', 'pocket-prefix'].includes(fragment.get('engine'))) desktopEngine = fragment.get('engine');
    }
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
    if (/^CAPTION_[A-Z_]+$/.test(value)) return '回程字幕连接未通过验证，请检查语音识别和文字翻译的模型权限与网络后重试。';
    if (value === 'POCKET_PREFIX_READY') return 'Pocket 边讲边播、固定男声与回程字幕连接已就绪；实际起声等待仍需电话测试。';
    if (/^(?:PREFIX_|prefix_)/i.test(value)) return '边讲边播连接或短词组处理未通过，请结束后重新验证新测试版；也可选择原 Pocket 版对照。';
    if (value === 'POCKET_CAPTIONS_READY') return 'Pocket 固定男声已预热，出程翻译与回程字幕连接已就绪。';
    if (value === 'POCKETVOICE_READY') return 'Pocket 固定男声服务已预热。';
    if (/^(?:POCKETVOICE_|pocket_)/i.test(value)) {
      if (/text_boundary_failed|text_too_long|sentence_too_long|unterminated/i.test(value)) return 'Pocket 译文过长或小节边界无法确认，通话已请求结束。请用有明确意思小节的讲话重新测试。';
      if (/overflow|backpressure|queue/i.test(value)) return 'Pocket 合成或播放积压过多，通话已请求结束。请稍后重试或选择其他版本。';
      if (/timeout/i.test(value)) return '本机 Pocket 男声准备或合成超时，请结束后重新验证 Pocket 测试候选。';
      if (/not_configured|missing|reference|manifest|checkpoint|config|unavailable|not_ready/i.test(value)) return '本机 Pocket 固定男声尚未准备好，请检查模型服务后重新验证 Pocket 测试候选。';
      if (/closed|connection|socket|exit|worker/i.test(value)) return '本机 Pocket 男声服务连接中断或未能启动，请结束后重新验证 Pocket 测试候选。';
      return '本机 Pocket 男声合成未完成，请结束后重新验证 Pocket 测试候选；也可选择其他版本。';
    }
    if (/^(?:NANOVOICE_|nano_)/i.test(value)) {
      if (/text_boundary_failed/i.test(value)) return '本人声线译文过长或句子边界无法确认，通话已请求结束。请用较短的完整句子重新测试。';
      if (/text_too_long|sentence_too_long|unterminated|text_length|max_chars/i.test(value)) return '本人声线等待完整句子时文字过长，通话已请求结束。请用较短的完整句子重新测试。';
      if (/overflow|backpressure|queue/i.test(value)) return '本人声线合成或播放积压过多，通话已请求结束。请稍后重试或选择其他版本。';
      if (/timeout/i.test(value)) return '本机本人声线准备或合成超时，请结束后重新验证本人声线实验版。';
      if (/not_configured|missing|reference|manifest|checkpoint|config|unavailable|not_ready/i.test(value)) return '本机本人声线尚未准备好，请检查本机声线服务与参考声音，再验证本人声线实验版。';
      if (/closed|connection|socket|exit|worker/i.test(value)) return '本机本人声线服务连接中断或未能启动，请结束后重新验证本人声线实验版。';
      return '本机本人声线合成未完成，请结束后重新验证本人声线实验版；也可选择其他版本。';
    }
    if (/^(continuous_input_before_ready_overflow|translation_input_overflow):(local|remote)$/.test(value)) {
      return '翻译准备或恢复耗时过长，输入声音已无法完整保留，通话已请求结束。请重新拨打，并等翻译就绪后再说话。';
    }
    if (/^continuous_[a-z_]+(?::(?:local|remote))?$/i.test(value)) {
      if (/timeout|closed|connection|socket/i.test(value)) return '连续翻译连接未完成或已中断，请检查网络后重新验证该版本。';
      if (/overflow|backpressure|queue/i.test(value)) return '连续翻译声音积压过多，通话已请求结束。请稍后重试或选择当前版本。';
      if (/rejected|mismatch|session|auth|model/i.test(value)) return '连续翻译会话未通过检查，请在连接设置中验证连续翻译实验版。';
      return '连续翻译服务未完成本次处理，请结束后重新验证；也可选择当前版本。';
    }
    const translationWait = /^(openai_transcription_timeout|translation_queue_timeout):(local|remote)$/.exec(value);
    if (translationWait) return translationWait[1] === 'openai_transcription_timeout'
      ? `等待${translationWait[2] === 'local' ? '你的中文' : '对方的英文'}识别超时，通话已请求结束。请检查网络后重试。`
      : '翻译等待时间过长，通话已请求结束。请检查网络后重试。';
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
  function showError(error) {
    displayedErrorSource = error?.recoverableLocalConnection === true ? 'local-connection' : error?.recoverableEventConnection === true ? 'event-connection' : 'operation';
    $('app-error').textContent = cleanMessage(typeof error === 'string' ? error : error?.message); $('app-error').hidden = false;
  }
  function clearError() { displayedErrorSource = null; $('app-error').hidden = true; $('app-error').textContent = ''; }
  function clearCleanupError() {
    if ([errorMessages.CALL_CLEANUP_FAILED, errorMessages.CALL_CLEANUP_UNCONFIRMED].includes($('app-error').textContent)) clearError();
  }
  function sdkFailureMessage(error) {
    if (error?.code === 31603) return '电话线路拒绝连接（31603）。公网语音入口中断也可能导致此错误；请先确认公网隧道在线，再重新拨号。';
    return `电话线路连接失败${Number.isInteger(error?.code) ? `（${error.code}）` : ''}。请检查网络与电话配置后重试。`;
  }
  const sdkWarnings = new Set([
    'constant-audio-input-level', 'constant-audio-output-level', 'low-bytes-sent', 'low-bytes-received',
    'high-jitter', 'high-rtt', 'high-packet-loss', 'high-packets-lost-fraction', 'low-mos', 'ice-connectivity-lost',
  ]);
  const sdkQualityWarnings = new Set([
    'low-bytes-sent', 'low-bytes-received', 'high-jitter', 'high-rtt',
    'high-packet-loss', 'high-packets-lost-fraction', 'low-mos', 'ice-connectivity-lost',
  ]);
  function readDeviceEdge(next) {
    // Public SDK getter reports the connected edge, not the configured roaming policy.
    // An unavailable/new SDK edge is omitted rather than inferred or logged verbatim.
    try { return validatedTwilioEdge(next?.edge); } catch { return undefined; }
  }
  function logSdkEvent(phase, error, warning, edge) {
    // Keep raw SDK objects out of logs: they can contain tokens, SDP, call IDs, or message text.
    const entry = { phase };
    if (Number.isInteger(error?.code) && error.code > 0 && error.code <= 999999) entry.code = error.code;
    if (sdkWarnings.has(warning)) entry.warning = warning;
    const observedEdge = validatedTwilioEdge(edge);
    if (observedEdge) entry.edge = observedEdge;
    console.info('[AI Phone SDK]', JSON.stringify(entry));
  }
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
  async function api(path, options = {}, timeoutMs, acceptResponse = () => true) {
    if (!accessToken) throw new Error(missingAccessMessage);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    // Verification allows four sequential requests. Dialing can require a
    // 5-second public probe plus a 15-second engine probe, with transport margin.
    const timeout = setTimeout(() => controller.abort(), timeoutMs ?? (path === '/api/verify' ? 75000 : path === '/api/calls' ? 30000 : 20000));
    try {
      const response = await fetch(path, { ...options, cache: 'no-store', signal: controller.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` } });
      let payload = {}; try { payload = await response.json(); } catch { /* A non-JSON error has a useful HTTP status. */ }
      // A retired Device's renewal must not invalidate a newer page/device state.
      if (!acceptResponse()) return null;
      if (!response.ok) {
        if (response.status === 401 || payload.error === 'UNAUTHORIZED') {
          localAccessRejected = true;
          state = null; stopEvents(); eventsOnline = false;
          throw new Error(rejectedAccessMessage);
        }
        throw new Error(cleanMessage(typeof payload.error === 'string' ? payload.error : payload.message, `操作未完成（HTTP ${response.status}），请检查设置后重试。`));
      }
      return payload;
    } catch (error) {
      if (error.name === 'AbortError' || error instanceof TypeError) {
        const message = error.name === 'AbortError' ? '本机服务响应超时，请检查服务状态后重试。' : '无法连接本机服务，请从桌面「AI 电话」重新打开。';
        // A successful status read only resolves this read failure, not an uncertain call or hangup.
        throw Object.assign(new Error(message), { recoverableLocalConnection: path === '/api/status' });
      }
      throw error;
    } finally { clearTimeout(timeout); options.signal?.removeEventListener('abort', abort); }
  }
  const post = (path, body = {}, timeoutMs) => api(path, { method: 'POST', body: JSON.stringify(body) }, timeoutMs);

  function renderStatus() {
    const configured = state?.configured === true;
    const restoring = Boolean(state?.connectionMaintenance || preferences.keepOnline && ['starting', 'recovering', 'offline'].includes(state?.desktopConnection?.state));
    $('keep-online-toggle').classList.toggle('on', preferences.keepOnline);
    $('keep-online-toggle').setAttribute('aria-checked', String(preferences.keepOnline));
    const cleanupPending = requiresCleanup(activeSession);
    const accessNotice = !accessToken
      ? { title: '本机访问权限缺失', badge: '需要从桌面打开', copy: missingAccessMessage }
      : localAccessRejected ? { title: '本机访问凭据已失效', badge: '需要重新打开', copy: rejectedAccessMessage } : null;
    $('local-state').textContent = accessNotice?.title || (state ? '本机服务已连接' : '本机服务未连接');
    $('configuration-badge').textContent = accessNotice?.badge || (state ? (configured ? '配置已填写' : '需要补充配置') : '未连接');
    $('readiness-title').textContent = accessNotice?.title || (!state ? '本机服务未连接' : !configured ? '先完成连接设置' : registered ? '电话已开启' : '配置已填写');
    $('readiness-copy').textContent = accessNotice?.copy || (!state ? '请从桌面「AI 电话」重新打开。' : !configured ? '填入真实连接信息后，再开启通话。' : registered ? '拨号前可选择翻译版本；电话接通后，等「翻译已就绪」再说话。' : '点击「开启通话」注册线路。配置通过不代表真实通话已验证。');
    if (cleanupPending) { $('readiness-title').textContent = '线路关闭待确认'; $('readiness-copy').textContent = '请重试挂断。确认线路关闭前，工作台会阻止新的拨号。'; }
    $('device-state').textContent = enabling ? '正在开启电话…' : registered ? (eventsOnline ? '已注册 · 可接收来电' : '已注册 · 状态连接恢复中') : '通话尚未开启';
    $('device-dot').classList.toggle('ready', registered && eventsOnline);
    $('enable-device').textContent = enabling ? '正在开启…' : registered ? '关闭通话' : '开启通话';
    $('enable-device').disabled = !state || !configured || enabling || busy() || saving || verifying;
    renderTranslationEngine();
    $('start-call').disabled = !configured || !registered || !eventsOnline || busy() || saving || verifying || restoring || audioOutput.snapshot.status !== 'idle';
    $('start-call').querySelector('span').textContent = dialing
      ? (usesLocalVoice(translationEngine.snapshot.value) && callLifecycle.current?.phase === 'checking' ? (usesPocketVoice(translationEngine.snapshot.value) ? '正在准备 Pocket 男声…' : '正在准备本人声线…') : '正在拨号…')
      : busy() ? '通话进行中' : '拨打电话';
    $('phone-number').disabled = busy(); $('erase-number').disabled = busy();
    document.querySelectorAll('.dial-key').forEach(button => { button.disabled = busy(); });
    $('end-call').disabled = (!activeSession && !callLifecycle.current) || (activeSession && terminal(activeSession.status) && !cleanupPending) || ending;
    $('end-call-label').textContent = ending ? '正在结束…' : cleanupPending ? '重试挂断' : !activeSession && callLifecycle.current ? '取消准备' : '结束通话';
    $('mute-button').disabled = !sdkCall || sdkCall === incomingCall || ending;
    $('mute-button').setAttribute('aria-pressed', String(muted)); $('mute-button').querySelector('span').textContent = muted ? '取消静音' : '静音';
    $('call-hint').textContent = callLifecycle.current?.microphoneReady ? (muted ? '你的麦克风已静音' : '麦克风已就绪') : callLifecycle.current?.phase === 'microphone' ? '正在等待麦克风' : '麦克风未启用';
    const processing = callLifecycle.current?.microphoneProcessing;
    const processingState = value => value === true ? '已开启' : value === false ? '未开启' : '浏览器未报告';
    $('microphone-processing').textContent = processing
      ? `本次采音：回声消除${processingState(processing.echoCancellation)} · 降噪${processingState(processing.noiseSuppression)} · 自动音量${processingState(processing.autoGainControl)}`
      : '麦克风处理状态将在拨号或接听后显示。';
    if (sdkCall && callLifecycle.current?.microphoneReady && !muted && callDiagnostics?.volumeSeen) {
      $('call-hint').textContent = callDiagnostics.inputDetected ? '本次已检测到麦克风声音' : '尚未检测到麦克风声音（安静时正常）';
    }
    $('accept-call').disabled = !incomingCall || ending || Boolean(acceptingAttempt); $('reject-call').disabled = !incomingCall || ending;
    $('incoming-banner').hidden = !incomingCall;
    $('save-settings').disabled = !state || busy() || saving || verifying;
    $('verify-connections').disabled = !state || !configured || busy() || saving || verifying || state.connectionMaintenance;
    $('verify-connections').textContent = verifying ? '正在验证…' : '验证 API 连接';
    if (restoring && !busy()) {
      $('readiness-title').textContent = '电话线路正在自动恢复';
      $('readiness-copy').textContent = '后台正在恢复公网连接并核对电话回调，完成后即可拨号。';
    }
    scheduleRegistration();
    $('settings-fields').querySelectorAll('input').forEach(input => { input.disabled = busy() || saving; });
    $('export-current').disabled = !record?.lines.length;
    const currentState = activeSession?.status || (record?.endedAt ? record.status : '');
    const phase = callLifecycle.current?.phase;
    const phaseInstruction = phase === 'checking' && usesLocalVoice(translationEngine.snapshot.value)
      ? (usesPocketVoice(translationEngine.snapshot.value) ? '正在准备 Pocket 固定男声，首次可能需要约 2 分钟；准备好后才拨号' : '正在准备本人声线，首次可能需要约 2 分钟；准备好后才拨号')
      : callPhases[phase];
    const readiness = translationReadiness(activeSession);
    const translationRecovering = Boolean(activeSession && !terminal(currentState) && currentState !== 'ending' && !ending && recoveringTranslationRoles.size);
    if (readiness && !cleanupPending) {
      $('readiness-title').textContent = readiness.label;
      $('readiness-copy').textContent = readiness.instruction;
      if (translationRecovering || phase === 'reconnecting') {
        $('readiness-title').textContent = '正在恢复翻译连接';
        $('readiness-copy').textContent = '请暂停说话，等翻译就绪后再重说刚才未完成的一句。';
      }
    }
    const qualityWarning = currentState === 'active' && Boolean(callDiagnostics?.qualityWarnings.size);
    $('connection-text').textContent = cleanupPending ? '线路关闭待确认' : phase === 'reconnecting' ? '正在恢复音频连接' : translationRecovering ? '正在恢复翻译连接' : readiness && !readiness.ready ? readiness.label : qualityWarning ? '通话中 · 连接质量异常' : readiness?.label || statusNames[currentState] || '等待开始';
    $('connection-status').classList.toggle('active', readiness?.ready === true && !qualityWarning && !translationRecovering && phase !== 'reconnecting');
    document.body.classList.toggle('is-active', readiness?.ready === true);
    $('bridge-caption').textContent = phase === 'reconnecting' ? '音频恢复中，请暂停说话' : translationRecovering ? '翻译恢复中，请暂停说话' : readiness && !readiness.ready ? '请等翻译就绪后再说话' : readiness?.ready && translationRecoveryHint ? '已恢复，请重说刚才的一句' : readiness?.instruction || (phase === 'microphone' ? phaseInstruction : currentState === 'ringing' ? '正在呼叫对方，等待接听' : phaseInstruction || '连接后，听见彼此的语言');
    $('call-timer').textContent = timeText(duration());
    renderAudioOutput();
    renderMicrophoneInput();
    $('browser-playback').textContent = !callDiagnostics ? '浏览器接收与播放器状态将在通话时显示。' :
      `${callDiagnostics.outputDetected ? '本次已检测到接收声音' : '尚未检测到接收声音'} · ${callDiagnostics.playerState || '等待播放器状态'}`;
  }
  function renderTranslationEngine() {
    translationEngine.update({
      engines: state ? state.translationEngines : translationEngine.snapshot.available,
      session: activeSession || (incomingCall ? { translationEngine: 'legacy' } : null),
      locked: !state || busy() || enabling || saving || verifying,
    });
    const snapshot = translationEngine.snapshot;
    const select = $('translation-engine');
    for (const option of select.options) option.disabled = !snapshot.available.includes(option.value) && option.value !== snapshot.sessionEngine;
    select.value = snapshot.value; select.disabled = snapshot.locked;
    const preparingLocalVoice = usesLocalVoice(snapshot.value) && !activeSession && (verifying || (dialing && callLifecycle.current?.phase === 'checking'));
    $('translation-engine-status').textContent = preparingLocalVoice
      ? (usesPocketVoice(snapshot.value) ? '正在检查翻译与本机 Pocket 固定男声，首次准备可能需要约 2 分钟；尚未拨出，请等待。' : '正在检查翻译与本机本人声线，首次准备可能需要约 2 分钟；尚未拨出，请等待。')
      : snapshot.sessionEngine
      ? `本通电话使用：${translationEngineLabel(snapshot.sessionEngine)}。通话结束后才能换版本。`
      : snapshot.selected === 'pocket-prefix' ? '下一通使用 Pocket 边讲边播新测试版：已确认的短词组依次配音，后文继续接收；你听英文原声、看中英字幕。实际起声等待与衔接需测试，接通后最多 5 分钟。'
      : snapshot.selected === 'pocket-captions' ? '下一通：对方听 Michael 固定美式男声，完整英文小节确认后流式播放；你听英文原声、看中英字幕。本轮电话测试接通后最多 5 分钟，到时自动挂断。'
      : snapshot.selected === 'continuous-captions' ? '下一通使用连续直出＋中文字幕测试候选：对方听模型声音的连续英文；你听英文原声、看中英字幕。'
      : snapshot.selected === 'nano-captions' ? '下一通：你听英文原声、看中英字幕；对方听本人英文 B 版，逐句输出、稍慢且音量增强。'
      : snapshot.selected === 'continuous-nano' ? '下一通使用本人声线实验版。分句合成会增加等待，请用完整短句测试。'
      : snapshot.selected === 'continuous' ? '下一通使用连续翻译实验版。请与当前版本分两次通话比较效果。' : '下一通使用当前版本。';
    $('translation-engine-help').textContent = snapshot.value === 'pocket-prefix'
      ? '电脑中文 → 实时识别 → 已确认的英文短词组 → Pocket 固定美式男声流式播放。无需等整段讲完；否定、数字和时间仍需足够上下文。实际等待与短词组衔接待本轮验收，尚不保证 0.5–1 秒。回程保持英文原声与中英字幕。拨号前选择，通话中不能切换；来电保持当前版本。'
      : snapshot.value === 'pocket-captions'
      ? '电脑中文 → 手机英文采用 Pocket TTS 的 Michael 固定美式男声。译文按明确意思小节提交，声音生成一块就发送一块，后文继续接收。对方英文原声直接送到电脑，同步中英字幕，不生成中文声音；字幕故障不阻断原声。拨号前选择，通话中不能切换；来电保持当前版本。'
      : snapshot.value === 'continuous-captions'
      ? '电脑中文 → 手机英文使用模型声音，连续译音直接送到电话，不使用本人声线。回程保持英文原声直接送到电脑，同步中英字幕，不生成中文声音；字幕故障不阻断原声。请比较实际开始出声、持续跟随和句尾等待。拨号前选择，通话中不能切换；来电保持当前版本。'
      : snapshot.value === 'nano-captions'
      ? '你的英文采用 B 版：92% 语速，音量适度增强并限制峰值。有足够上下文的完整英文小节先合成、按顺序播放，后文继续接收；仍需等待模型听译与小节合成。对方英文原声直接送到电脑，同步中英字幕，不生成中文声音。字幕故障不阻断原声。拨号前选择，来电保持当前版本。'
      : snapshot.value === 'continuous-nano'
      ? '电脑中文 → 手机英文使用本机本人声线；对方英文 → 电脑中文保留连续翻译原声。等待完整译文句子后合成，会增加等待；无完整句尾时继续等候。拨号前选择，通话中不能切换；来电保持当前版本。'
      : '拨号前选择，通话中不能切换。用相同内容分两次拨打，比较实际听到的译音和等待。来电保持当前版本。';
    $('verification-engine').textContent = `验证版本：${translationEngineLabel(snapshot.value)}。在工作台的「本次翻译版本」中选择。`;
    const displayEngine = activeSession?.translationEngine || record?.translationEngine || snapshot.value;
    if (!record) $('transcript-subtitle').textContent = usesRemoteCaptions(displayEngine) ? '直接听英文原声，字幕用于辅助理解与排查' : '以双方实际听到的译音为准，文字仅用于辅助排查';
    $('transcript-engine-note').textContent = usesRemoteCaptions(displayEngine)
      ? '回程同时显示英文识别与中文字幕，草稿标为“更新中”；本模式始终显示英文原文。字幕辅助理解，可能修订或有误；听到的是对方英文原声，不是中文译音。'
      : displayEngine === 'continuous-nano'
      ? '本人声线版仅提供译文记录，不显示原文；手机英文由本机合成本人声线，电脑中文保留连续翻译原声。文字不代表声音已播放。'
      : displayEngine === 'continuous'
      ? '连续版目前仅提供译文记录，不显示原文；译音效果请双方实际听取。'
      : '当前版本可显示原文与译文；文字不能代替实际听感。';
    $('return-audio-label').textContent = usesRemoteCaptions(snapshot.value) ? 'English 原声 ＋ 中文字幕' : 'English → 中文';
    $('connection-mode-label').textContent = usesPocketVoice(snapshot.value) ? 'Pocket 固定男声 · 原声与字幕' : usesRemoteCaptions(snapshot.value) ? (usesNanoVoice(snapshot.value) ? '本人英文本音 · 原声与字幕' : '模型声音连续直出 · 原声与字幕') : '双向语音翻译';
    $('audio-delivery-heading').textContent = usesRemoteCaptions(displayEngine) ? '声音传送与字幕处理状态' : '译音传送状态与用时';
    renderCaptionStatus();
    renderAudioDelivery();
  }
  function renderCaptionStatus() {
    const visible = usesRemoteCaptions(activeSession?.translationEngine || record?.translationEngine || translationEngine.snapshot.value);
    const node = $('caption-status');
    node.hidden = !visible;
    if (!visible) { node.textContent = ''; return; }
    if (!activeSession) { node.textContent = record?.endedAt ? '通话已结束；以上字幕可能包含未定稿内容。' : '接通后单独显示字幕连接状态；英文原声无需等待字幕。'; return; }
    if (!eventsOnline) { node.textContent = '字幕状态连接恢复中；电话音频使用独立连接。'; return; }
    node.textContent = captionStatus?.state === 'failed'
      ? '中文字幕暂不可用；英文原声继续传送，通话仍可继续。'
      : captionStatus?.state === 'ready'
      ? '字幕连接已就绪 · 正在识别英文并翻译中文；“更新中”为未定稿。'
      : '字幕连接准备中 · 英文原声无需等待字幕。';
  }
  function renderAudioOutput(snapshot = audioOutput.snapshot) {
    const select = $('audio-output');
    const devices = snapshot.devices.length ? snapshot.devices : [{ deviceId: 'default', label: '系统默认输出' }];
    // Avoid rebuilding options on every call-volume update.
    const signature = JSON.stringify(devices);
    if (select.dataset.devices !== signature) {
      select.replaceChildren(...devices.map(item => { const option = element('option', '', item.label); option.value = item.deviceId; return option; }));
      select.dataset.devices = signature;
    }
    select.value = snapshot.selectedId || (snapshot.supported ? '' : 'default');
    select.disabled = !registered || busy() || enabling || !snapshot.supported || snapshot.status !== 'idle';
    $('test-audio-output').disabled = !registered || busy() || enabling || snapshot.status !== 'idle';
    $('audio-output-status').textContent = !registered ? '开启通话后，可选择耳机并试听；试听不会拨号。' : snapshot.message;
  }
  function renderMicrophoneInput(snapshot = microphoneInput.snapshot) {
    const select = $('microphone-input');
    const devices = [{ deviceId: '', label: '系统默认麦克风', available: true }, ...snapshot.devices];
    const signature = JSON.stringify(devices);
    if (select.dataset.devices !== signature) {
      select.replaceChildren(...devices.map(item => {
        const option = element('option', '', item.label); option.value = item.deviceId; option.disabled = !item.available; return option;
      }));
      select.dataset.devices = signature;
    }
    select.value = snapshot.selectedId;
    select.disabled = busy() || enabling || snapshot.status === 'refreshing';
    $('refresh-microphones').disabled = busy() || enabling || snapshot.status === 'refreshing';
    $('microphone-input-status').textContent = snapshot.message;
    $('microphone-actual').textContent = callLifecycle.current?.microphoneReady
      ? `本次实际采音：${callLifecycle.current.microphoneName || '浏览器未提供设备名称'}。`
      : '尚未启用麦克风；通话时显示实际采音设备。';
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
    return { id: session.id, number: session.direction === 'inbound' ? (session.from || '来电') : (session.to || ''), direction: session.direction, translationEngine: session.translationEngine || 'legacy', status: session.status, startedAt: Date.now(), connectedAt: session.status === 'active' ? Date.now() : null, endedAt: null, duration: 0, lines: [] };
  }
  function finishRecord(status) {
    if (!record || record.endedAt) return;
    record.duration = duration(); record.endedAt = Date.now(); record.status = status;
    if (preferences.saveHistory) { historyRecords = [structuredClone(record), ...historyRecords.filter(r => r.id !== record.id)].slice(0, 30); saveLocal(historyKey, historyRecords); }
    $('transcript-subtitle').textContent = `${translationEngineLabel(record.translationEngine)} · ${statusNames[status] || '通话已结束'} · ${record.lines.length ? '可导出文字记录' : '未收到文字记录'}`;
    renderHistory();
  }
  function clearSdkCall() {
    callDiagnostics?.disposePlayers?.();
    const attempt = callLifecycle.current;
    const wasIncoming = Boolean(incomingCall);
    const oldCall = sdkCall || incomingCall; sdkCall = null; callDiagnostics = null; incomingCall = null; acceptingAttempt = null; muted = false;
    try { if (wasIncoming && (!oldCall?.status || oldCall.status() === 'pending')) oldCall?.reject(); else oldCall?.disconnect(); } catch { /* Backend end state remains authoritative. */ }
    callLifecycle.cancel(attempt);
    if (attempt?.mediaOwner?.retireIfPending(attempt) && device === attempt.device) {
      // Destroy only this old Device. A later registration gets a fresh AudioHelper.
      cancelTokenRenewal();
      const oldDevice = device; device = null; deviceMediaOwner = null; registered = false;
      audioOutput.bind(null);
      clearInterval(heartbeat); heartbeat = null;
      try { oldDevice.destroy(); } catch { /* The stale owner remains retired. */ }
      presence(false).catch(() => {});
    }
  }
  function applySession(session) {
    if (session && (typeof session.id !== 'string' || typeof session.status !== 'string')) return;
    if (session && !terminal(session.status)) {
      if (session.id !== captionStatus?.sessionId) captionStatus = { sessionId: session.id, state: 'connecting' };
      if (usesRemoteCaptions(session.translationEngine) && ['connecting', 'ready', 'failed'].includes(session.captionState)) captionStatus.state = session.captionState;
    }
    if (!session || !terminal(session.status) && session.id !== activeSession?.id) {
      recoveringTranslationRoles.clear(); translationRecoveryHint = false;
    }
    if (session && terminal(session.status) && !requiresCleanup(session)) {
      if (activeSession?.id !== session.id && record?.id !== session.id) return;
      recoveringTranslationRoles.clear(); translationRecoveryHint = false;
      finishRecord(session.status); activeSession = null; dialing = false; ending = false; clearSdkCall();
      clearCleanupError();
      if (session.error) showError(callFailureMessage(session));
    } else if (session) {
      if (!record || record.id !== session.id) { if (record && !record.endedAt) finishRecord('completed'); audioDelivery.clear(); translationTiming.clear(); renderAudioDelivery(); record = makeRecord(session); transcriptRows.clear(); transcriptOrderEngine = null; $('transcript').replaceChildren(); $('empty-conversation').hidden = false; }
      activeSession = session; record.status = session.status; record.translationEngine = session.translationEngine || 'legacy';
      if (session.status === 'active' && !record.connectedAt) record.connectedAt = Date.now();
      $('transcript-subtitle').textContent = `${translationEngineLabel(record.translationEngine)} · ${session.direction === 'inbound' ? '来电' : '拨出'} · ${record.number} · ${statusNames[session.status] || session.status}`;
      if (incomingCall) $('incoming-number').textContent = session.from || '收到来电';
      if (requiresCleanup(session)) showError(errorMessages.CALL_CLEANUP_UNCONFIRMED);
    } else if (activeSession) {
      finishRecord('completed'); activeSession = null; dialing = false; ending = false; clearSdkCall();
      clearCleanupError();
    }
    renderStatus();
  }
  async function refreshStatus() {
    if (refreshPending) return refreshPending;
    refreshPending = (async () => {
      try {
        const next = await api('/api/status');
        if (disposed || localAccessRejected) return next;
        state = next; if (displayedErrorSource === 'local-connection') clearError();
        applySession(next.activeSession || null); renderChecks(); renderStatus(); connectEvents();
        if (desktopEngine && !busy()) {
          if (translationEngine.select(desktopEngine)) { desktopEngine = null; renderTranslationEngine(); }
        }
        return next;
      }
      catch (error) { state = null; renderStatus(); throw error; }
      finally { refreshPending = null; }
    })();
    return refreshPending;
  }
  function stopEvents() {
    clearTimeout(eventRetryTimer); eventRetryTimer = null;
    eventSource?.close(); eventSource = null;
  }
  function connectEvents() {
    if (!accessToken || eventSource || eventRetryTimer || eventRetriesExhausted || disposed || localAccessRejected) return;
    const source = new EventSource(`/api/events?token=${encodeURIComponent(accessToken)}`);
    eventSource = source;
    const current = () => eventSource === source && !disposed && !localAccessRejected;
    source.onopen = () => {
      if (!current()) return;
      eventRetryAttempt = 0; eventsOnline = true;
      if (displayedErrorSource === 'event-connection') { clearError(); toast('状态连接已恢复；断开期间的文字记录可能不完整。'); }
      renderStatus(); refreshStatus().catch(error => showError(error));
    };
    const receive = (name, handler) => source.addEventListener(name, event => {
      if (!current()) return;
      if (!event.data) return;
      try { handler(JSON.parse(event.data)); } catch { showError('收到的状态数据无法读取，正在重新检查。'); refreshStatus().catch(error => showError(error)); }
    });
    receive('snapshot', value => applySession(value.activeSession || null));
    receive('call', applySession);
    receive('transcript', appendTranscript);
    receive('caption-status', applyCaptionStatus);
    receive('translation-connection', applyTranslationConnection);
    receive('translation-audio', applyAudioDelivery);
    receive('translation-metric', applyTranslationTiming);
    receive('error', value => showError(cleanMessage(value.message || value.error, '通话服务报告错误，请检查连接状态。')));
    source.onerror = () => {
      if (!current()) return;
      eventsOnline = false; renderStatus();
      // CONNECTING streams already have browser-managed retry. CLOSED streams do not.
      if (source.readyState !== EventSource.CLOSED) return;
      source.close(); eventSource = null;
      const delay = [1000, 3000, 10000][eventRetryAttempt++] ?? (preferences.keepOnline ? 60000 : undefined);
      if (delay === undefined) {
        eventRetriesExhausted = true;
        showError({ message: '状态连接未能恢复，请点击「刷新状态」重试；电话音频使用独立连接，断开期间的文字记录可能不完整。', recoverableEventConnection: true });
        return;
      }
      eventRetryTimer = setTimeout(() => { eventRetryTimer = null; connectEvents(); }, delay);
    };
  }
  function applyCaptionStatus(value) {
    if (!value || !activeSession || !usesRemoteCaptions(activeSession.translationEngine) || value.sessionId !== activeSession.id || terminal(activeSession.status) || activeSession.status === 'ending') return;
    if (!['connecting', 'ready', 'failed'].includes(value.state)) return;
    captionStatus = { sessionId: value.sessionId, state: value.state };
    renderCaptionStatus();
  }
  function applyTranslationConnection(value) {
    if (!value || !activeSession || value.sessionId !== activeSession.id || terminal(activeSession.status) || activeSession.status === 'ending') return;
    if (!['local', 'remote'].includes(value.role) || !['disconnected', 'reconnecting', 'ready'].includes(value.state)) return;
    if (usesRemoteCaptions(activeSession.translationEngine) && value.role !== 'local') return;
    const diagnostic = { role: value.role, state: value.state };
    if (Number.isInteger(value.closeCode) && value.closeCode >= 1000 && value.closeCode <= 4999) diagnostic.closeCode = value.closeCode;
    console.info('[AI Phone Translation]', JSON.stringify(diagnostic));
    if (value.state === 'ready') {
      const recovered = recoveringTranslationRoles.delete(value.role);
      if (recovered && !recoveringTranslationRoles.size) translationRecoveryHint = true;
    } else {
      recoveringTranslationRoles.add(value.role); translationRecoveryHint = false;
    }
    renderStatus();
  }
  function renderAudioDelivery() {
    const engine = activeSession?.translationEngine || record?.translationEngine || translationEngine.snapshot.value;
    const captions = usesRemoteCaptions(engine);
    const ownVoice = usesNanoVoice(engine);
    const pocketVoice = usesPocketVoice(engine);
    const continuous = ownVoice || captions || engine === 'continuous';
    $('translation-timing-note').textContent = engine === 'pocket-prefix'
      ? '边讲边播按已确认的中文短词组翻译并合成固定男声，后文继续接收。识别累计计时从当前识别条目的首段文字出现开始，同一条目后续词组也从该时刻计，不是每个词组单独等待。英文生成计时为本词组提交到英文完成；首个有声数据包含合成排队。各项为最近一次记录，不能直接相加，也不包含此前识别、电话线路和耳机播放；不等于实际听见的等待。回程直接听英文原声、看中文字幕。'
      : pocketVoice
      ? 'Pocket 在完整英文小节确认后流式合成。分节等待从首个译文字开始计；首块数据可能含静音，首个有声数据按音量能量判定。各项分别显示最近一次记录；本机计时包含排队，小节输出完成还包含播放回压，不含此前模型听译，也不等于电话传输及设备播放用时，不等于实际听见的等待。回程直接听英文原声、看中文字幕。'
      : captions && !ownVoice
      ? '出程采用模型声音的连续英文译音，直接送到电话；回程保持英文原声与中英字幕。请比较实际开始出声、持续讲话落后和句尾等待；数据块数不代表已听清，本页尚无完整电话延迟测量。'
      : captions
      ? '出程本人英文 B 版按完整小节合成，后文继续翻译。分节等待从收到本小节首个译文字开始计；合成计时另含排队、变速和音量处理。两项均不包含此前模型听译、线路传输和播放，不能当作完整电话延迟。回程直接听英文原声、看中文字幕。'
      : ownVoice
      ? '本人声线等待完整译文句子后合成。合成耗时从句子提交到本机声音生成完成，含合成排队；不含此前等待分句、线路传输及播放，不等于实际电话延迟。回程中文使用连续翻译原声。'
      : continuous
      ? '连续版会边听边翻译，旧版逐句停说计时不适用。请比较实际开始出声、持续讲话落后和说完后的等待；数据块数不是句数，也不代表双方已经听清。'
      : '计时不含停顿判断、线路传输及设备播放，不等于实际听见的等待时间。线路确认播放后仍需双方检查实际听感。';
    for (const role of ['local', 'remote']) {
      if (captions && role === 'remote') {
        $('audio-delivery-remote').textContent = '英文原声 → 电脑：直接转发，不生成中文声音；实际接收声音请查看浏览器播放状态。';
        $('translation-timing-remote').textContent = '中文字幕：独立识别与翻译，不代表原声已经播放；本页尚无字幕延迟测量。';
        continue;
      }
      const counts = audioDelivery.get(role);
      const target = role === 'local' ? '英语 → 手机' : '中文 → 电脑';
      const unit = continuous ? '块' : '段';
      $(`audio-delivery-${role}`).textContent = !counts ? `${target}：尚无译音记录` :
        `${target}：生成 ${counts.generated} ${unit} · 已送出 ${counts.sent} ${unit} · 线路确认播放 ${counts.playback_confirmed} ${unit}${counts.unconfirmed ? ` · 未确认 ${counts.unconfirmed} ${unit}` : ''}${counts.silent ? ` · ${counts.silent} ${unit}未生成声音` : ''}`;
      const timing = translationTiming.get(role);
      const seconds = value => `${(value / 1000).toFixed(2)} 秒`;
      $(`translation-timing-${role}`).textContent = pocketVoice && role === 'local'
        ? `${target}：${timing?.sourceWaitMs !== undefined ? `识别条目首段文字 → 本词组确认 ${seconds(timing.sourceWaitMs)}（累计）；` : ''}${timing?.prefixTranslationMs !== undefined ? `英文生成 ${seconds(timing.prefixTranslationMs)}；` : ''}${timing?.sourceToSubmitMs !== undefined ? `识别条目首段文字 → 本词组提交配音 ${seconds(timing.sourceToSubmitMs)}（累计）；` : ''}${timing?.boundaryWaitMs !== undefined ? `最近一次分节等待 ${seconds(timing.boundaryWaitMs)}；` : ''}${timing?.firstChunkMs !== undefined ? `首块数据 ${seconds(timing.firstChunkMs)}；` : ''}${timing?.firstVoicedMs !== undefined ? `首个有声数据 ${seconds(timing.firstVoicedMs)}（能量判定）；` : ''}${timing?.synthesisCompleteMs !== undefined ? `小节输出完成 ${seconds(timing.synthesisCompleteMs)}（含排队与播放回压）；` : ''}${timing?.firstChunkMs !== undefined || timing?.firstVoicedMs !== undefined || timing?.synthesisCompleteMs !== undefined ? '配音计时含合成排队，不代表已听到' : engine === 'pocket-prefix' ? '等待短词组与流式合成计时' : '等待译文小节与流式合成计时'}`
        : ownVoice && role === 'local'
        ? `${target}：${timing?.boundaryWaitMs !== undefined ? `最近一次分节等待 ${seconds(timing.boundaryWaitMs)}；` : ''}${Number.isFinite(timing?.value) ? `本人声线合成 ${seconds(timing.value)}（含合成排队）` : captions ? '等待完整译文小节后合成本人声线，尚无合成计时' : '等待完整译文句子后合成本人声线，尚无合成计时'}`
        : continuous ? `${target}：${ownVoice ? '连续翻译原声' : '连续翻译'}，不使用旧版逐句停说计时` : !timing ? `${target}：尚无服务端计时` :
        `${target}最近一句：服务端停说事件 → 首个译音数据 ${seconds(timing.value)}` +
        (timing.parts ? `（等待转写 ${seconds(timing.parts[0])} · 等待发起 ${seconds(timing.parts[1])} · 生成首音 ${seconds(timing.parts[2])}）` : '（分项时间不可用）');
    }
  }
  function applyTranslationTiming(value) {
    if (!value || !activeSession || value.sessionId !== activeSession.id || terminal(activeSession.status) || activeSession.status === 'ending') return;
    if (usesPocketVoice(activeSession.translationEngine)) {
      if (value.role !== 'local' || !Number.isFinite(value.value) || value.value < 0 || !Number.isFinite(value.at)) return;
      const metrics = {
        ...(activeSession.translationEngine === 'pocket-prefix' ? {
          prefix_source_wait_ms: ['text_boundary', 'sourceWaitMs'],
          prefix_translation_ms: ['provider_generation', 'prefixTranslationMs'],
          prefix_source_to_submit_ms: ['text_boundary', 'sourceToSubmitMs'],
        } : {}),
        pocket_boundary_wait_ms: ['text_boundary', 'boundaryWaitMs'],
        pocket_text_to_first_chunk_ms: ['local_synthesis', 'firstChunkMs'],
        pocket_text_to_first_voiced_ms: ['local_synthesis', 'firstVoicedMs'],
        pocket_synthesis_complete_ms: ['local_synthesis', 'synthesisCompleteMs'],
      };
      const metric = Object.hasOwn(metrics, value.name) ? metrics[value.name] : null;
      if (!metric || value.scope !== metric[0]) return;
      const previous = translationTiming.get('local');
      const atKey = `${metric[1]}At`;
      if (previous?.[atKey] > value.at) return;
      translationTiming.set('local', { ...previous, [metric[1]]: value.value, [atKey]: value.at });
      renderAudioDelivery();
      return;
    }
    const ownVoice = usesNanoVoice(activeSession.translationEngine);
    if (activeSession.translationEngine === 'continuous' || (usesRemoteCaptions(activeSession.translationEngine) && !ownVoice)) return;
    if (ownVoice && value.role === 'local' && value.name === 'nano_boundary_wait_ms' && value.scope === 'text_boundary') {
      if (!Number.isFinite(value.value) || value.value < 0 || !Number.isFinite(value.at)) return;
      const previous = translationTiming.get('local');
      if (previous?.boundaryAt > value.at) return;
      translationTiming.set('local', { ...previous, boundaryWaitMs: value.value, boundaryAt: value.at });
      renderAudioDelivery();
      return;
    }
    if (ownVoice) {
      if (value.role !== 'local' || value.name !== 'nano_text_to_audio_ms' || value.scope !== 'local_synthesis') return;
    } else if (!['local', 'remote'].includes(value.role) || value.name !== 'speech_stop_to_first_audio_ms' || value.scope !== 'provider_generation') return;
    if (!Number.isFinite(value.value) || value.value < 0 || !Number.isFinite(value.at)) return;
    const previous = translationTiming.get(value.role);
    if (previous && value.at < previous.at) return;
    const parts = [value.transcriptionMs, value.queueMs, value.generationMs];
    const complete = !ownVoice && parts.every(part => Number.isFinite(part) && part >= 0) && Math.abs(parts.reduce((sum, part) => sum + part, 0) - value.value) < 1;
    translationTiming.set(value.role, { ...previous, value: value.value, at: value.at, parts: complete ? parts : null });
    renderAudioDelivery();
  }
  function applyAudioDelivery(value) {
    if (!value || !record || value.sessionId !== record.id || !['local', 'remote'].includes(value.role)) return;
    if (value.recipientRole !== (value.role === 'local' ? 'remote' : 'local')) return;
    if (!['generated', 'sent', 'playback_confirmed', 'unconfirmed'].includes(value.stage)) return;
    if (![value.generatedBytes, value.sentBytes].every(size => Number.isSafeInteger(size) && size >= 0)) return;
    const counts = audioDelivery.get(value.role) || { generated: 0, sent: 0, playback_confirmed: 0, unconfirmed: 0, silent: 0 };
    if (value.stage === 'generated' && value.generatedBytes === 0) counts.silent += 1;
    else counts[value.stage] += 1;
    audioDelivery.set(value.role, counts);
    renderAudioDelivery();
  }
  function renderLine(line, engine = record?.translationEngine) {
    const captionOriginal = usesRemoteCaptions(engine) && line.role === 'remote' && line.kind === 'original';
    // Keep paired English captions visible even when the general original-text preference is off.
    const article = element('article', `utterance ${line.role === 'remote' ? 'their' : 'mine'} ${line.kind === 'original' ? (captionOriginal ? 'caption-original-entry' : 'original-entry') : ''}`);
    article.dataset.transcriptId = line.id;
    const meta = element('div', 'utterance-meta');
    meta.append(element('strong', '', line.role === 'local' ? '你' : '对方'), element('span', '', line.kind === 'original' ? '原文' : '译文'), element('span', 'draft-label', line.final ? '' : '更新中'));
    const at = new Date(line.at); if (!Number.isNaN(at.getTime())) meta.append(element('time', '', at.toLocaleTimeString('zh-CN', { hour12: false })));
    const bubble = element('div', 'speech-bubble'); bubble.append(element('p', 'transcript-text', line.text)); article.append(meta, bubble); return article;
  }
  function orderedTranscriptLines(lines, engine) {
    const groups = new Map();
    for (const line of lines) {
      const match = /^(local|remote):(original|translation):([A-Za-z0-9_-]{1,256}):(0|[1-9]\d*)$/.exec(line.id);
      const key = match && match[1] === line.role && match[2] === line.kind ? `turn:${match[1]}:${match[3]}:${match[4]}` : `unpaired:${line.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(line);
    }
    const ordered = [...groups.entries()];
    if (usesRemoteCaptions(engine)) {
      const turnTime = group => Math.min(...group.map(line => new Date(line.at).getTime()).filter(Number.isFinite));
      const isCaption = ([key, group]) => key.startsWith('turn:remote:') && Number.isFinite(turnTime(group));
      const captions = ordered.filter(isCaption).sort((a, b) => turnTime(a[1]) - turnTime(b[1]));
      let captionIndex = 0;
      // ASR completions can arrive out of order. Reorder remote turn slots using
      // their stable source time while keeping local rows in their existing order.
      for (let index = 0; index < ordered.length; index += 1) {
        if (isCaption(ordered[index])) ordered[index] = captions[captionIndex++];
      }
    }
    // Other engines retain first-arrival order, including translation-before-ASR.
    return ordered.flatMap(([, group]) => group.sort((a, b) => Number(a.kind !== 'original') - Number(b.kind !== 'original')));
  }
  function appendTranscript(value) {
    if (!value || typeof value.id !== 'string' || typeof value.text !== 'string' || !['local', 'remote'].includes(value.role) || !['original', 'translation'].includes(value.kind)) return;
    if (!record || (value.sessionId && value.sessionId !== record.id)) return;
    if (usesRemoteCaptions(record.translationEngine) && value.role === 'remote' && value.final === true && !value.text.trim()) {
      const removed = transcriptRows.get(value.id);
      if (removed) {
        record.lines.splice(removed.index, 1); removed.node.remove(); transcriptRows.delete(value.id);
        for (let index = removed.index; index < record.lines.length; index += 1) transcriptRows.get(record.lines[index].id).index = index;
        // Removing a group's earliest timestamp can affect the next caption reorder.
        transcriptOrderEngine = null;
      }
      $('empty-conversation').hidden = record.lines.length > 0;
      $('export-current').disabled = record.lines.length === 0;
      return;
    }
    if (translationRecoveryHint && value.kind === 'translation' && value.final === true && (!usesRemoteCaptions(activeSession?.translationEngine) || value.role === 'local')) { translationRecoveryHint = false; renderStatus(); }
    const line = { id: value.id, role: value.role, kind: value.kind, text: value.text.slice(0, 20000), final: value.final === true, at: value.at || new Date().toISOString() };
    const previous = transcriptRows.get(line.id);
    const oldLine = previous && record.lines[previous.index];
    const captionMode = usesRemoteCaptions(record.translationEngine);
    // Ordering depends on membership, id, role, kind and source time; text/final
    // changes can replace one indexed row without scanning or sorting the history.
    const sameCaptionOrder = previous && transcriptOrderEngine === record.translationEngine
      && oldLine.role === line.role && oldLine.kind === line.kind && oldLine.at === line.at;
    const index = previous ? previous.index : record.lines.length;
    if (previous) record.lines[index] = line; else record.lines.push(line);
    const scroll = $('transcript-scroll'); const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
    const node = renderLine(line);
    transcriptRows.set(line.id, { index, node });
    if (previous) previous.node.replaceWith(node);
    else if (captionMode) $('transcript').append(node);
    else {
      const ordered = orderedTranscriptLines(record.lines, record.translationEngine);
      const next = ordered[ordered.findIndex(item => item.id === line.id) + 1];
      $('transcript').insertBefore(node, next ? transcriptRows.get(next.id).node : null);
    }
    if (captionMode && !sameCaptionOrder) {
      const children = [...$('transcript').children];
      const ordered = orderedTranscriptLines(record.lines, record.translationEngine).map(item => transcriptRows.get(item.id).node);
      if (ordered.some((node, index) => node !== children[index])) $('transcript').replaceChildren(...ordered);
    }
    transcriptOrderEngine = record.translationEngine;
    $('empty-conversation').hidden = true;
    if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
    $('export-current').disabled = false;
  }
  async function presence(available) { if (accessToken) await post('/api/presence', { available }); }
  function cancelTokenRenewal() {
    const old = tokenRenewal; tokenRenewal = null;
    clearTimeout(old?.timer); old?.controller?.abort();
  }
  function renewDeviceToken(next) {
    if (device !== next || disposed || localAccessRejected || tokenRenewal?.device === next) return;
    cancelTokenRenewal();
    const renewal = { device: next, attempts: 0, timer: null, controller: null };
    tokenRenewal = renewal;
    const current = () => device === next && tokenRenewal === renewal && !disposed;
    const run = async () => {
      if (!current() || localAccessRejected) return;
      renewal.attempts += 1;
      renewal.controller = new AbortController();
      try {
        // Three bounded attempts fit within the 60-second SDK expiry warning.
        const fresh = await api('/api/token', { signal: renewal.controller.signal }, 8000, current);
        if (!current() || localAccessRejected) return;
        if (typeof fresh?.token !== 'string' || !fresh.token) throw new Error('INVALID_TOKEN_RESPONSE');
        next.updateToken(fresh.token);
        cancelTokenRenewal();
        logSdkEvent('device-token-renewed');
      } catch (error) {
        if (!current()) return;
        if (!localAccessRejected && renewal.attempts < 3) {
          renewal.timer = setTimeout(run, [1000, 3000][renewal.attempts - 1]);
          return;
        }
        showError(localAccessRejected ? rejectedAccessMessage : '电话访问凭据续期失败，请结束当前通话后重新开启通话。');
        logSdkEvent('device-token-renewal-failed');
        if (!busy() && current()) await destroyDevice();
      }
    };
    run();
  }
  async function destroyDevice() {
    cancelTokenRenewal();
    clearInterval(heartbeat); heartbeat = null; registered = false;
    const oldDevice = device; device = null; deviceMediaOwner = null;
    audioOutput.bind(null);
    try { await oldDevice?.unregister(); } catch { /* Still destroy locally. */ }
    try { oldDevice?.destroy(); } catch { /* Already destroyed. */ }
    await presence(false).catch(() => {}); renderStatus();
  }
  function scheduleRegistration() {
    if (!preferences.keepOnline || registrationRetryTimer || registered || enabling || disposed || localAccessRejected || !accessToken || !state?.configured || state.connectionMaintenance || busy()) return;
    const delay = [0, 1000, 3000, 10000, 30000, 60000][Math.min(registrationRetryAttempt++, 5)];
    registrationRetryTimer = setTimeout(() => {
      registrationRetryTimer = null;
      if (preferences.keepOnline && !registered && !busy() && !disposed && !localAccessRejected) enableDevice({ automatic: true });
    }, delay);
  }
  async function enableDevice({ automatic = false } = {}) {
    if (busy() || enabling) return;
    if (automatic && (!preferences.keepOnline || registered || disposed || localAccessRejected)) return;
    clearError();
    if (registered) {
      preferences.keepOnline = false; saveLocal(preferencesKey, preferences);
      clearTimeout(registrationRetryTimer); registrationRetryTimer = null;
      enableEpoch += 1;
      await destroyDevice(); return;
    }
    clearTimeout(registrationRetryTimer); registrationRetryTimer = null;
    const epoch = ++enableEpoch;
    const current = () => epoch === enableEpoch && !disposed && !localAccessRejected && (!automatic || preferences.keepOnline);
    enabling = true; renderStatus();
    try {
      await refreshStatus();
      if (!current()) return;
      if (!state.configured) throw new Error('请先完成连接设置。');
      if (!window.Twilio?.Device) throw new Error('电话组件尚未加载，请重新启动桌面工作台。');
      if (device) await destroyDevice();
      const data = await api('/api/token');
      if (!current()) return;
      // Official DeviceOptions.getUserMedia receives constraints and returns Promise<MediaStream>.
      // https://www.twilio.com/docs/voice/sdks/javascript/twiliodevice#deviceoptions
      const mediaOwner = createDeviceMediaOwner(callLifecycle);
      const next = new window.Twilio.Device(data.token, {
        logLevel: 'silent', tokenRefreshMs: 60000, closeProtection: true,
        enableImprovedSignalingErrorPrecision: true,
        // Preserve the original edge during the SDK's supported signaling recovery window.
        // https://www.twilio.com/docs/voice/sdks/javascript/edges#edge-fallback-and-signaling-reconnection
        maxCallSignalingTimeoutMs: 30000,
        getUserMedia: constraints => mediaOwner.getUserMedia(constraints),
      });
      device = next; deviceMediaOwner = mediaOwner;
      let registrationCompleted = false;
      audioOutput.bind(next.audio || null);
      next.on('registered', () => {
        if (device !== next || disposed || localAccessRejected || !registrationCompleted && !current()) return; registrationCompleted = true; registered = true; registrationRetryAttempt = 0; clearTimeout(registrationRetryTimer); registrationRetryTimer = null; clearInterval(heartbeat);
        logSdkEvent('device-registered', null, null, readDeviceEdge(next)); audioOutput.refresh();
        presence(true).catch(error => showError(error.message));
        heartbeat = setInterval(() => presence(true).catch(error => showError(error.message)), 15000); renderStatus();
      });
      next.on('unregistered', () => { if (device !== next) return; logSdkEvent('device-unregistered'); registered = false; clearInterval(heartbeat); presence(false).catch(() => {}); renderStatus(); });
      next.on('tokenWillExpire', () => renewDeviceToken(next));
      next.on('error', error => { if (device !== next) return; logSdkEvent('device-error', error); showError(sdkFailureMessage(error)); });
      next.on('incoming', receiveIncoming);
      await next.register();
      if (!current() && device === next) await destroyDevice();
    } catch (error) { if (current()) { showError(error); await destroyDevice(); } }
    finally { enabling = false; renderStatus(); }
  }
  function bindCall(call, attempt) {
    audioOutput.cancelTest();
    sdkCall = call;
    const diagnostics = { volumeSeen: false, inputDetected: false, outputDetected: false, playerState: '', qualityWarnings: new Set() };
    const rtcWindow = createRtcDiagnostics();
    callDiagnostics = diagnostics;
    // Public SDK audio event; do not restart SDK-managed or retired audio elements.
    // https://www.twilio.com/docs/voice/sdks/javascript/twiliocall#audio-event
    const players = new Map();
    diagnostics.disposePlayers = () => {
      for (const [player, update] of players) for (const name of ['playing', 'pause', 'volumechange', 'error', 'ended']) player.removeEventListener(name, update);
      players.clear();
      rtcWindow.reset();
    };
    call.on('audio', player => {
      if (sdkCall !== call || !callLifecycle.isCurrent(attempt) || players.has(player)) return;
      const update = () => {
        if (sdkCall !== call || !callLifecycle.isCurrent(attempt)) return;
        // SDK may retire a temporary player after moving its master to the selected sink.
        const all = [...players.keys()];
        diagnostics.playerState = all.some(item => !item.error && !item.paused && !item.muted && item.volume > 0)
          ? '播放器处于播放状态（仍需确认耳机听感）' : all.some(item => !item.error && !item.paused)
            ? '播放器已静音' : all.some(item => !item.error) ? '播放器暂停，尚未播放' : '播放器发生错误';
        renderStatus();
      };
      players.set(player, update);
      for (const name of ['playing', 'pause', 'volumechange', 'error', 'ended']) player.addEventListener(name, update);
      update();
    });
    // SDK volume is 0..1; the threshold only reports observed sound, not speech or working delivery.
    call.on('volume', (input, output) => {
      if (sdkCall !== call || !callLifecycle.isCurrent(attempt)) return;
      const wasSeen = diagnostics.volumeSeen; const wasDetected = diagnostics.inputDetected; const outputWasDetected = diagnostics.outputDetected;
      rtcWindow.addVolume(input, output);
      if (Number.isFinite(input) && input >= 0 && input <= 1) {
        diagnostics.volumeSeen = true;
        if (!muted && input > 0.01) diagnostics.inputDetected = true;
      }
      if (Number.isFinite(output) && output >= 0 && output <= 1) {
        if (output > 0.01) diagnostics.outputDetected = true;
      }
      if (wasSeen !== diagnostics.volumeSeen || wasDetected !== diagnostics.inputDetected || outputWasDetected !== diagnostics.outputDetected) renderStatus();
    });
    call.on('sample', sample => {
      if (sdkCall !== call || !callLifecycle.isCurrent(attempt)) return;
      // Every SDK one-second delta contributes; raw stats never leave this handler.
      const entry = rtcWindow.addSample(sample, readDeviceEdge(attempt.device));
      if (entry) console.info('[AI Phone RTC]', JSON.stringify(entry));
    });
    call.on('accept', () => { if (sdkCall !== call || !callLifecycle.isCurrent(attempt)) return; logSdkEvent('call-accepted'); incomingCall = null; callLifecycle.update(attempt, { phase: 'connected' }); renderStatus(); refreshStatus().catch(error => showError(error)); });
    call.on('reconnecting', error => { if (sdkCall === call) { logSdkEvent('call-reconnecting', error); callLifecycle.update(attempt, { phase: 'reconnecting' }); } });
    call.on('reconnected', () => { if (sdkCall === call) { logSdkEvent('call-reconnected'); callLifecycle.update(attempt, { phase: 'connected' }); } });
    call.on('warning', warning => {
      if (sdkCall !== call || !sdkWarnings.has(warning)) return;
      logSdkEvent('call-warning', null, warning);
      if (sdkQualityWarnings.has(warning)) { diagnostics.qualityWarnings.add(warning); renderStatus(); }
    });
    call.on('warning-cleared', warning => {
      if (sdkCall !== call || !sdkWarnings.has(warning)) return;
      logSdkEvent('call-warning-cleared', null, warning);
      if (diagnostics.qualityWarnings.delete(warning)) renderStatus();
    });
    call.on('mute', value => { if (sdkCall !== call) return; muted = value === true; renderStatus(); });
    for (const event of ['disconnect', 'cancel', 'reject']) call.on(event, () => {
      if (sdkCall !== call && incomingCall !== call) return;
      logSdkEvent(`call-${event}`);
      diagnostics.disposePlayers();
      sdkCall = null; incomingCall = null; muted = false;
      callLifecycle.cancel(attempt);
      endCall(attempt).catch(error => showError(error.message)); renderStatus();
    });
    call.on('error', error => {
      if (sdkCall !== call && incomingCall !== call) return;
      logSdkEvent('call-error', error);
      showError(microphoneMessages[attempt?.failureCode] || sdkFailureMessage(error));
      endCall(attempt).catch(error => showError(error.message));
    });
  }
  function receiveIncoming(call) {
    if (sdkCall || incomingCall || dialing || ending || audioOutput.snapshot.status === 'selecting') { call.reject(); return; }
    const attempt = callLifecycle.begin(activeSession?.id || null);
    Object.assign(attempt, { direction: 'inbound', device, mediaOwner: deviceMediaOwner });
    incomingCall = call; bindCall(call, attempt);
    $('incoming-number').textContent = call.customParameters?.get('from') || call.parameters?.From || activeSession?.from || '收到来电';
    navigate('workspace'); renderStatus(); refreshStatus().catch(error => showError(error));
  }
  async function startCall() {
    if (busy() || !registered || !eventsOnline || saving || verifying || enabling || translationEngine.snapshot.locked || audioOutput.snapshot.status !== 'idle') return;
    const to = $('phone-number').value.replace(/[\s()-]/g, '');
    if (!/^\+[1-9]\d{6,14}$/.test(to)) { $('phone-error').textContent = '请输入含国家区号的号码，例如 +1 加十位美国号码。'; $('phone-number').setAttribute('aria-invalid', 'true'); $('phone-number').focus(); return; }
    const chosenEngine = translationEngine.snapshot.selected;
    dialing = true; clearError(); renderStatus();
    const attempt = callLifecycle.begin();
    const attemptDevice = device;
    Object.assign(attempt, { direction: 'outbound', device: attemptDevice, mediaOwner: deviceMediaOwner });
    let createdId = null;
    try {
      // Permission and device acquisition finish before creating any server-side call.
      const constraints = await microphoneInput.constraints();
      if (!callLifecycle.isCurrent(attempt)) return;
      await callLifecycle.prepareMicrophone(attempt, constraints);
      if (!callLifecycle.isCurrent(attempt)) return;
      audioOutput.refresh();
      callLifecycle.update(attempt, { phase: 'checking' });
      const created = await post('/api/calls', { to, translationEngine: chosenEngine }, usesLocalVoice(chosenEngine) ? 150000 : undefined); createdId = created.id;
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
      const constraints = await microphoneInput.constraints();
      if (incomingCall !== call || !callLifecycle.isCurrent(attempt)) return;
      await callLifecycle.prepareMicrophone(attempt, constraints);
      if (incomingCall !== call || !callLifecycle.isCurrent(attempt)) { callLifecycle.cancel(attempt); return; }
      audioOutput.refresh();
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
    const captions = usesRemoteCaptions(item.translationEngine);
    const ownVoice = usesNanoVoice(item.translationEngine);
    const pocketVoice = usesPocketVoice(item.translationEngine);
    const engineNotes = captions
      ? [`电脑中文 → 手机英文使用${pocketVoice ? 'Pocket TTS 的 Michael 固定美式男声，按译文小节流式合成' : ownVoice ? '本机本人声线' : '模型声音的连续译音，直接送到电话'}；对方英文原声直接送到电脑，不生成中文声音。`, '回程英文识别与中文字幕由独立字幕分支生成；未定稿内容可能修订，字幕可能晚于原声或存在错误。']
      : item.translationEngine === 'continuous-nano'
      ? ['本人声线版未开启原文转写，此记录仅包含服务返回的译文。', '电脑中文 → 手机英文使用本机本人声线；对方英文 → 电脑中文保留连续翻译原声。分句合成会增加等待。']
      : item.translationEngine === 'continuous' ? ['连续版未开启原文转写，此记录仅包含服务返回的译文。'] : [];
    const audioNote = captions ? `文字用于辅助理解与排查，不代表声音已播放；电脑听英文原声，手机听${pocketVoice ? 'Michael 固定美式男声' : ownVoice ? '本人英文本音' : '模型声音的连续英文译音'}。` : '文字仅用于辅助排查；以双方实际听到的译音为准。';
    const text = ['AI 电话 — 通话文字记录', `翻译版本：${translationEngineLabel(item.translationEngine)}`, `方向：${item.direction === 'inbound' ? '来电' : '拨出'}`, `号码：${item.number}`, `时间：${dateText(item.startedAt)}`, `页面观察时长：${timeText(duration(item))}`, audioNote, ...engineNotes, '', ...orderedTranscriptLines(item.lines, item.translationEngine).map(line => `[${line.role === 'local' ? '你' : '对方'} · ${line.kind === 'original' ? '原文' : '译文'}${line.final ? '' : ' · 未定稿'}] ${line.text}`)].join('\r\n');
    const url = URL.createObjectURL(new Blob(['\uFEFF', text], { type: 'text/plain;charset=utf-8' }));
    const link = element('a'); link.href = url; link.download = `AI电话-通话记录-${new Date(item.startedAt).toISOString().replace(/[:.]/g, '-')}.txt`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  function renderHistory() {
    $('history-count').textContent = historyRecords.length; $('clear-history').disabled = !historyRecords.length; $('history-list').replaceChildren();
    if (!historyRecords.some(r => r.id === selectedHistory)) selectedHistory = historyRecords[0]?.id || null;
    for (const item of historyRecords) {
      const button = element('button', 'history-item'); button.classList.toggle('selected', item.id === selectedHistory); button.setAttribute('aria-pressed', String(item.id === selectedHistory));
      button.append(element('strong', '', item.number), element('small', '', `${translationEngineLabel(item.translationEngine)} · ${item.direction === 'inbound' ? '来电' : '拨出'} · ${statusNames[item.status] || '已结束'}`));
      const meta = element('div', 'history-meta'); meta.append(element('span', '', dateText(item.startedAt)), element('span', '', timeText(item.duration))); button.append(meta);
      button.addEventListener('click', () => { selectedHistory = item.id; renderHistory(); }); $('history-list').append(button);
    }
    $('history-detail').replaceChildren(); const item = historyRecords.find(r => r.id === selectedHistory);
    if (!item) { const empty = element('div', 'empty-conversation'); empty.append(icon('clock'), element('h3', '', '还没有保存的通话'), element('p', '', '可在连接设置中开启「保存通话文字」。')); $('history-detail').append(empty); return; }
    const heading = element('div', 'detail-heading'); const title = element('div'); title.append(element('h2', '', item.number), element('p', '', `${dateText(item.startedAt)} · ${translationEngineLabel(item.translationEngine)} · 普通话 ↔ English`));
    const download = element('button', 'secondary-button', '导出文字'); download.disabled = !item.lines.length; download.addEventListener('click', () => exportRecord(item)); heading.append(title, download);
    $('history-detail').append(heading, ...orderedTranscriptLines(item.lines, item.translationEngine).map(line => renderLine(line, item.translationEngine)));
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
    if (verifying || busy() || saving || !state?.configured) return;
    const chosenEngine = translationEngine.snapshot.selected;
    verifying = true; $('verification-results').replaceChildren(element('p', 'form-intro', usesRemoteCaptions(chosenEngine)
      ? (usesPocketVoice(chosenEngine) ? '正在验证电话配置、出程翻译、回程字幕和 Pocket 固定男声；首次预热可能需要约 2 分钟，请等待。' : usesNanoVoice(chosenEngine) ? '正在验证电话配置、出程翻译、回程字幕和本机声线；首次预热可能需要约 2 分钟，请等待。' : '正在验证电话配置、模型声音连续直出和回程字幕连接，请等待。')
      : chosenEngine === 'continuous-nano'
      ? '正在验证本人声线实验版的电话配置、双向翻译连接和本机声线；首次预热可能需要约 2 分钟，请等待。'
      : `正在验证${translationEngineLabel(chosenEngine)}的账户、号码、电话应用与翻译连接…`)); renderStatus();
    try {
      const result = await post('/api/verify', { translationEngine: chosenEngine }, usesLocalVoice(chosenEngine) ? 150000 : undefined);
      const verifiedEngine = result.translationEngine || 'legacy';
      $('verification-results').replaceChildren(element('p', 'form-intro', `本次验证结果：${translationEngineLabel(verifiedEngine)}`));
      if (verifiedEngine !== chosenEngine) $('verification-results').append(element('p', 'field-error', '服务返回的版本与本次选择不同，所选版本尚未确认；请刷新并重新验证。'));
      const labels = { twilioAccount: 'Twilio 账户', twilioNumber: 'Twilio 号码', twilioApplication: '电话应用', openaiRealtime: '当前版翻译连接', openaiContinuous: '连续翻译连接（双向）', nanoTranslation: '本人声线与双向连续翻译', nanoVoice: '本机本人声线', nanoCaptions: '本人声线、出程翻译与回程字幕', pocketVoice: '本机 Pocket 固定男声', pocketCaptions: 'Pocket 男声、出程翻译与回程字幕', continuousCaptions: '连续直出翻译与回程字幕', openaiRemoteCaption: '回程英文识别与中文字幕', openaiTranscription: '英文实时识别', captionTranslation: '中文字幕翻译' };
      for (const check of result.checks || []) {
        const row = element('div', 'config-check'); row.append(element('span', '', labels[check.name] || check.name), element('span', `check-state ${check.status === 'passed' ? 'ready' : 'needs-attention'}`, { passed: '连接验证通过', failed: '验证未通过', missing: '缺少配置' }[check.status] || '待检查'));
        if (check.code) row.title = cleanMessage(String(check.code)); $('verification-results').append(row);
      }
      $('verification-results').append(element('p', 'form-intro', usesRemoteCaptions(verifiedEngine)
        ? (usesPocketVoice(verifiedEngine) ? '本次仅验证连接与 Pocket 固定男声预热；仍需真实电话确认开始出声、持续跟随、漏词及声线听感，以及回程英文原声和中英字幕。本轮电话测试接通后最多 5 分钟，到时自动挂断。' : usesNanoVoice(verifiedEngine) ? '本次仅验证连接与本机声线就绪；仍需真实电话确认英文原声、字幕准确度与延迟，以及出程本人声线听感。' : '本次仅验证连接；仍需真实电话确认模型声音连续直出的准确度与等待，以及回程英文原声和中英字幕。')
        : verifiedEngine === 'continuous-nano'
        ? '本次仅验证翻译连接和本机声线就绪。仍需真实电话确认两个语言方向、本人声线听感与端到端延迟。'
        : '本次仅验证 API 连接。仍需真实电话确认两个语言方向、听感与端到端延迟。'));
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
  $('keep-online-toggle').addEventListener('click', () => {
    preferences.keepOnline = !preferences.keepOnline; saveLocal(preferencesKey, preferences);
    registrationRetryAttempt = 0;
    if (!preferences.keepOnline) { enableEpoch += 1; clearTimeout(registrationRetryTimer); registrationRetryTimer = null; }
    renderStatus();
  });
  $('translation-engine').addEventListener('change', () => {
    if (translationEngine.select($('translation-engine').value)) {
      $('verification-results').replaceChildren(element('p', 'form-intro', `已切换为${translationEngineLabel(translationEngine.snapshot.selected)}，请重新验证此版本；其他版本的结果不能代替。`));
    }
    renderStatus();
  });
  $('accept-call').addEventListener('click', acceptCall); $('reject-call').addEventListener('click', rejectCall);
  $('audio-output').addEventListener('change', async () => { if (!registered || busy()) return; const pending = audioOutput.select($('audio-output').value); renderStatus(); await pending; renderStatus(); });
  $('microphone-input').addEventListener('change', () => { if (busy() || enabling) return; microphoneInput.select($('microphone-input').value); renderStatus(); });
  $('refresh-microphones').addEventListener('click', async () => { if (busy() || enabling) return; await microphoneInput.refresh(); renderStatus(); });
  $('test-audio-output').addEventListener('click', async () => { if (!registered || busy()) return; const pending = audioOutput.test(); renderStatus(); await pending; renderStatus(); });
  $('mute-button').addEventListener('click', () => { if (!sdkCall || sdkCall === incomingCall) return; try { const nextMuted = !muted; sdkCall.mute(nextMuted); muted = nextMuted; renderStatus(); } catch { showError('未能切换麦克风状态，请检查通话连接。'); } });
  $('erase-number').addEventListener('click', () => { if (!busy()) { $('phone-number').value = $('phone-number').value.slice(0, -1); $('phone-number').focus(); } });
  $('phone-number').addEventListener('input', () => { $('phone-error').textContent = ''; $('phone-number').removeAttribute('aria-invalid'); });
  $('phone-number').addEventListener('keydown', event => { if (event.key === 'Enter') startCall(); });
  $('export-current').addEventListener('click', () => exportRecord(record));
  $('refresh-status').addEventListener('click', () => {
    if (!eventSource) { clearTimeout(eventRetryTimer); eventRetryTimer = null; eventRetryAttempt = 0; eventRetriesExhausted = false; }
    return refreshStatus().then(() => toast('已重新检查本机配置。')).catch(error => showError(error));
  });
  $('settings-form').addEventListener('submit', saveSettings); $('verify-connections').addEventListener('click', verifyConnections);
  $('help-button').addEventListener('click', () => $('help-dialog').showModal()); $('close-help').addEventListener('click', () => $('help-dialog').close()); $('help-start').addEventListener('click', () => { $('help-dialog').close(); navigate('workspace'); });
  $('clear-history').addEventListener('click', () => $('clear-dialog').showModal()); $('cancel-clear').addEventListener('click', () => $('clear-dialog').close());
  $('confirm-clear').addEventListener('click', () => { historyRecords = []; selectedHistory = null; saveLocal(historyKey, historyRecords); renderHistory(); $('clear-dialog').close(); });
  for (const [id, key] of [['save-history-toggle', 'saveHistory'], ['show-original-toggle', 'showOriginal']]) $(id).addEventListener('click', () => { preferences[key] = !preferences[key]; saveLocal(preferencesKey, preferences); applyPreferences(); });
  window.addEventListener('beforeunload', event => { if (busy()) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', () => {
    disposed = true; enableEpoch += 1; clearTimeout(registrationRetryTimer); registrationRetryTimer = null; clearInterval(heartbeat); stopEvents(); cancelTokenRenewal();
    transcriptRows.clear(); transcriptOrderEngine = null;
    audioOutput.bind(null);
    microphoneInput.dispose();
    callLifecycle.cancel();
    // Best effort only; server-side presence expiry and call lifecycle are authoritative.
    if (accessToken) fetch('/api/presence', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` }, body: JSON.stringify({ available: false }) }).catch(() => {});
    try { device?.destroy(); } catch { /* Navigation continues. */ }
  });
  renderSettingsForm(); applyPreferences(); renderHistory(); renderStatus(); renderAudioDelivery();
  setInterval(() => { $('call-timer').textContent = timeText(duration()); }, 1000);
  microphoneInput.refresh();
  setInterval(() => { if (accessToken && !localAccessRejected && !disposed) refreshStatus().catch(error => showError(error)); }, 10000);
  if (!accessToken) { showError(missingAccessMessage); navigate('settings'); }
  else refreshStatus().then(next => { if (!next.configured) navigate('settings'); }).catch(error => { showError(error); navigate('settings'); });
})().catch(() => {
  const banner = document.getElementById('app-error');
  if (banner) { banner.textContent = '电话组件加载失败。请从桌面「AI 电话」重新打开；仍未恢复时请重启本机服务。'; banner.hidden = false; }
  const view = document.getElementById('workspace-view'); if (view) view.hidden = false;
  for (const id of ['enable-device', 'start-call', 'accept-call']) { const button = document.getElementById(id); if (button) button.disabled = true; }
});
