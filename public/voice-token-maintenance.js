// Maintain only the already accepted Device. No registration, new join ticket,
// reconnect or dial is performed here. Server authorization remains decisive.
export function createVoiceTokenMaintenance({
  device, tokenExpiresAt, refreshToken, isCurrent, onFailure = () => {},
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  leadMs = 60000,
}) {
  let expiresAt = tokenExpiresAt, timer = null, pending = null;
  let started = false, stopped = false, retries = 0;
  const live = () => started && !stopped && isCurrent();
  const clear = () => { clearTimer(timer); timer = null; };
  const validExpiry = value => Number.isSafeInteger(value) && value > now();
  function schedule(delay = Math.max(1000, expiresAt - now() - Math.min(leadMs, (expiresAt - now()) / 2))) {
    clear();
    if (live()) timer = setTimer(() => { timer = null; void refresh(); }, delay);
  }
  async function refresh() {
    if (!live()) return;
    if (pending) return pending;
    clear();
    const work = (async () => {
      try {
        const value = await refreshToken();
        if (!live()) return; // A hangup/logout retires every late result.
        if (typeof value?.token !== 'string' || !value.token || !validExpiry(value.tokenExpiresAt))
          throw Object.assign(new Error('Invalid signalling refresh'), { code: 'INVALID_RESPONSE' });
        // The existing SDK owns the audio. updateToken does not create a call.
        // Near the unchanged absolute identity boundary, reissuing the same
        // deadline must not retrigger an immediate SDK warning/update loop.
        if (value.tokenExpiresAt !== expiresAt) device.updateToken(value.token);
        expiresAt = value.tokenExpiresAt; retries = 0; schedule();
      } catch (failure) {
        if (!live()) return;
        const code = typeof failure?.code === 'string' ? failure.code : 'REQUEST_FAILED';
        if (['UNAUTHORIZED', 'FORBIDDEN', 'INVALID_RESPONSE', 'CALL_CANCELLED'].includes(code)) {
          stopped = true; clear(); onFailure({ code }); return;
        }
        // Bounded retries protect against transient network loss. A failed
        // refresh alone is not proof that healthy media disconnected; real
        // SDK errors and server revocation still run the normal cleanup path.
        if (retries < 2) schedule([1000, 3000][retries++]);
        else onFailure({ code: 'VOICE_TOKEN_REFRESH_UNCONFIRMED' });
      }
    })();
    pending = work;
    try { await work; } finally { if (pending === work) pending = null; }
  }
  return {
    start() { if (stopped || started || !validExpiry(expiresAt)) return; started = true; schedule(); },
    refresh,
    check() { if (live() && expiresAt - now() <= leadMs) { retries = 0; void refresh(); } },
    stop() { stopped = true; clear(); },
  };
}
