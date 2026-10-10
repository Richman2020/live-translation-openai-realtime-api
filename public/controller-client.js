// Same-origin browser controller. Capabilities live only in this document's closure.
const terminal = status => ['completed', 'failed', 'canceled', 'busy', 'no-answer', 'rejected'].includes(status);
const messages = {
  UNAUTHORIZED: '登录已失效。请重新登录；此页面不能继续控制电话。',
  FORBIDDEN: '控制许可已失效。此标签页已转为只读，请刷新状态。',
  CONTROLLER_BUSY: '另一标签页持有控制权，或上次线路仍待清理。当前标签页只读。',
  CONTROL_REQUIRED: '请先取得当前标签页的控制权。',
  CONTROL_EXPIRED: '控制权已到期，已停止本页语音并请求线路清理。请刷新状态。',
  CONTROL_PAUSED: '连接或页面活动已暂停自动续约。恢复后请明确续约；读取不会延长控制权。',
  CALL_CANCELLED: '本次操作已取消，线路状态以服务端确认结果为准。',
  CALL_CLEANUP_UNCONFIRMED: '线路关闭尚未确认。确认前不能开始下一通电话。',
  REQUEST_TIMEOUT: '操作超时，结果仍待服务端确认。请刷新状态，不要重复拨号。',
  REQUEST_FAILED: '无法完成操作。请检查连接并刷新状态。',
  INVALID_RESPONSE: '服务返回无法使用的许可，已停止本次操作。',
  VOICE_CONNECTION_NOT_READY: '电话连接许可尚未就绪；生产预算与恢复材料仍需完成。',
  LOGOUT_UNCONFIRMED: '本页已停止控制，服务器退出尚未确认。请检查连接后重新登录。',
  INVALID_TRANSLATION_ENGINE: '请选择此服务允许的翻译策略。',
};
const fail = code => Object.assign(new Error(messages[code] || code), { code });
const safeError = error => {
  const code = typeof error?.code === 'string' ? error.code : 'REQUEST_FAILED';
  return Object.freeze({ code, message: messages[code] || '操作未完成，请刷新服务状态。' });
};
const proofOf = lease => Object.freeze({ tabId: lease.tabId, leaseId: lease.leaseId, epoch: lease.epoch });
const disconnect = call => { try { call?.disconnect?.(); } catch { /* Cleanup must continue. */ } };
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function safeCall(call) {
  if (!call || !validId(call.id) || typeof call.status !== 'string') return null;
  return Object.freeze(Object.fromEntries(['id', 'status', 'to', 'from', 'translationEngine', 'translationReady', 'captionState', 'outgoingCaptionState', 'error', 'cleanupUnconfirmed']
    .filter(key => typeof call[key] === 'string' || typeof call[key] === 'boolean')
    .map(key => [key, call[key]])));
}

