// A separate login-only surface. It imports no phone, media or controller code.
// Session CSRF stays in this closure; it is never stored or rendered.
export function startWebVerification() {
  const $ = id => document.getElementById(id);
  const state = { phase: 'checking', loginAvailable: false, authenticated: false,
    csrfToken: '', expiresAt: 0, error: '', message: '电话功能保持关闭。' };
  let generation = 0;
  let operation = null;
  let disposed = false;
  const pending = () => Boolean(operation);
  const messages = {
    checking: ['正在检查登录', '请稍候，正在读取会话状态。', '正在检查网页验收服务。'],
    'signed-out': ['尚未登录', '使用服务端允许的 Google 工作账号登录。', '网页登录尚未确认。'],
    authenticated: ['已登录', '服务端已验证本次 Google 登录。', '网页登录与会话状态已确认；电话功能关闭。'],
    expired: ['登录已失效', '本次会话已失效，请重新登录。', '会话失效；电话功能保持关闭。'],
    offline: ['登录状态待确认', '网络离线，恢复连接后请检查状态。', '网络离线；网页状态未确认。'],
    unavailable: ['登录状态待确认', '当前无法确认登录，请刷新状态后重试。', '网页验收状态未确认。'],
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
    $('google-login').disabled = pending() || !state.loginAvailable || navigator.onLine === false;
    $('google-logout').hidden = !state.authenticated && state.phase !== 'logging-out';
    $('google-logout').disabled = pending() || !state.authenticated;
    $('google-login-cancel').hidden = operation?.kind !== 'login' && state.phase !== 'cancelling';
    $('google-login-cancel').disabled = state.phase === 'cancelling';
    $('renew-session').hidden = !state.authenticated;
    $('renew-session').disabled = pending() || !state.csrfToken || navigator.onLine === false;
    $('refresh-status').disabled = pending();
    text('session-expiry', state.authenticated
      ? `当前有效期剩余约 ${Math.max(0, Math.ceil((state.expiresAt - Date.now()) / 60000))} 分钟。`
      : '尚未确认有效的登录会话。');
  }
  function begin(kind, phase) {
    if (disposed || operation) return null;
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
  async function readSession(current) {
    const status = await request('/api/status', current);
    if (!currentOperation(current)) return false;
    if (status.status === 401) { clearSession(); state.phase = 'signed-out'; return false; }
    const value = status.value;
    if (!status.ok || value?.mode !== 'web-verification' || value.authenticated !== true
      || value.callsEnabled !== false || value.phoneStatus !== 'disabled') throw new Error('Unconfirmed service');
    const session = await request('/api/browser-session', current);
    if (!currentOperation(current)) return false;
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
    const previouslyAuthenticated = state.authenticated || state.phase === 'expired';
    const current = begin('refresh', 'checking');
    if (!current) return;
    clearSession(); state.message = '电话功能保持关闭。'; render();
    try {
      const auth = await request('/auth/status', current);
      if (!currentOperation(current)) return;
      state.loginAvailable = auth.ok && auth.value?.provider === 'google' && auth.value.enabled === true;
      if (!state.loginAvailable) throw new Error('Login unavailable');
      const authenticated = await readSession(current);
      if (currentOperation(current) && !authenticated && previouslyAuthenticated) state.phase = 'expired';
    } catch {
      if (currentOperation(current)) {
        clearSession(); state.phase = navigator.onLine === false ? 'offline' : 'unavailable';
        state.error = '网页登录状态未能确认，请检查连接并刷新状态。';
      }
    } finally {
      if (currentOperation(current)) document.documentElement.dataset.webVerificationReady = 'true';
      finish(current);
    }
  }
  async function login() {
    if (!state.loginAvailable || state.authenticated || navigator.onLine === false) return;
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
  async function sessionAction(kind) {
    if (!state.authenticated || !state.csrfToken || navigator.onLine === false) return;
    const csrfToken = state.csrfToken;
    const current = begin(kind, kind === 'logout' ? 'logging-out' : 'renewing');
    if (!current) return;
    if (kind === 'logout') { clearSession(); render(); }
    try {
      const response = await request(kind === 'logout' ? '/auth/logout' : '/auth/session/renew', current,
        { 'x-phone-csrf': csrfToken });
      if (!currentOperation(current)) return;
      if (response.status === 401) { expired(); return; }
      if (!response.ok || response.value?.ok !== true) throw new Error('Session change unconfirmed');
      if (kind === 'logout') { clearSession(); state.phase = 'signed-out'; state.message = '已退出登录。电话功能保持关闭。'; }
      else { await readSession(current); if (currentOperation(current) && state.authenticated) state.message = '登录会话已延长。电话功能保持关闭。'; }
    } catch {
      if (currentOperation(current)) {
        clearSession(); state.phase = navigator.onLine === false ? 'offline' : 'unavailable';
        state.error = kind === 'logout' ? '退出登录尚未确认，请刷新状态后检查。' : '会话延长尚未确认，请刷新状态后检查。';
      }
    } finally { finish(current); }
  }
  $('google-login').addEventListener('click', login);
  $('google-login-cancel').addEventListener('click', cancelLogin);
  $('google-logout').addEventListener('click', () => sessionAction('logout'));
  $('renew-session').addEventListener('click', () => sessionAction('renew'));
  $('refresh-status').addEventListener('click', refresh);
  const clock = setInterval(() => {
    if (disposed) return;
    if (state.authenticated && Date.now() >= state.expiresAt) {
      generation += 1; operation?.controller.abort(); clearTimeout(operation?.timeout); operation = null; expired();
    } else render();
  }, 1000);
  const offline = () => {
    generation += 1; operation?.controller.abort(); clearTimeout(operation?.timeout); operation = null;
    clearSession(); state.phase = 'offline'; state.error = '';
    state.message = '网络离线，登录状态待确认；电话功能保持关闭。'; render();
  };
  window.addEventListener('offline', offline);
  window.addEventListener('online', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('pagehide', () => {
    generation += 1; disposed = true; operation?.controller.abort(); clearTimeout(operation?.timeout);
    clearInterval(clock); operation = null; clearSession();
    document.documentElement.dataset.authenticated = 'false';
    document.documentElement.dataset.webVerificationReady = 'false';
  });
  window.addEventListener('pageshow', event => { if (event.persisted && disposed) window.location.reload(); });
  render(); refresh();
}

startWebVerification();
