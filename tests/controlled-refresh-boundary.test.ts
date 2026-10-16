import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createControllerClient } from '../public/controller-client.js';

// These deterministic contract tests exercise the real controller with local
// Promise gates. They do not claim to reproduce CI #73's unknown event order.
// The workbench's terminal-event -> hangup boundary is modeled explicitly; a
// controller-only test must not mistake that missing outer action for a bug.
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const flush = async () => {
  for (let index = 0; index < 100; index += 1) await Promise.resolve();
};
const response = (value: any) => ({ ok: true, status: 200, json: async () => value });
const terminal = (status: string) =>
  ['completed', 'failed', 'canceled', 'busy', 'no-answer', 'rejected'].includes(status);

function fixture() {
  let timerSequence = 0;
  let lease: any = null, active: any = null, busy = false;
  let readGate: ReturnType<typeof deferred> | null = null;
  let readStarted: ReturnType<typeof deferred> | null = null;
  let hangupGate: ReturnType<typeof deferred> | null = null;
  let disconnects = 0;
  const now = () => 1000;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const routes: string[] = [];
  const pending = new Set<Promise<unknown>>();
  const projection = () => ({
    mode: 'controlled', csrfToken: 'C'.repeat(43),
    controller: {
      mode: lease ? 'held' : 'available', ownSession: Boolean(lease),
      tabMatches: Boolean(lease), epoch: lease?.epoch ?? 1,
      expiresAt: lease?.expiresAt ?? null,
    },
    activeSession: active ? { ...active } : null, busy,
    translationEngines: ['pocket-prefix'], defaultTranslationEngine: 'pocket-prefix',
    outgoingPairedCaptions: true,
  });
  const fetchImpl = async (path: string) => {
    const route = path.split('?')[0];
    routes.push(route);
    let value: any;
    if (route === '/api/browser-session') {
      // Capture at dispatch, allowing an old active response to arrive after
      // the server has ended the call. No retry or wall-clock sleep is used.
      value = projection();
      if (readGate) {
        const gate = readGate; readGate = null;
        readStarted?.resolve(undefined); await gate.promise;
      }
    } else if (route === '/api/controller/acquire') {
      lease = { tabId: 'offline-tab', leaseId: 'L'.repeat(43), epoch: 1, expiresAt: now() + 30000 };
      value = { ...lease };
    } else if (route === '/api/calls') {
      active = {
        id: 'offline-call-1', status: 'connecting',
        translationEngine: 'pocket-prefix', translationReady: true,
      };
      busy = true; value = { ...active };
    } else if (route.endsWith('/voice')) {
      value = {
        token: 'OFFLINE_ONLY', join: 'J'.repeat(43),
        params: { sessionId: active.id, nonce: 'OFFLINE_NONCE', join: 'J'.repeat(43) },
        grant: {
          callId: active.id, identity: 'offline-identity', incomingAllow: false,
          controller: { ...lease }, expiresAt: lease.expiresAt,
        },
      };
    } else if (route.endsWith('/hangup')) {
      if (hangupGate) await hangupGate.promise;
      active = null; busy = false; value = { ok: true };
    } else if (route === '/api/controller/revoke') {
      lease = null; value = { ok: true };
    } else if (route === '/api/controller/renew') {
      lease.expiresAt = now() + 30000; value = { ...lease };
    } else throw new Error(`Unexpected local fixture route: ${route}`);
    return response(value);
  };
  const client = createControllerClient({
    fetchImpl, now, randomTabId: () => 'offline-tab',
    setTimer(callback: () => void, delay: number) {
      const key = ++timerSequence; timers.set(key, { callback, delay }); return key;
    },
    clearTimer(key: number) { timers.delete(key); },
    requestTimeoutMs: 5000, operationTimeoutMs: 10000,
  });
  const track = (promise: Promise<unknown>) => {
    pending.add(promise);
    // Attach both handlers: a fixture failure must remain observed by settle().
    void promise.then(() => pending.delete(promise), () => {});
    return promise;
  };
  return {
    client, routes,
    async accept() {
      await client.boot(); client.setConnectionState(true); await client.acquire();
      await client.startCall('+15550000000', {
        connectVoice: async () => ({ disconnect() { disconnects += 1; } }),
      });
      active.status = 'active'; client.handleEvent('call', { ...active });
      assert.equal(client.markVoiceAccepted('offline-call-1'), true);
      assert.equal(client.state.canMute, true);
    },
    pauseRead() {
      const gate = deferred(); readGate = gate; readStarted = deferred();
      return { release: () => gate.resolve(), started: readStarted.promise };
    },
    pauseHangup() {
      const gate = deferred(); hangupGate = gate;
      return () => { gate.resolve(); hangupGate = null; };
    },
    endServer() { active = null; busy = false; },
    openSse() {
      // Mirrors the workbench onopen: reconnect then read fresh server state.
      client.setConnectionState(true); return track(client.refresh());
    },
    closeSse() { client.setConnectionState(false); },
    deliver(type: string, value: any, { outer = true } = {}) {
      const applied = client.handleEvent(type, value);
      const received = type === 'call' ? value : value?.activeSession;
      // Mirrors controlled-workbench.js's current terminal release boundary.
      if (outer && applied && received?.id === client.state.call?.id &&
          terminal(received.status) && !received.cleanupUnconfirmed)
        track(client.hangup());
      return applied;
    },
    async settle() { await flush(); await Promise.all([...pending]); await flush(); },
    assertFinished() {
      assert.equal(client.state.phase, 'readonly');
      assert.equal(client.state.canMute, false);
      assert.equal(client.state.lease, null);
    },
    disconnects: () => disconnects,
    async close() { client.dispose(); await flush(); },
  };
}

