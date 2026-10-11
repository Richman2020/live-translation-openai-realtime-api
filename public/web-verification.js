// A separate login-only surface. It imports no phone, media or controller code.
// Session CSRF stays in this closure; it is never stored or rendered.
const stateListeners = new Set();
let latestPublicState = null;

// The browser-only workbench observes authentication without receiving its proof.
export function observeWebVerificationState(listener) {
  if (typeof listener !== 'function') return () => {};
  stateListeners.add(listener);
  if (latestPublicState) {
    try { listener({ ...latestPublicState }); } catch { /* UI cannot interrupt authentication. */ }
  }
  return () => stateListeners.delete(listener);
}

function publishPublicState(state) {
  latestPublicState = { phase: state.phase, authenticated: state.authenticated, expiresAt: state.expiresAt };
  for (const listener of stateListeners) {
    try { listener({ ...latestPublicState }); } catch { /* UI cannot interrupt authentication. */ }
  }
}

export function startWebVerification() {
  const $ = id => document.getElementById(id);
  // The server selects a fixed HTML surface. This value only narrows which
  // calls-disabled status the page accepts; URLs and requests cannot select it.
  const expectedMode = document.documentElement.dataset.serviceMode;
  const validMode = expectedMode === 'web-verification' || expectedMode === 'web-workbench';
  const dailyWorkbench = expectedMode === 'web-workbench';
  const state = { phase: 'checking', loginAvailable: false, authenticated: false,
    csrfToken: '', expiresAt: 0, error: '', message: '电话功能保持关闭。' };
  let generation = 0;
  let operation = null;
  let disposed = false;
  let activity = null;
  let logoutRequested = false;
  let pendingLogoutCsrf = '';
  let logoutNeedsReload = false;
  const pending = () => Boolean(operation);
  const messages = {
    checking: ['正在检查登录', '请稍候，正在读取会话状态。', dailyWorkbench ? '正在检查工作台服务。' : '正在检查网页验收服务。'],
    'signed-out': ['尚未登录', '使用服务端允许的 Google 工作账号登录。', '网页登录尚未确认。'],
    authenticated: ['已登录', '服务端已验证本次 Google 登录。', '网页登录与会话状态已确认；电话功能关闭。'],
    expired: ['登录已失效', '本次会话已失效，请重新登录。', '会话失效；电话功能保持关闭。'],
    offline: ['登录状态待确认', '网络离线，恢复连接后请检查状态。', '网络离线；网页状态未确认。'],
    unavailable: ['登录状态待确认', '当前无法确认登录，请刷新状态后重试。', dailyWorkbench ? '工作台状态未确认。' : '网页验收状态未确认。'],
    'login-pending': ['正在准备 Google 登录', '请等待登录跳转，也可以取消。', '登录尚未完成；电话功能关闭。'],
    cancelling: ['正在取消登录', '等待服务端确认取消。', '登录取消待确认；电话功能关闭。'],
    'logging-out': ['正在退出登录', '等待服务端确认退出。', '退出尚未确认；电话功能关闭。'],
    renewing: ['正在延长登录会话', '等待服务端确认新的会话期限。', '正在检查新的会话期限；电话功能关闭。'],
  };
  const text = (id, value) => { $(id).textContent = value; };
  function clearSession() { state.authenticated = false; state.csrfToken = ''; state.expiresAt = 0; }
  function render() {
    if (disposed) return;
    const message = messages[state.phase] || messages.unavailable;
    document.documentElement.dataset.webVerificationPhase = state.phase;
    document.documentElement.dataset.authenticated = String(state.authenticated);
    document.documentElement.dataset.phoneReady = 'false';
    text('auth-state', message[0]); text('auth-copy', message[1]); text('verification-status', message[2]);
    text('app-error', state.error); $('app-error').hidden = !state.error;
    text('verification-message', state.message);
    $('google-login').hidden = state.authenticated || state.phase === 'logging-out';
    $('google-login').disabled = pending() || Boolean(pendingLogoutCsrf) || !state.loginAvailable || navigator.onLine === false;
    $('google-logout').hidden = !state.authenticated && state.phase !== 'logging-out' && !pendingLogoutCsrf;
    $('google-logout').disabled = logoutNeedsReload || (pending() && (!dailyWorkbench || operation?.kind === 'logout')) || (!state.authenticated && !pendingLogoutCsrf);
    $('google-login-cancel').hidden = operation?.kind !== 'login' && state.phase !== 'cancelling';
    $('google-login-cancel').disabled = state.phase === 'cancelling';
    $('renew-session').hidden = dailyWorkbench || !state.authenticated;
    $('renew-session').disabled = pending() || !state.csrfToken || navigator.onLine === false;
    $('refresh-status').disabled = pending() || !validMode;
    text('session-expiry', state.authenticated
      ? (dailyWorkbench ? '页面打开期间每分钟续期；关最后页会尝试退出。通知未送达或失联30分钟后失效。' : `当前有效期剩余约 ${Math.max(0, Math.ceil((state.expiresAt - Date.now()) / 60000))} 分钟。`)
      : '尚未确认有效的登录会话。');
    activity?.updateSession({ authenticated: state.authenticated, expiresAt: state.expiresAt,
      paused: Boolean(operation && operation.kind !== 'activity-renew' && operation.kind !== 'page-renew') });
    publishPublicState(state);
  }
  function begin(kind, phase) {
    if (disposed || operation || !validMode) return null;
    const current = { kind, generation: ++generation, controller: new AbortController(), timeout: null };
    operation = current; state.phase = phase; state.error = '';
    state.message = '电话功能保持关闭。'; render();
    current.timeout = setTimeout(() => current.controller.abort(), 10000);
    return current;
  }
  const currentOperation = current => !disposed && operation === current && current.generation === generation;
  function finish(current) {
    clearTimeout(current.timeout);
    if (!currentOperation(current)) return;
    operation = null; render();
  }
  async function request(path, current, headers) {
    const response = await fetch(path, { method: headers ? 'POST' : 'GET',
      credentials: 'same-origin', cache: 'no-store', signal: current.controller.signal,
      ...(headers ? { headers: { 'content-type': 'application/json', ...headers }, body: '{}' } : {}) });
    const value = await response.json();
    return { status: response.status, ok: response.ok, value };
  }
  function expired() {
    clearSession(); state.phase = 'expired'; state.error = '登录会话已失效，请重新登录。';
    state.message = '登录已失效，电话功能保持关闭。'; render();
  }
  function activityExpired(current) {
    if (current.kind !== 'activity-renew' && current.kind !== 'page-renew') return false;
    if (Date.now() >= current.activityExpiresAt) { expired(); return true; }
    return current.activitySignal.aborted;
  }
  async function readSession(current) {
    const status = await request('/api/status', current);
    if (!currentOperation(current) || activityExpired(current)) return false;
    if (status.status === 401) {
      if (current.kind === 'activity-renew' || current.kind === 'page-renew') expired(); else { clearSession(); state.phase = 'signed-out'; }
      return false;
    }
    const value = status.value;
    if (!status.ok || value?.mode !== expectedMode || value.authenticated !== true
      || value.callsEnabled !== false || value.phoneStatus !== 'disabled') {
      state.loginAvailable = false;
      throw new Error('Unconfirmed service');
    }
    const session = await request('/api/browser-session', current);
    if (!currentOperation(current) || activityExpired(current)) return false;
    if (session.status === 401) { expired(); return false; }
    if (!session.ok || session.value?.authenticated !== true
      || typeof session.value.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(session.value.csrfToken)
      || !Number.isSafeInteger(session.value.expiresAt)) throw new Error('Unconfirmed session');
    if (session.value.expiresAt <= Date.now()) { expired(); return false; }
    state.csrfToken = session.value.csrfToken; state.expiresAt = session.value.expiresAt;
    state.authenticated = true; state.phase = 'authenticated';
    state.message = '本页登录已验证，电话功能保持关闭。';
    return true;
  }
  async function refresh() {
    if (logoutNeedsReload) return;
    if (dailyWorkbench && logoutRequested) { if (pendingLogoutCsrf) await sessionAction('logout'); return; }
    const previouslyAuthenticated = state.authenticated || state.phase === 'expired';
    const current = begin('refresh', 'checking');
    if (!current) return;
    if (!dailyWorkbench) clearSession(); state.message = '电话功能保持关闭。'; render();
    try {
      const auth = await request('/auth/status', current);
      if (!currentOperation(current)) return;
      state.loginAvailable = auth.ok && auth.value?.provider === 'google' && auth.value.enabled === true;
      if (!state.loginAvailable) throw new Error('Login unavailable');
      const authenticated = await readSession(current);
      if (currentOperation(current) && !authenticated && previouslyAuthenticated) state.phase = 'expired';
    } catch {
      if (currentOperation(current)) {
        if (!dailyWorkbench || Date.now() >= state.expiresAt) clearSession();
        state.phase = navigator.onLine === false ? 'offline' : 'unavailable';
        state.error = '暂时无法连接；仅保留上次确认的登录期限，将自动重试。';
      }
    } finally {
      if (currentOperation(current)) document.documentElement.dataset.webVerificationReady = 'true';
      finish(current);
    }
  }
  async function login() {
    if (!state.loginAvailable || state.authenticated || pendingLogoutCsrf || navigator.onLine === false) return;
    logoutRequested = false;
    const current = begin('login', 'login-pending');
    if (!current) return;
    let navigating = false;
    try {
      const response = await request('/auth/google/start', current, { 'x-phone-login': 'start' });
      if (!currentOperation(current)) return;
      if (!response.ok) throw new Error('Login not prepared');
      const destination = new URL(response.value.authorizationUrl);
      if (destination.protocol !== 'https:' || destination.host !== 'accounts.google.com'
        || destination.pathname !== '/o/oauth2/v2/auth' || destination.username || destination.password || destination.hash)
        throw new Error('Invalid destination');
      window.location.assign(destination.href); navigating = true;
    } catch {
      if (currentOperation(current)) {
        clearSession(); state.phase = 'signed-out'; state.error = 'Google 登录准备未能确认，请重试或刷新状态。';
      }
    } finally {
      // Keep the generation fence while navigation is pending; cancel can
      // retire it even when the authorization response has already arrived.
      if (navigating) clearTimeout(current.timeout); else finish(current);
    }
  }
  async function cancelLogin() {
    if (disposed || operation?.kind !== 'login') return;
    clearTimeout(operation.timeout); operation.controller.abort(); operation = null;
    const current = begin('cancel', 'cancelling');
    try {
      const response = await request('/auth/google/cancel', current, { 'x-phone-login': 'start' });
      if (!currentOperation(current)) return;
      if (!response.ok || response.value?.ok !== true) throw new Error('Cancel not confirmed');
      clearSession(); state.phase = 'signed-out'; state.message = '已取消登录。电话功能保持关闭。';
    } catch {
      if (currentOperation(current)) {
        clearSession(); state.phase = 'unavailable'; state.error = '登录取消尚未确认，请检查连接后刷新状态。';
      }
    } finally { finish(current); }
  }
  async function sessionAction(kind, activityOptions = null) {
    if (logoutNeedsReload) return;
    if ((!state.authenticated || !state.csrfToken) && !(dailyWorkbench && kind === 'logout' && pendingLogoutCsrf)) return;
    if (navigator.onLine === false && !(dailyWorkbench && kind === 'logout')) return;
    // Explicit logout must remain usable during a background renewal. Retire
    // that generation before sending logout, so a late success cannot revive it.
    if (kind === 'logout' && (operation?.kind === 'activity-renew' || (dailyWorkbench && operation))) {
      generation += 1; operation.controller.abort(); clearTimeout(operation.timeout); operation = null;
    }
    if (activityOptions?.signal.aborted) return;
    if (!pendingLogoutCsrf && Date.now() >= state.expiresAt) { expired(); return; }
    const csrfToken = pendingLogoutCsrf || state.csrfToken;
    const originalExpiresAt = state.expiresAt;
    const automatic = Boolean(activityOptions);
    const current = begin(automatic ? 'activity-renew' : kind,
      kind === 'logout' ? 'logging-out' : automatic ? 'authenticated' : 'renewing');
    if (!current) return;
    current.activityExpiresAt = originalExpiresAt;
    current.activitySignal = activityOptions?.signal;
    const abortActivity = () => current.controller.abort();
    activityOptions?.signal.addEventListener('abort', abortActivity, { once: true });
    if (kind === 'logout') { logoutRequested = true; if (dailyWorkbench) pendingLogoutCsrf = csrfToken; clearSession(); render(); }
    try {
      const response = await request(kind === 'logout' ? '/auth/logout' : '/auth/session/renew', current,
        { 'x-phone-csrf': csrfToken });
      if (!currentOperation(current) || activityExpired(current)) return;
      if (response.status === 401) { pendingLogoutCsrf = ''; expired(); return; }
      if (dailyWorkbench && kind === 'logout' && response.status === 403) {
        // A different tab may have deliberately replaced the shared cookie.
        // Never fetch fresh CSRF to silently log that newer session out.
        logoutNeedsReload = true; clearSession(); state.phase = 'unavailable';
        state.error = '退出未确认，登录可能已在其它页面更新；点击刷新状态重新核验。';
        state.message = '本页已停止保持登录，服务端退出未确认。';
        return;
      }
      if (!response.ok || response.value?.ok !== true) throw new Error('Session change unconfirmed');
      if (kind === 'logout') { pendingLogoutCsrf = ''; clearSession(); state.phase = 'signed-out'; state.message = '已退出登录。电话功能保持关闭。'; }
      else { await readSession(current); if (currentOperation(current) && state.authenticated) state.message = '登录会话已延长。电话功能保持关闭。'; }
    } catch {
      if (currentOperation(current)) {
        if (state.phase === 'expired') { /* Preserve expiry instead of hiding it behind a network error. */ }
        else if (automatic && activityOptions.signal.aborted && state.authenticated && Date.now() < state.expiresAt) {
          state.phase = 'authenticated'; // Keep only the previously confirmed deadline on hide/cancel.
        } else {
          clearSession(); state.phase = navigator.onLine === false ? 'offline' : 'unavailable';
          state.error = kind === 'logout' ? '本页已退出，服务端退出尚未确认；恢复联网后优先重试退出。' : '会话延长尚未确认，请刷新状态后检查。';
        }
      }
    } finally {
      activityOptions?.signal.removeEventListener('abort', abortActivity);
      finish(current);
    }
  }
  async function pageRenew(options) {
    if (disposed || logoutRequested || !state.authenticated || !state.csrfToken || options.signal.aborted) return;
    if (Date.now() >= state.expiresAt) { expired(); return; }
    if (navigator.onLine === false) return;
    const current = begin('page-renew', state.phase === 'offline' ? 'offline' : 'authenticated');
    if (!current) return;
    current.activityExpiresAt = state.expiresAt;
    current.activitySignal = options.signal;
    const abort = () => current.controller.abort();
    options.signal.addEventListener('abort', abort, { once: true });
    try {
      if (options.resume && !await readSession(current)) return;
      if (!currentOperation(current) || activityExpired(current)) return;
      const response = await fetch('/auth/session/page', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: current.controller.signal,
        headers: { 'content-type': 'application/json', 'x-phone-csrf': state.csrfToken },
        body: JSON.stringify({ pageId: options.pageId, sequence: options.sequence, state: 'open' }),
      });
      const value = await response.json();
      if (!currentOperation(current) || activityExpired(current)) return;
      if (response.status === 401) { expired(); return; }
      if (response.status === 409 && value?.error === 'PAGE_LEASE_RETIRED') {
        if (await readSession(current) && currentOperation(current) && !activityExpired(current))
          return { retired: true };
        return;
      }
      if (!response.ok || value?.ok !== true || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now())
        throw new Error('Page lease unconfirmed');
      state.expiresAt = value.expiresAt; state.phase = 'authenticated'; state.error = '';
      state.message = '页面保持登录，电话功能仍关闭。';
    } catch {
      if (currentOperation(current) && !options.signal.aborted) {
        if (Date.now() >= state.expiresAt) expired();
        else { state.phase = navigator.onLine === false ? 'offline' : 'unavailable';
          state.error = '暂时无法续期；保留已确认登录期限，恢复连接后自动重试。'; }
      }
    } finally { options.signal.removeEventListener('abort', abort); finish(current); }
  }
  // Only the daily surface loads page leases. Legacy verification stays manual.
  if (dailyWorkbench) {
    import('./session-page-lease.js').then(({ createSessionPageLease }) => {
      if (disposed) return;
      activity = createSessionPageLease({ eventSource: window, renew: pageRenew, onExpire: expired,
        close: fields => {
          if (!state.csrfToken || logoutRequested) return;
          return fetch('/auth/session/page', { method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive: true,
            headers: { 'content-type': 'application/json', 'x-phone-csrf': state.csrfToken }, body: JSON.stringify(fields) });
        } });
      render();
    }).catch(() => { if (!disposed) { state.error = '自动保持登录未能加载，请刷新页面。'; render(); } });
  }
  $('google-login').addEventListener('click', login);
  $('google-login-cancel').addEventListener('click', cancelLogin);
  $('google-logout').addEventListener('click', () => sessionAction('logout'));
  $('renew-session').addEventListener('click', () => sessionAction('renew'));
  $('refresh-status').addEventListener('click', () => {
    if (logoutNeedsReload) window.location.reload(); else void refresh();
  });
  const clock = setInterval(() => {
    if (disposed) return;
    if (state.authenticated && Date.now() >= state.expiresAt) {
      generation += 1; operation?.controller.abort(); clearTimeout(operation?.timeout); operation = null; expired();
    } else render();
  }, 1000);
  const offline = () => {
    if (logoutNeedsReload) return;
    generation += 1; operation?.controller.abort(); clearTimeout(operation?.timeout); operation = null;
    if (!dailyWorkbench || Date.now() >= state.expiresAt) clearSession();
    state.phase = 'offline'; state.error = '';
    state.message = '网络离线，登录状态待确认；电话功能保持关闭。'; render();
  };
  window.addEventListener('offline', offline);
  function resumePage() {
    if (disposed || logoutNeedsReload) return;
    if (pendingLogoutCsrf) { void sessionAction('logout'); return; }
    if (dailyWorkbench && state.authenticated && Date.now() >= state.expiresAt) expired();
    if (!dailyWorkbench || !state.authenticated) void refresh();
    else activity?.resume();
  }
  window.addEventListener('online', resumePage);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resumePage(); });
  window.addEventListener('pagehide', () => {
    activity?.dispose();
    generation += 1; disposed = true; operation?.controller.abort(); clearTimeout(operation?.timeout);
    clearInterval(clock); operation = null; clearSession();
    document.documentElement.dataset.authenticated = 'false';
    document.documentElement.dataset.webVerificationReady = 'false';
    publishPublicState({ phase: 'disposed', authenticated: false, expiresAt: 0 });
  });
  window.addEventListener('pageshow', event => { if (event.persisted && disposed) window.location.reload(); else if (dailyWorkbench) resumePage(); });
  if (!validMode) {
    state.phase = 'unavailable'; state.error = '页面模式未能确认，请重新打开工作台。';
    document.documentElement.dataset.webVerificationReady = 'true'; render();
  } else { render(); refresh(); }
}

startWebVerification();