export function createControllerClient({
  fetchImpl = globalThis.fetch?.bind(globalThis), onChange = () => {}, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout,
  randomTabId = () => globalThis.crypto.randomUUID(), requestTimeoutMs = 10000,
  operationTimeoutMs = 30000,
} = {}) {
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 ||
      !Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1) throw fail('INVALID_RESPONSE');
  const tabId = randomTabId();
  if (!validId(tabId)) throw fail('INVALID_RESPONSE');
  let csrf = '', authenticated = false, readConfirmed = false, controller = null, lease = null, call = null;
  let phase = 'loading', error = null, connected = false, visible = true, busy = true;
  let cleanupPending = false, cleanupRequests = 0, disposed = false, renewPaused = false, attempt = null;
  let generation = 0, readSequence = 0, pendingAcquire = false, pendingRenew = false, pendingLogout = false;
  let deadlineTimer = null, renewalTimer = null;
  let engines = [], defaultEngine = '';
  let outgoingPairedCaptions = false;
  const requests = new Set();
  // Only in-flight cleanup retains these capabilities. They cannot restore a
  // lease or authorize a new call; each request keeps its existing timeout.
  const cleanupTasks = new Set();
  const retiredCalls = new Set();
  const retireCall = id => { retiredCalls.add(id); if (retiredCalls.size > 100) retiredCalls.delete(retiredCalls.values().next().value); };
  const liveLease = () => Boolean(!disposed && authenticated && lease && now() < lease.expiresAt);
  const activeCall = () => Boolean(call && (!terminal(call.status) || call.cleanupUnconfirmed));
  const snapshot = () => {
    const holdsControl = liveLease();
    const canControl = holdsControl && readConfirmed && connected && visible && !cleanupPending;
    return Object.freeze({
      tabId, phase, authenticated, connection: connected ? 'connected' : 'disconnected', visible,
      controller, lease: holdsControl ? Object.freeze({ tabId: lease.tabId, epoch: lease.epoch, expiresAt: lease.expiresAt }) : null,
      call, error, cleanupPending, renewPaused, busy,
      translationEngines: Object.freeze([...engines]), defaultTranslationEngine: defaultEngine,
      outgoingPairedCaptions,
      canAcquire: !disposed && authenticated && readConfirmed && connected && visible && controller?.mode === 'available' && !lease && !busy && !cleanupPending && !pendingAcquire,
      canControl, canStart: canControl && !activeCall() && !attempt && !busy,
      canHangup: holdsControl && cleanupRequests === 0 && Boolean(attempt || activeCall() || (cleanupPending && call)),
      canMute: holdsControl && readConfirmed && !cleanupPending && phase === 'active',
      canRenew: holdsControl && readConfirmed && connected && visible && !pendingRenew && !cleanupPending,
    });
  };
  const emit = () => { onChange(snapshot()); };
  const current = item => Boolean(item && attempt === item && !item.cancelled && item.generation === generation &&
    lease === item.lease && liveLease() && readConfirmed && connected && visible && !cleanupPending);
  const clearControlTimers = () => {
    clearTimer(deadlineTimer); clearTimer(renewalTimer); deadlineTimer = renewalTimer = null;
  };
  const rejectAttempt = item => {
    if (!item || item.cancelled) return;
    item.cancelled = true;
    for (const abort of [...item.aborters]) abort();
    disconnect(item.sdkCall); item.sdkCall = null;
  };

  // Aborting a request is not proof that its server-side action did not happen.
  async function request(path, body, { capturedCsrf = csrf, item, onLate, keepalive = false } = {}) {
    const abort = new AbortController();
    if (!keepalive) requests.add(abort);
    let settled = false, timer;
    return new Promise((resolve, reject) => {
      const finish = (ok, value) => {
        if (settled) { if (ok && onLate) Promise.resolve(onLate(value)).catch(() => {}); return; }
        settled = true; clearTimer(timer); requests.delete(abort); item?.aborters.delete(cancelRequest);
        if (ok) resolve(value); else reject(value);
      };
      const cancelRequest = () => { abort.abort(); finish(false, fail('CALL_CANCELLED')); };
      item?.aborters.add(cancelRequest);
      timer = setTimer(() => { abort.abort(); finish(false, fail('REQUEST_TIMEOUT')); }, requestTimeoutMs);
      const headers = body === undefined ? {} : { 'content-type': 'application/json', 'x-phone-csrf': capturedCsrf };
      let received;
      try {
        // Dispatch keepalive while the pagehide handler still owns this document.
        received = fetchImpl(path, {
          method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
          headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: abort.signal, keepalive,
        });
      } catch (failure) { finish(false, failure); return; }
      Promise.resolve(received).then(async response => {
        let value;
        try { value = await response.json(); } catch { throw fail('INVALID_RESPONSE'); }
        if (!response.ok) throw fail(typeof value?.error === 'string' ? value.error : typeof value?.code === 'string' ? value.code : response.status === 401 ? 'UNAUTHORIZED' : response.status === 403 ? 'FORBIDDEN' : 'REQUEST_FAILED');
        return value;
      }).then(value => finish(true, value), failure => finish(false, failure));
    });
  }
  const bestEffort = (path, body, capturedCsrf) => request(path, body, { capturedCsrf, keepalive: true }).catch(() => null);
  async function cleanupCaptured(captured, revoke = true, parallel = false) {
    const { proof, callId, capturedCsrf } = captured;
    if (!proof) return;
    let task = [...cleanupTasks].find(item => item.captured.callId === callId && item.captured.capturedCsrf === capturedCsrf &&
      item.captured.proof.tabId === proof.tabId && item.captured.proof.leaseId === proof.leaseId && item.captured.proof.epoch === proof.epoch);
    if (!task) { task = { captured, users: 0, hangup: null, revoke: null }; cleanupTasks.add(task); }
    task.users += 1;
    const hangup = () => task.hangup ||= callId ? bestEffort(`/api/calls/${encodeURIComponent(callId)}/hangup`, { controller: proof }, capturedCsrf) : Promise.resolve(null);
    const release = () => task.revoke ||= bestEffort('/api/controller/revoke', proof, capturedCsrf);
    try {
      if (parallel) await Promise.all([hangup(), revoke ? release() : null]);
      else { await hangup(); if (revoke) await release(); }
    } finally {
      task.users -= 1; if (!task.users) cleanupTasks.delete(task);
    }
  }
  const validLease = value => value && value.tabId === tabId && typeof value.leaseId === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(value.leaseId) && Number.isSafeInteger(value.epoch) && value.epoch > 0 &&
    Number.isSafeInteger(value.expiresAt) && value.expiresAt > now();
  function awaitOperation(promise, item, onLate) {
    let settled = false, timer;
    return new Promise((resolve, reject) => {
      const finish = (ok, value) => {
        if (settled) { if (ok) onLate?.(value); return; }
        settled = true; clearTimer(timer); item.aborters.delete(cancelOperation);
        if (ok) resolve(value); else reject(value);
      };
      const cancelOperation = () => finish(false, fail('CALL_CANCELLED'));
      item.aborters.add(cancelOperation);
      timer = setTimer(() => finish(false, fail('REQUEST_TIMEOUT')), operationTimeoutMs);
      Promise.resolve(promise).then(value => finish(true, value), failure => finish(false, failure));
    });
  }
  function installTimers() {
    clearControlTimers();
    if (!liveLease()) return;
    const held = lease;
    deadlineTimer = setTimer(() => { if (lease === held && now() >= held.expiresAt) expire(); else installTimers(); }, Math.max(1, held.expiresAt - now()));
    if (!renewPaused && connected && visible) {
      const remaining = held.expiresAt - now();
      renewalTimer = setTimer(() => {
        if (lease === held && liveLease() && !renewPaused && connected && visible) void client.renew().catch(() => {});
      }, Math.max(1, Math.min(10000, Math.floor(remaining / 2))));
    }
  }
  function expire() {
    if (!lease) return;
    error = safeError(fail('CONTROL_EXPIRED'));
    void client.cancel('CONTROL_EXPIRED');
  }
  function loseControl(failure) {
    if (lease || attempt) {
      error = safeError(failure);
      void client.cancel(failure?.code || 'FORBIDDEN');
    } else { error = safeError(failure); phase = 'readonly'; emit(); }
  }
  function applyBootstrap(value) {
    if (value?.mode !== 'controlled' || typeof value.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.csrfToken) ||
        !value.controller || !['held', 'available'].includes(value.controller.mode) || typeof value.busy !== 'boolean' ||
        !Array.isArray(value.translationEngines) || !value.translationEngines.length || value.translationEngines.length > 3 ||
        new Set(value.translationEngines).size !== value.translationEngines.length ||
        value.translationEngines.some(engine => !['pocket-prefix', 'pocket-captions', 'continuous-captions'].includes(engine)) ||
        typeof value.outgoingPairedCaptions !== 'boolean' ||
        !value.translationEngines.includes(value.defaultTranslationEngine)) throw fail('INVALID_RESPONSE');
    csrf = value.csrfToken; authenticated = true; readConfirmed = true;
    controller = Object.freeze(Object.fromEntries(['mode', 'ownSession', 'tabMatches', 'epoch', 'expiresAt'].map(key => [key, value.controller[key]]))); busy = value.busy;
    engines = [...value.translationEngines]; defaultEngine = value.defaultTranslationEngine;
    outgoingPairedCaptions = value.outgoingPairedCaptions;
    const nextCall = safeCall(value.activeSession);
    if (nextCall) call = nextCall;
    else if (!busy && !attempt) call = null;
    if (!busy && !nextCall && !attempt) cleanupPending = false;
    if (lease && (controller.mode !== 'held' || controller.epoch !== lease.epoch || !controller.ownSession || !controller.tabMatches || now() >= lease.expiresAt)) {
      loseControl(fail('FORBIDDEN')); return;
    }
    if (!attempt && phase !== 'acquiring' && !cleanupPending) phase = liveLease() ? 'ready' : 'readonly';
    emit();
  }

  const client = {
    get state() { return snapshot(); },
    get tabId() { return tabId; },
    async boot() { return client.refresh(); },
    async refresh() {
      if (disposed) return snapshot();
      if (lease && now() >= lease.expiresAt) expire();
      const seq = ++readSequence, before = generation;
      try {
        const value = await request(`/api/browser-session?tabId=${encodeURIComponent(tabId)}`);
        if (disposed || seq !== readSequence || before !== generation) return snapshot();
        applyBootstrap(value);
      } catch (failure) {
        if (disposed || seq !== readSequence || before !== generation) return snapshot();
        if (failure?.code === 'UNAUTHORIZED') { authenticated = false; csrf = ''; loseControl(failure); }
        else {
          readConfirmed = false; error = safeError(failure);
          if (['FORBIDDEN', 'INVALID_RESPONSE'].includes(failure?.code)) loseControl(failure);
          else if (attempt && phase !== 'active') void client.cancel(failure?.code || 'REQUEST_FAILED');
          emit();
        }
      }
      return snapshot();
    },
    async acquire() {
      if (pendingAcquire) throw fail('CONTROLLER_BUSY');
      if (!snapshot().canAcquire) throw fail('CONTROL_REQUIRED');
      pendingAcquire = true; phase = 'acquiring'; error = null; const before = generation, capturedCsrf = csrf;
      emit();
      try {
        const received = await request('/api/controller/acquire', { tabId }, {
          capturedCsrf, onLate: late => validLease(late) ? cleanupCaptured({ proof: proofOf(late), capturedCsrf }) : undefined,
        });
        if (disposed || before !== generation) {
          if (validLease(received)) void cleanupCaptured({ proof: proofOf(received), capturedCsrf });
          throw fail('CALL_CANCELLED');
        }
        if (!validLease(received)) throw fail('INVALID_RESPONSE');
        lease = { ...received }; controller = Object.freeze({ mode: 'held', ownSession: true, tabMatches: true, epoch: lease.epoch, expiresAt: lease.expiresAt });
        renewPaused = false; phase = 'ready'; installTimers();
        return snapshot();
      } catch (failure) {
        if (!disposed && before === generation) {
          error = safeError(failure); phase = 'readonly';
          if (failure?.code === 'UNAUTHORIZED') authenticated = false;
          if (failure?.code !== 'CONTROLLER_BUSY') readConfirmed = false;
        }
        throw failure;
      } finally { pendingAcquire = false; if (!disposed) emit(); }
    },
    async renew() {
      if (!liveLease() || !readConfirmed || !connected || !visible || cleanupPending) throw fail('CONTROL_REQUIRED');
      if (pendingRenew) return snapshot();
      const held = lease, proof = proofOf(held), capturedCsrf = csrf, before = generation;
      pendingRenew = true; emit();
      try {
        const received = await request('/api/controller/renew', proof, { capturedCsrf });
        if (disposed || lease !== held || before !== generation) throw fail('CALL_CANCELLED');
        if (!validLease(received) || received.leaseId !== held.leaseId || received.epoch !== held.epoch) throw fail('INVALID_RESPONSE');
        held.expiresAt = received.expiresAt; controller = Object.freeze({ ...controller, expiresAt: held.expiresAt });
        renewPaused = !connected || !visible; error = null; installTimers(); return snapshot();
      } catch (failure) {
        if (!disposed && lease === held && before === generation) {
          renewPaused = true; clearTimer(renewalTimer); error = safeError(failure);
          if (['FORBIDDEN', 'UNAUTHORIZED', 'INVALID_RESPONSE'].includes(failure?.code)) {
            if (failure.code === 'UNAUTHORIZED') authenticated = false;
            loseControl(failure);
          }
        }
        throw failure;
      } finally { pendingRenew = false; if (!disposed) emit(); }
    },
    async startCall(to, { prepareMedia, connectVoice, translationEngine = defaultEngine } = {}) {
      if (!snapshot().canStart) throw fail('CONTROL_REQUIRED');
      if (!engines.includes(translationEngine)) throw fail('INVALID_TRANSLATION_ENGINE');
      if (typeof connectVoice !== 'function' || (prepareMedia !== undefined && typeof prepareMedia !== 'function')) throw fail('INVALID_RESPONSE');
      const item = { generation, lease, proof: proofOf(lease), capturedCsrf: csrf, callId: null, pendingCallId: null, creating: false, sdkCall: null, cancelled: false, aborters: new Set() };
      attempt = item; phase = 'preparing'; error = null; emit();
      const lateCreate = async value => {
        const late = safeCall(value);
        if (!late) return;
        // This belongs to the captured generation, never a newer call's UI.
        await cleanupCaptured({ proof: item.proof, callId: late.id, capturedCsrf: item.capturedCsrf });
        if (!disposed && !attempt && !lease) void client.refresh();
      };
      try {
        if (prepareMedia) await awaitOperation(Promise.resolve().then(() => prepareMedia({ isCurrent: () => current(item), callId: null })), item);
        if (!current(item)) throw fail('CALL_CANCELLED');
        item.creating = true;
        const created = await request('/api/calls', { to, translationEngine, controller: item.proof }, { item, capturedCsrf: item.capturedCsrf, onLate: lateCreate });
        const accepted = safeCall(created);
        if (!accepted) throw fail('INVALID_RESPONSE');
        item.callId = accepted.id;
        if (item.pendingCallId && item.pendingCallId !== accepted.id) throw fail('INVALID_RESPONSE');
        if (!current(item)) { void lateCreate(created); throw fail('CALL_CANCELLED'); }
        call = accepted; busy = true; emit();
        const voice = await request(`/api/calls/${encodeURIComponent(item.callId)}/voice`, { controller: item.proof }, { item, capturedCsrf: item.capturedCsrf });
        if (!current(item)) throw fail('CALL_CANCELLED');
        if (typeof voice?.token !== 'string' || !voice.token || typeof voice.join !== 'string' || !voice.join ||
            voice.params?.sessionId !== item.callId || voice.params?.join !== voice.join || typeof voice.params?.nonce !== 'string' ||
            voice.grant?.callId !== item.callId || voice.grant?.incomingAllow !== false ||
            voice.grant?.controller?.leaseId !== item.proof.leaseId || voice.grant?.controller?.epoch !== item.proof.epoch ||
            voice.grant?.controller?.tabId !== tabId || !Number.isSafeInteger(voice.grant?.expiresAt) ||
            voice.grant.expiresAt <= now() || voice.grant.expiresAt > lease.expiresAt) throw fail('INVALID_RESPONSE');
        phase = 'connecting'; emit();
        const sdkCall = await awaitOperation(Promise.resolve().then(() => {
          if (!current(item)) throw fail('CALL_CANCELLED');
          return connectVoice(voice, { isCurrent: () => current(item), callId: item.callId });
        }), item, disconnect);
        if (!current(item)) { disconnect(sdkCall); throw fail('CALL_CANCELLED'); }
        if (!sdkCall || typeof sdkCall.disconnect !== 'function') throw fail('INVALID_RESPONSE');
        item.sdkCall = sdkCall; emit(); return snapshot();
      } catch (failure) {
        if (attempt === item && !item.cancelled) {
          error = safeError(failure);
          await client.cancel(failure?.code || 'REQUEST_FAILED');
        }
        throw failure;
      }
    },
    markVoiceAccepted(callId) {
      if (!current(attempt) || !['connecting', 'active'].includes(phase) || callId !== attempt.callId || !call || terminal(call.status)) return false;
      // SDK accept means browser media joined; provider ringing/active stays in call.status.
      phase = 'active'; emit(); return true;
    },
    handleVoiceDisconnected(callId) {
      if (!attempt || attempt.cancelled || callId !== attempt.callId) return false;
      void client.cancel('CALL_CANCELLED'); return true;
    },
    handleEvent(type, data) {
      if (disposed) return false;
      if (lease && now() >= lease.expiresAt) expire();
      const incoming = type === 'snapshot' ? safeCall(data?.activeSession) : type === 'call' ? safeCall(data) : null;
      if (!incoming) {
        if (type === 'error' && data?.sessionId === call?.id) { error = safeError({ code: data.code || data.error }); emit(); return true; }
        return false;
      }
      if (attempt && !attempt.callId) {
        // The first connecting publish may precede the HTTP result. Old final
        // events must not cancel a new microphone/create operation.
        if (!attempt.creating || retiredCalls.has(incoming.id) || incoming.status !== 'connecting') return false;
        attempt.pendingCallId = incoming.id; call = incoming; busy = true; emit(); return true;
      }
      if (attempt?.callId && incoming.id !== attempt.callId) return false;
      if (call && incoming.id !== call.id && activeCall()) return false;
      call = incoming; busy = !terminal(incoming.status) || incoming.cleanupUnconfirmed === true;
      if (terminal(incoming.status) || incoming.status === 'ending') {
        retireCall(incoming.id); rejectAttempt(attempt); attempt = null;
        cleanupPending = true; busy = true; phase = 'ending';
        // Only a fresh authoritative busy gate can confirm budget/intent cleanup.
        void client.refresh();
      }
      emit(); return true;
    },
    setConnectionState(value) {
      if (disposed) return;
      connected = value === true;
      if (!connected) {
        renewPaused = true; clearTimer(renewalTimer); if (lease) error = safeError(fail('CONTROL_PAUSED'));
        if (attempt && phase !== 'active') void client.cancel('CONTROL_PAUSED');
      }
      // An SSE reconnect is read-only. It never calls renew or restarts auto-renew.
      if (lease && now() >= lease.expiresAt) expire();
      emit();
    },
    setVisible(value) {
      if (disposed) return;
      visible = value === true;
      if (!visible) {
        renewPaused = true; clearTimer(renewalTimer);
        if (attempt && phase !== 'active') void client.cancel('CONTROL_PAUSED');
      }
      if (lease && now() >= lease.expiresAt) expire();
      emit();
    },
    async cancel(reason = 'CALL_CANCELLED') {
      if (disposed) return snapshot();
      const releaseControl = typeof reason === 'object' ? reason?.releaseControl !== false : true;
      const code = typeof reason === 'string' ? reason : 'CALL_CANCELLED';
      if (!releaseControl && cleanupRequests) return snapshot();
      cleanupRequests += 1;
      generation += 1; readSequence += 1;
      const oldAttempt = attempt, oldLease = lease;
      const capturedProof = oldLease ? proofOf(oldLease) : oldAttempt?.proof;
      const captured = { proof: capturedProof, callId: capturedProof ? oldAttempt?.callId || ((activeCall() || cleanupPending) && call ? call.id : null) : null, capturedCsrf: oldAttempt?.capturedCsrf || csrf };
      if (captured.callId) retireCall(captured.callId);
      cleanupPending = cleanupPending || Boolean(oldAttempt || captured.callId || pendingAcquire);
      rejectAttempt(oldAttempt); attempt = null;
      if (releaseControl) { lease = null; clearControlTimers(); renewPaused = true; }
      else { clearTimer(renewalTimer); renewPaused = true; }
      phase = cleanupPending ? 'ending' : liveLease() ? 'ready' : 'readonly'; error = safeError(fail(code)); emit();
      try {
        await cleanupCaptured(captured, releaseControl, typeof reason === 'object' && reason?.parallelCleanup === true);
        if (!disposed) await client.refresh();
        return snapshot();
      } finally { cleanupRequests -= 1; if (!disposed) emit(); }
    },
    async revoke() { return client.cancel('CALL_CANCELLED'); },
    async logout() {
      if (disposed || pendingLogout || !authenticated || !csrf) throw fail('UNAUTHORIZED');
      const capturedCsrf = csrf;
      pendingLogout = true; generation += 1; readSequence += 1;
      // Immediately retire every pending local owner. Server revocation and its
      // independent call lifecycle handle cleanup even if the response is lost.
      clearControlTimers(); rejectAttempt(attempt); attempt = null; lease = null;
      csrf = ''; authenticated = false; readConfirmed = false; connected = false;
      renewPaused = true; phase = 'logging-out'; error = null; emit();
      try {
        const value = await request('/auth/logout', {}, { capturedCsrf });
        if (value?.ok !== true) throw fail('INVALID_RESPONSE');
        return snapshot();
      } catch {
        error = safeError(fail('LOGOUT_UNCONFIRMED')); throw fail('LOGOUT_UNCONFIRMED');
      } finally {
        pendingLogout = false;
        if (!disposed) { phase = 'readonly'; emit(); }
      }
    },
    dispose() {
      if (disposed) return;
      // Start cleanup with the captured capabilities, then erase this document.
      // Visibility/offline cancellation may already have removed the public
      // lease while awaiting hangup. Dispatch its still-unsent revoke now;
      // neither a later network response nor unloaded JS is required to start it.
      for (const task of [...cleanupTasks]) void cleanupCaptured(task.captured, true, true);
      void client.cancel({ releaseControl: true, parallelCleanup: true }); disposed = true; generation += 1; readSequence += 1;
      for (const abort of requests) abort.abort();
      requests.clear(); clearControlTimers(); rejectAttempt(attempt); attempt = null; lease = null; csrf = ''; authenticated = false; phase = 'disposed'; emit();
    },
  };
  return client;
}