test('accepted mute is not a refresh-read or SSE-ready barrier', async t => {
  const f = fixture(); t.after(() => f.close()); await f.accept();
  f.closeSse(); const gate = f.pauseRead();
  const refreshing = f.client.refresh(); await gate.started;
  assert.equal(f.client.state.connection, 'disconnected');
  assert.equal(f.client.state.canMute, true);
  f.endServer();
  assert.equal(f.client.state.phase, 'active');
  assert.equal(f.client.state.canMute, true);
  gate.release(); await refreshing;
  assert.equal(f.client.state.canMute, true);
  await f.openSse(); await f.settle(); f.assertFinished();
});

test('fresh SSE-open read ends accepted media when the terminal event was missed', async t => {
  const f = fixture(); t.after(() => f.close()); await f.accept();
  f.closeSse(); f.endServer(); await f.openSse(); await f.settle();
  f.assertFinished(); assert.equal(f.disconnects(), 1);
});

test('terminal event before idle read settles through the workbench hangup boundary', async t => {
  const f = fixture(); t.after(() => f.close()); await f.accept();
  const gate = f.pauseRead();
  f.deliver('call', { id: 'offline-call-1', status: 'completed' }); await gate.started;
  assert.equal(f.client.state.canMute, false);
  assert.equal(f.client.state.cleanupPending, true);
  gate.release(); await f.settle(); f.assertFinished();
});

test('controller-only terminal state requires the explicit outer workbench release', async t => {
  const f = fixture(); t.after(() => f.close()); await f.accept(); f.endServer();
  f.deliver('call', { id: 'offline-call-1', status: 'completed' }, { outer: false });
  await f.settle();
  assert.equal(f.client.state.phase, 'ready');
  assert.equal(f.client.state.canMute, false);
  assert.ok(f.client.state.lease);
  await f.client.hangup(); await f.settle(); f.assertFinished();
});

test('idle read before a delayed terminal event cannot restore mute or retired SDK acceptance', async t => {
  const f = fixture(); t.after(() => f.close()); await f.accept();
  f.endServer(); await f.client.refresh(); await f.settle(); f.assertFinished();
  f.deliver('call', { id: 'offline-call-1', status: 'completed' });
  await f.settle(); f.assertFinished();
  assert.equal(f.client.markVoiceAccepted('offline-call-1'), false);
});

test('media disconnect disables mute during gated cleanup and settles only on completion', async t => {
  const f = fixture(); t.after(() => f.close()); await f.accept();
  const release = f.pauseHangup();
  assert.equal(f.client.handleVoiceDisconnected('offline-call-1'), true); await flush();
  assert.equal(f.client.state.phase, 'ending');
  assert.equal(f.client.state.canMute, false);
  assert.equal(f.client.state.cleanupPending, true);
  assert.equal(f.client.state.canDial, false);
  release(); await f.settle(); f.assertFinished();
});

test('late reconnect read cannot revive canceled SDK ownership or create another call', async t => {
  const f = fixture(); t.after(() => f.close()); await f.accept(); f.closeSse();
  const gate = f.pauseRead(), opened = f.openSse(); await gate.started;
  assert.equal(f.client.handleVoiceDisconnected('offline-call-1'), true); await flush();
  gate.release(); await opened; await f.settle(); f.assertFinished();
  assert.equal(f.client.markVoiceAccepted('offline-call-1'), false);
  assert.equal(f.routes.filter(route => route === '/api/calls').length, 1);
});
