// One owner per call attempt. A prepared stream is handed to the Voice SDK once.
export const microphoneMessages = {
  MICROPHONE_PERMISSION_DENIED: '麦克风访问未获允许。请查看当前标签页地址栏的麦克风或权限图标，允许此页面使用麦克风后重试。',
  MICROPHONE_NOT_FOUND: '没有找到可用的麦克风。请连接麦克风或耳机后重试。',
  MICROPHONE_UNAVAILABLE: '麦克风无法打开，可能正被其他程序占用。请检查设备后重试。',
  MICROPHONE_UNSUPPORTED: '当前浏览器无法提供麦克风访问。请从桌面「AI 电话」在 Edge 或 Chrome 中打开。',
  MICROPHONE_TIMEOUT: '等待麦克风超过 30 秒，本次准备已取消。请查看当前标签页地址栏的麦克风或权限图标并允许访问；Codex 内置浏览器也需要在其标签页地址栏处理授权。',
  MICROPHONE_FAILED: '获取麦克风失败。请检查浏览器授权和录音设备后重试。',
};

export function microphoneErrorCode(error) {
  if (error?.code && microphoneMessages[error.code]) return error.code;
  if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error?.name)) return 'MICROPHONE_PERMISSION_DENIED';
  if (['NotFoundError', 'DevicesNotFoundError'].includes(error?.name)) return 'MICROPHONE_NOT_FOUND';
  if (['NotReadableError', 'TrackStartError', 'AbortError', 'OverconstrainedError'].includes(error?.name)) return 'MICROPHONE_UNAVAILABLE';
  return 'MICROPHONE_FAILED';
}

function failure(code, name = 'AbortError') {
  return Object.assign(new Error(microphoneMessages[code] || '本次通话已取消。'), { code, name });
}

function stopStream(stream) {
  for (const track of stream?.getTracks?.() || []) {
    try { track.stop(); } catch { /* Release every remaining track. */ }
  }
}

function voiceConstraints(constraints = { audio: true }) {
  if (constraints.audio === false) return constraints;
  return {
    ...constraints,
    audio: {
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: true },
      autoGainControl: { ideal: true },
      ...(typeof constraints.audio === 'object' ? constraints.audio : {}),
    },
  };
}

// Only report processing booleans; device and group identifiers stay private.
export function microphoneProcessing(stream) {
  let settings;
  try { settings = stream?.getAudioTracks?.()[0]?.getSettings?.(); } catch { /* Some browsers cannot report settings. */ }
  return Object.fromEntries(['echoCancellation', 'noiseSuppression', 'autoGainControl'].map(key => [key, typeof settings?.[key] === 'boolean' ? settings[key] : null]));
}

export function createCallLifecycle({ requestMedia, onChange = () => {}, mediaTimeoutMs = 30000 } = {}) {
  let current = null;
  let sequence = 0;
  const isCurrent = attempt => Boolean(attempt && current === attempt && !attempt.cancelled);
  const update = (attempt, values) => {
    if (!isCurrent(attempt)) return false;
    Object.assign(attempt, values); onChange(attempt); return true;
  };
  const cancel = (attempt = current) => {
    if (!attempt || attempt.cancelled) return;
    attempt.cancelled = true;
    attempt.microphoneReady = false; attempt.microphoneProcessing = null;
    for (const abort of [...attempt.pendingMedia]) abort();
    stopStream(attempt.preparedStream); attempt.preparedStream = null;
    // Delivered streams belong to the SDK; disconnect() owns their normal cleanup.
    if (current === attempt) { current = null; onChange(null); }
  };
  const lifecycle = {
    get current() { return current; },
    isCurrent,
    update,
    cancel,
    begin(sessionId = null) {
      cancel();
      current = { id: ++sequence, sessionId, phase: 'preparing', microphoneReady: false, microphoneProcessing: null, failureCode: null, cancelled: false, preparedStream: null, pendingMedia: new Set() };
      onChange(current); return current;
    },
    async connect(attempt, connect) {
      if (!isCurrent(attempt)) return null;
      try {
        const call = await connect();
        if (!isCurrent(attempt)) { try { call.disconnect(); } catch { /* This old call must never replace the current call. */ } return null; }
        return call;
      } catch (error) {
        if (!isCurrent(attempt)) return null;
        throw error;
      }
    },
    async prepareMicrophone(attempt, constraints = { audio: true }) {
      const stream = await lifecycle.acquireMicrophone(attempt, constraints);
      if (!isCurrent(attempt)) { stopStream(stream); throw failure('CALL_CANCELLED'); }
      attempt.preparedStream = stream;
      update(attempt, { phase: 'preparing' });
    },
    useMicrophone(attempt, constraints) {
      if (!isCurrent(attempt)) return Promise.reject(failure('CALL_CANCELLED'));
      if (!attempt.preparedStream) return lifecycle.acquireMicrophone(attempt, constraints);
      const stream = attempt.preparedStream; attempt.preparedStream = null;
      update(attempt, { phase: 'signaling' });
      return Promise.resolve(stream);
    },
    acquireMicrophone(attempt, constraints) {
      if (!isCurrent(attempt)) return Promise.reject(failure('CALL_CANCELLED'));
      update(attempt, { phase: 'microphone', microphoneReady: false, microphoneProcessing: null, failureCode: null });
      return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => { clearTimeout(timer); attempt.pendingMedia.delete(abort); };
        const fail = (error, code) => {
          if (settled) return;
          settled = true; cleanup();
          if (code) update(attempt, { failureCode: code, microphoneReady: false });
          reject(error);
        };
        const abort = () => fail(failure('CALL_CANCELLED'));
        const timer = setTimeout(() => fail(failure('MICROPHONE_TIMEOUT'), 'MICROPHONE_TIMEOUT'), mediaTimeoutMs);
        attempt.pendingMedia.add(abort);
        // The SDK consumes this same stream; permission preparation never duplicates capture.
        Promise.resolve().then(() => {
          if (!isCurrent(attempt)) throw failure('CALL_CANCELLED');
          if (!requestMedia) throw failure('MICROPHONE_UNSUPPORTED', 'NotSupportedError');
          return requestMedia(voiceConstraints(constraints));
        }).then(stream => {
          if (settled || !isCurrent(attempt)) { stopStream(stream); if (!settled) abort(); return; }
          settled = true; cleanup();
          update(attempt, { phase: 'signaling', microphoneReady: true, microphoneProcessing: microphoneProcessing(stream) });
          resolve(stream);
        }, error => {
          if (!isCurrent(attempt)) abort();
          else fail(error, microphoneErrorCode(error));
        });
      });
    },
  };
  return lifecycle;
}

// A pending Device.connect must never share its AudioHelper with a new attempt.
export function createDeviceMediaOwner(lifecycle) {
  let attempt = null;
  let pending = null;
  let retired = false;
  const owner = {
    bind(next) {
      if (retired || (pending && pending !== next)) throw failure('CALL_CANCELLED');
      attempt = next;
    },
    getUserMedia(constraints) {
      if (retired) return Promise.reject(failure('CALL_CANCELLED'));
      return lifecycle.useMicrophone(attempt, constraints);
    },
    async connect(next, connect) {
      owner.bind(next); pending = next;
      try { return await lifecycle.connect(next, connect); }
      finally { if (pending === next) pending = null; }
    },
    retireIfPending(next) {
      if (pending !== next) return false;
      retired = true; return true;
    },
  };
  return owner;
}
