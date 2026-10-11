// Page identity and scheduling only. Authentication proof stays in the caller.
// Every physical page gets a fresh in-memory identity; no storage is consulted.
export function createSessionPageLease({
  renew,
  close,
  onExpire = () => {},
  eventSource,
  now = () => Date.now(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (handle) => clearTimeout(handle),
  createPageId = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  },
}) {
  if (
    typeof renew !== 'function' ||
    typeof close !== 'function' ||
    !eventSource?.addEventListener
  )
    throw new Error('Invalid page lease options');
  let pageId = createPageId();
  if (!/^[A-Za-z0-9_-]{43}$/.test(pageId))
    throw new Error('Invalid page identity');
  let sequence = 0;
  let authenticated = false;
  let expiresAt = 0;
  let paused = false;
  let disposed = false;
  let timer = null;
  let flight = null;
  let due = 0;
  let resumeRequested = false;
  const clear = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const abort = () => {
    flight?.controller.abort();
  };
  function expire() {
    authenticated = false;
    expiresAt = 0;
    clear();
    abort();
    onExpire();
  }
  function schedule() {
    clear();
    if (disposed || !authenticated) return;
    if (now() >= expiresAt) {
      expire();
      return;
    }
    // Always retain a finite expiry wake-up, even during a stalled request.
    const next = paused || flight ? expiresAt : Math.min(expiresAt, due);
    timer = setTimer(
      () => {
        timer = null;
        void pulse();
      },
      Math.max(0, next - now()),
    );
  }
  async function pulse() {
    if (disposed || !authenticated) return;
    if (now() >= expiresAt) {
      expire();
      return;
    }
    if (paused || flight) {
      schedule();
      return;
    }
    const current = { controller: new AbortController() };
    flight = current;
    due = now() + 60000;
    const resume = resumeRequested;
    resumeRequested = false;
    schedule();
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await renew({
          pageId,
          sequence: ++sequence,
          state: 'open',
          signal: current.controller.signal,
          resume: resume || attempt > 0,
        });
        if (
          result?.retired !== true ||
          attempt > 0 ||
          disposed ||
          !authenticated ||
          current.controller.signal.aborted ||
          now() >= expiresAt
        )
          break;
        // The transport re-read the authenticated session after a server 409.
        // Replace the tombstoned page identity, never reopen that old identity.
        pageId = createPageId();
        if (!/^[A-Za-z0-9_-]{43}$/.test(pageId))
          throw new Error('Invalid page identity');
        sequence = 0;
      }
    } catch {
      /* Transport preserves confirmed expiry and reports retry state. */
    } finally {
      if (flight === current) {
        flight = null;
        schedule();
      }
    }
  }
  function resume() {
    if (disposed || !authenticated) return;
    resumeRequested = true;
    due = now();
    schedule();
  }
  function offline() {
    abort();
  }
  function updateSession(session) {
    if (disposed) return;
    const valid =
      session?.authenticated === true &&
      Number.isSafeInteger(session.expiresAt) &&
      session.expiresAt > now();
    if (!valid) {
      authenticated = false;
      expiresAt = 0;
      clear();
      abort();
      return;
    }
    if (!authenticated) {
      // A server-expired page ID is tombstoned even when another tab keeps the
      // login alive. Only a newly confirmed session can start a fresh lease.
      if (sequence > 0) {
        pageId = createPageId();
        if (!/^[A-Za-z0-9_-]{43}$/.test(pageId))
          throw new Error('Invalid page identity');
        sequence = 0;
      }
      due = now();
    }
    authenticated = true;
    expiresAt = session.expiresAt;
    paused = session.paused === true;
    if (paused) abort();
    schedule();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    clear();
    abort();
    // A higher sequence closes over a pending open, even if abort was too late.
    if (authenticated && now() < expiresAt) {
      try {
        Promise.resolve(
          close({ pageId, sequence: ++sequence, state: 'close' }),
        ).catch(() => {});
      } catch {
        /* Best effort only; the server's finite lease remains authoritative. */
      }
    }
    authenticated = false;
    expiresAt = 0;
    eventSource.removeEventListener('online', resume);
    eventSource.removeEventListener('pageshow', resume);
    eventSource.removeEventListener('offline', offline);
    eventSource.removeEventListener('pagehide', dispose);
  }
  eventSource.addEventListener('online', resume);
  eventSource.addEventListener('pageshow', resume);
  eventSource.addEventListener('offline', offline);
  eventSource.addEventListener('pagehide', dispose);
  return {
    updateSession,
    dispose,
    resume,
    get snapshot() {
      return {
        pageId,
        sequence,
        authenticated,
        expiresAt,
        disposed,
        inFlight: !!flight,
        pending: timer !== null,
      };
    },
  };
}
