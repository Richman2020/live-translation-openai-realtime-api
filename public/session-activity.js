// Only real foreground user actions can enqueue a bounded renewal. No polling
// or visibility transition creates activity, and no authentication proof enters
// this module. The caller remains responsible for CSRF and server expiry checks.
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'input', 'change', 'wheel'];

export function createSessionActivity({
  renew,
  eventSource,
  visibilitySource = eventSource,
  lifecycleSource,
  now = () => Date.now(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (handle) => clearTimeout(handle),
  isForeground = () => true,
  acceptEvent = () => true,
  minIntervalMs = 30000,
  trailingMs = 1000,
  maxWaitMs = 30000,
}) {
  if (
    typeof renew !== 'function' ||
    !eventSource?.addEventListener ||
    ![minIntervalMs, trailingMs, maxWaitMs].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    trailingMs > maxWaitMs ||
    minIntervalMs > maxWaitMs
  )
    throw new Error('Invalid activity options');
  let authenticated = false;
  let expiresAt = 0;
  let paused = false;
  let disposed = false;
  let lastStarted = null;
  let latestActivity = null;
  let queuedSince = null;
  let timer = null;
  let flight = null;

  function clearQueue() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    latestActivity = null;
    queuedSince = null;
  }
  function suspend() {
    clearQueue();
    // Keep serialization even if a transport ignores AbortSignal. Its result
    // cannot create activity; the caller also fences its authentication result.
    flight?.controller.abort();
  }
  function usable() {
    return (
      !disposed &&
      authenticated &&
      !paused &&
      now() < expiresAt &&
      isForeground()
    );
  }
  function schedule() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (latestActivity === null || flight) return;
    if (!usable() || now() - latestActivity > maxWaitMs) {
      clearQueue();
      return;
    }
    const due =
      lastStarted === null
        ? now()
        : Math.max(
            lastStarted + minIntervalMs,
            Math.min(latestActivity + trailingMs, queuedSince + maxWaitMs),
          );
    // An already expired session is never renewed, including a throttled timer
    // waking after the deadline. The server is the authority on any extension.
    if (due >= expiresAt) {
      clearQueue();
      return;
    }
    timer = setTimer(
      () => {
        timer = null;
        void flush();
      },
      Math.max(0, due - now()),
    );
  }
  async function flush() {
    if (
      !usable() ||
      latestActivity === null ||
      now() - latestActivity > maxWaitMs
    ) {
      clearQueue();
      return;
    }
    if (flight) return;
    const current = { controller: new AbortController() };
    flight = current;
    lastStarted = now();
    latestActivity = null;
    queuedSince = null;
    try {
      await renew({ signal: current.controller.signal });
    } catch {
      /* The authenticated transport reports failures; activity never retries by itself. */
    } finally {
      if (flight === current) {
        flight = null;
        schedule();
      }
    }
  }
  function activity(event) {
    if (
      !ACTIVITY_EVENTS.includes(event?.type) ||
      event.isTrusted !== true ||
      !usable() ||
      !acceptEvent(event)
    )
      return;
    latestActivity = now();
    queuedSince ??= latestActivity;
    schedule();
  }
  function visibilityChanged() {
    if (!isForeground()) suspend();
  }
  function updateSession(session) {
    if (disposed) return;
    if (
      session?.authenticated !== true ||
      !Number.isSafeInteger(session.expiresAt) ||
      session.expiresAt <= now()
    ) {
      authenticated = false;
      expiresAt = 0;
      lastStarted = null;
      suspend();
      return;
    }
    authenticated = true;
    expiresAt = session.expiresAt;
    paused = session.paused === true;
    if (paused || !isForeground()) suspend();
    else schedule();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    authenticated = false;
    expiresAt = 0;
    suspend();
    for (const type of ACTIVITY_EVENTS)
      eventSource.removeEventListener(type, activity, true);
    visibilitySource?.removeEventListener(
      'visibilitychange',
      visibilityChanged,
    );
    lifecycleSource?.removeEventListener('pagehide', dispose);
    lifecycleSource?.removeEventListener('blur', suspend);
  }
  for (const type of ACTIVITY_EVENTS)
    eventSource.addEventListener(type, activity, {
      capture: true,
      passive: true,
    });
  visibilitySource?.addEventListener('visibilitychange', visibilityChanged);
  lifecycleSource?.addEventListener('pagehide', dispose);
  lifecycleSource?.addEventListener('blur', suspend);
  return {
    updateSession,
    dispose,
    get snapshot() {
      return {
        authenticated,
        expiresAt,
        paused,
        disposed,
        pending: timer !== null,
        inFlight: flight !== null,
      };
    },
  };
}
