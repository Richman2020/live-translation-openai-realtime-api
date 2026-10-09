import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createControllerClient } from '../public/controller-client.js';

function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let index = 0; index < 50; index += 1) await Promise.resolve(); };
const response = (value: any, status = 200) => ({ ok: status < 400, status, json: async () => value });
function clock() {
  let time = 1000, id = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => time,
    setTimer(callback: () => void, delay: number) { timers.set(++id, { at: time + delay, callback }); return id; },
    clearTimer(key: number) { timers.delete(key); },
    async advance(ms: number) {
      const target = time + ms;
      for (let steps = 0; steps < 1000; steps += 1) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) { time = target; await flush(); return; }
        time = due[1].at; timers.delete(due[0]); due[1].callback(); await flush();
      }
      throw new Error('Timer loop');
    },
    jump(ms: number) { time += ms; },
    timers,
  };
}
function fixture() {
  const time = clock();
  const requests: any[] = [];
  let serverLease: any = null, active: any = null, epoch = 0, busy = false;
  const overrides = new Map<string, (request: any) => any>();
  const csrf = 'C'.repeat(43), capability = 'L'.repeat(43), join = 'J'.repeat(43);
  const fetchImpl = async (path: string, options: any) => {
    const entry = { path, options, body: options.body ? JSON.parse(options.body) : null };
    requests.push(entry);
    const route = path.split('?')[0];
    if (overrides.has(route)) return overrides.get(route)!(entry);
    if (route === '/api/browser-session') {
      const held = serverLease && serverLease.expiresAt > time.now();
      return response({ mode: 'controlled', csrfToken: csrf,
        controller: { mode: held ? 'held' : 'available', ownSession: !!held, tabMatches: !!held && new URL(path, 'https://test.example').searchParams.get('tabId') === serverLease.tabId, epoch, expiresAt: held ? serverLease.expiresAt : null },
        activeSession: active, busy, translationEngines: ['pocket-prefix', 'pocket-captions'], defaultTranslationEngine: 'pocket-prefix' });
    }
    if (route === '/api/controller/acquire') {
      if (serverLease && serverLease.expiresAt > time.now() || busy) return response({ error: 'CONTROLLER_BUSY' }, 409);
      serverLease = { tabId: entry.body.tabId, leaseId: capability, epoch: ++epoch, expiresAt: time.now() + 30000 };
      return response({ ...serverLease });
    }
    if (route === '/api/controller/renew') {
      if (!serverLease || entry.body.epoch !== serverLease.epoch || serverLease.expiresAt <= time.now()) return response({ error: 'FORBIDDEN' }, 403);
      serverLease.expiresAt = time.now() + 30000; return response({ ...serverLease });
    }
    if (route === '/api/controller/revoke') {
      if (!serverLease || entry.body?.epoch !== serverLease.epoch) return response({ error: 'FORBIDDEN' }, 403);
      serverLease = null; return response({ ok: true });
    }
    if (route === '/api/calls') {
      active = { id: 'call-1', status: 'connecting', to: entry.body.to, from: 'test', translationEngine: entry.body.translationEngine, translationReady: false, identity: 'private-identity', nonce: 'private-nonce' };
      busy = true; return response({ ...active });
    }
    if (route === '/api/calls/call-1/voice') return response({ token: 'FAKE_TOKEN_ONLY', join,
      params: { sessionId: 'call-1', nonce: 'test-nonce', join },
      grant: { callId: 'call-1', identity: 'fake-call-identity', incomingAllow: false, controller: { ...serverLease }, expiresAt: serverLease.expiresAt } });
    if (route.endsWith('/hangup')) {
      if (!serverLease || entry.body?.controller?.epoch !== serverLease.epoch) return response({ error: 'FORBIDDEN' }, 403);
      active = null; busy = false; return response({ ok: true });
    }
    throw new Error(`Unexpected route: ${route}`);
  };
  const clients: any[] = [];
  const makeClient = (tabId = `tab-${clients.length + 1}`) => {
    const client = createControllerClient({ fetchImpl, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
      randomTabId: () => tabId, requestTimeoutMs: 5000, operationTimeoutMs: 10000 });
    clients.push(client); return client;
  };
  const client = makeClient();
  const ready = async () => { await client.boot(); client.setConnectionState(true); await client.acquire(); return client; };
  return { time, client, makeClient, ready, requests, overrides, csrf, capability, join,
    setLease: (value: any) => { serverLease = value; }, lease: () => serverLease,
    setCall: (value: any) => { active = value; }, setBusy: (value: boolean) => { busy = value; },
    async close() { for (const item of clients) item.dispose(); await flush(); },
  };
}
const posts = (f: ReturnType<typeof fixture>, suffix?: string) => f.requests.filter(entry => entry.options.method === 'POST' && (!suffix || entry.path.endsWith(suffix)));
const callFixture = () => { let disconnected = 0; return { call: { disconnect: () => { disconnected += 1; } }, count: () => disconnected }; };

test('boot uses same-origin cookie and keeps CSRF, proof and Voice capabilities out of public state', async () => {
  const f = fixture(); await f.ready();
  assert.equal(f.requests[0].options.credentials, 'same-origin');
  assert.equal(f.requests[0].options.method, 'GET');
  assert.equal(f.requests[0].options.headers.authorization, undefined);
  assert.equal(posts(f)[0].options.headers['x-phone-csrf'], f.csrf);
  const sdk = callFixture(); let handedVoice: any;
  await f.client.startCall('+15550000000', { connectVoice: async (voice: any) => { handedVoice = voice; return sdk.call; } });
  assert.equal(handedVoice.token, 'FAKE_TOKEN_ONLY');
  assert.equal(handedVoice.params.sessionId, 'call-1');
  const state = JSON.stringify(f.client.state);
  for (const privateValue of [f.csrf, f.capability, f.join, 'FAKE_TOKEN_ONLY', 'private-identity', 'private-nonce']) assert.equal(state.includes(privateValue), false);
  assert.equal(f.client.state.call.translationEngine, 'pocket-prefix');
  await f.close();
});

test('new documents get independent tab identifiers and cannot recover a held lease from read-only state', async () => {
  const f = fixture(); await f.ready();
  const second = f.makeClient(); await second.boot(); second.setConnectionState(true);
  assert.notEqual(second.tabId, f.client.tabId);
  assert.equal(second.state.controller.ownSession, true);
  assert.equal(second.state.controller.tabMatches, false);
  assert.equal(second.state.lease, null);
  assert.equal(second.state.canControl, false);
  assert.equal(second.state.canAcquire, false);
  await assert.rejects(second.startCall('+15550000000', { connectVoice: async () => callFixture().call }), { code: 'CONTROL_REQUIRED' });
  assert.equal(posts(f, '/api/calls').length, 0); await f.close();
});

test('a new document that reads before old-page revoke stays read-only until an explicit current refresh', async () => {
  const f = fixture(); await f.ready();
  const reader = f.makeClient(); await reader.boot(); reader.setConnectionState(true);
  assert.equal(reader.state.controller.mode, 'held'); assert.equal(reader.state.canAcquire, false);
  const writes = posts(f).length;
  // Provider cleanup and controller revocation are independent. A reconnect
  // cannot turn an earlier held hint into an unproven available capability.
  f.setLease(null); f.setBusy(false); reader.setConnectionState(false); reader.setConnectionState(true);
  assert.equal(reader.state.canAcquire, false); assert.equal(reader.state.lease, null);
  assert.equal(posts(f).length, writes);
  await reader.refresh();
  assert.equal(reader.state.controller.mode, 'available'); assert.equal(reader.state.canAcquire, true);
  assert.equal(reader.state.lease, null); assert.equal(posts(f).length, writes);
  await f.close();
});

test('missing login disables every write and reports the server error code', async () => {
  const f = fixture(); f.overrides.set('/api/browser-session', () => response({ error: 'UNAUTHORIZED' }, 401));
  await f.client.boot(); f.client.setConnectionState(true);
  assert.equal(f.client.state.authenticated, false);
  assert.equal(f.client.state.error.code, 'UNAUTHORIZED');
  await assert.rejects(f.client.acquire(), { code: 'CONTROL_REQUIRED' });
  assert.equal(posts(f).length, 0); await f.close();
});

test('a controller conflict preserves its specific server diagnosis', async () => {
  const f = fixture(); await f.client.boot(); f.client.setConnectionState(true);
  f.overrides.set('/api/controller/acquire', () => response({ error: 'CONTROLLER_BUSY' }, 409));
  await assert.rejects(f.client.acquire(), { code: 'CONTROLLER_BUSY' });
  assert.equal(f.client.state.error.code, 'CONTROLLER_BUSY');
  assert.equal(f.client.state.canControl, false); await f.close();
});

test('double acquire makes one request and late cancelled acquisition is explicitly revoked', async () => {
  const f = fixture(); await f.client.boot(); f.client.setConnectionState(true);
  const held = deferred(); f.overrides.set('/api/controller/acquire', () => held.promise);
  const first = f.client.acquire(); const assertion = assert.rejects(first, { code: 'CALL_CANCELLED' }); await flush();
  await assert.rejects(f.client.acquire(), { code: 'CONTROLLER_BUSY' });
  await f.client.cancel();
  held.resolve(response({ tabId: f.client.tabId, leaseId: f.capability, epoch: 1, expiresAt: f.time.now() + 30000 }));
  await assertion; await flush();
  assert.equal(posts(f, '/api/controller/acquire').length, 1);
  assert.equal(posts(f, '/api/controller/revoke').length, 1);
  assert.equal(f.client.state.lease, null); await f.close();
});

test('acquisition cannot display an already expired grant as control', async () => {
  const f = fixture(); await f.client.boot(); f.client.setConnectionState(true);
  f.overrides.set('/api/controller/acquire', () => response({ tabId: f.client.tabId, leaseId: f.capability, epoch: 1, expiresAt: f.time.now() }));
  await assert.rejects(f.client.acquire(), { code: 'INVALID_RESPONSE' });
  assert.equal(f.client.state.canControl, false); await f.close();
});

test('duplicate dial during microphone preparation cannot create or join a second call', async () => {
  const f = fixture(); await f.ready(); const media = deferred(), sdk = callFixture();
  const dialing = f.client.startCall('+15550000000', { prepareMedia: () => media.promise, connectVoice: async () => sdk.call });
  await flush();
  await assert.rejects(f.client.startCall('+15550000000', { connectVoice: async () => sdk.call }), { code: 'CONTROL_REQUIRED' });
  assert.equal(posts(f, '/api/calls').length, 0);
  media.resolve(undefined); await dialing;
  assert.equal(posts(f, '/api/calls').length, 1); assert.equal(posts(f, '/voice').length, 1); await f.close();
});

test('cancelled microphone preparation cannot submit create even after media resolves', async () => {
  const f = fixture(); await f.ready(); const media = deferred(); let connected = 0;
  const dialing = f.client.startCall('+15550000000', { prepareMedia: () => media.promise, connectVoice: async () => { connected += 1; return callFixture().call; } });
  const rejected = assert.rejects(dialing, { code: 'CALL_CANCELLED' }); await flush();
  await f.client.cancel(); media.resolve(undefined); await rejected; await flush();
  assert.equal(posts(f, '/api/calls').length, 0); assert.equal(connected, 0); assert.equal(f.client.state.canControl, false); await f.close();
});

test('late create after cancel is hung up with the captured proof and cannot restore controls', async () => {
  const f = fixture(); await f.ready(); const creation = deferred();
  f.overrides.set('/api/calls', () => creation.promise);
  const dialing = f.client.startCall('+15550000000', { connectVoice: async () => callFixture().call });
  const rejected = assert.rejects(dialing, { code: 'CALL_CANCELLED' }); await flush(); await f.client.cancel(); await rejected;
  creation.resolve(response({ id: 'call-1', status: 'connecting' })); await flush();
  assert.equal(posts(f, '/hangup').length, 1);
  assert.equal(posts(f, '/hangup')[0].body.controller.leaseId, f.capability);
  assert.equal(posts(f, '/voice').length, 0); assert.equal(f.client.state.lease, null); await f.close();
});

test('Voice preparation returning after cancellation never reaches the SDK', async () => {
  const f = fixture(); await f.ready(); const preparing = deferred(); let connected = 0;
  f.overrides.set('/api/calls/call-1/voice', () => preparing.promise);
  const dialing = f.client.startCall('+15550000000', { connectVoice: async () => { connected += 1; return callFixture().call; } });
  const rejected = assert.rejects(dialing, { code: 'CALL_CANCELLED' }); await flush(); await f.client.cancel(); await rejected;
  preparing.resolve(response({ token: 'FAKE_TOKEN_ONLY' })); await flush();
  assert.equal(connected, 0); assert.equal(posts(f, '/hangup').length, 1); assert.equal(f.client.state.canControl, false); await f.close();
});

test('late SDK connect is disconnected and cannot replace a cancelled attempt', async () => {
  const f = fixture(); await f.ready(); const connecting = deferred(), sdk = callFixture();
  const dialing = f.client.startCall('+15550000000', { connectVoice: () => connecting.promise });
  const rejected = assert.rejects(dialing, { code: 'CALL_CANCELLED' }); await flush();
  assert.equal(f.client.state.phase, 'connecting'); await f.client.cancel(); await rejected;
  connecting.resolve(sdk.call); await flush();
  assert.equal(sdk.count(), 1); assert.equal(f.client.state.canMute, false); assert.equal(f.client.markVoiceAccepted('call-1'), false); await f.close();
});

test('a cross-call or old-epoch Voice response is rejected before SDK connect', async () => {
  for (const patch of [{ callId: 'other-call' }, { controller: { tabId: 'tab-1', leaseId: 'L'.repeat(43), epoch: 0 } }]) {
    const f = fixture(); await f.ready(); let connected = 0;
    f.overrides.set('/api/calls/call-1/voice', () => response({ token: 'FAKE_TOKEN_ONLY', join: f.join,
      params: { sessionId: 'call-1', nonce: 'test-nonce', join: f.join },
      grant: { callId: 'call-1', incomingAllow: false, controller: { ...f.lease() }, expiresAt: f.lease().expiresAt, ...patch } }));
    await assert.rejects(f.client.startCall('+15550000000', { connectVoice: async () => { connected += 1; return callFixture().call; } }), { code: 'INVALID_RESPONSE' });
    assert.equal(connected, 0); assert.equal(posts(f, '/hangup').length, 1); assert.equal(f.client.state.lease, null); await f.close();
  }
});

test('Pocket-only selection rejects legacy without modifying the ready controller', async () => {
  const f = fixture(); await f.ready();
  await assert.rejects(f.client.startCall('+15550000000', { translationEngine: 'legacy', connectVoice: async () => callFixture().call }), { code: 'INVALID_TRANSLATION_ENGINE' });
  assert.equal(posts(f, '/api/calls').length, 0); assert.equal(f.client.state.canStart, true); await f.close();
});

test('accepted SDK state remains active across status refresh and same-call events', async () => {
  const f = fixture(); await f.ready(); const sdk = callFixture();
  await f.client.startCall('+15550000000', { connectVoice: async () => sdk.call });
  assert.equal(f.client.markVoiceAccepted('call-1'), true);
  assert.equal(f.client.state.call.status, 'connecting');
  assert.equal(f.client.state.phase, 'active');
  await f.client.refresh(); f.client.handleEvent('call', { id: 'call-1', status: 'active', translationReady: true });
  assert.equal(f.client.state.phase, 'active'); assert.equal(f.client.state.canMute, true);
  assert.equal(f.client.handleEvent('call', { id: 'foreign-call', status: 'active' }), false); await f.close();
});

test('ordinary hangup can retain an unexpired lease but waits for server cleanup confirmation', async () => {
  const f = fixture(); await f.ready(); const sdk = callFixture(); await f.client.startCall('+15550000000', { connectVoice: async () => sdk.call });
  await f.client.cancel({ releaseControl: false });
  assert.equal(sdk.count(), 1); assert.equal(posts(f, '/api/controller/revoke').length, 0);
  assert.equal(f.client.state.cleanupPending, false); assert.equal(f.client.state.canStart, true); await f.close();
});

test('failed hangup stays read-only while authoritative cleanup gate remains busy', async () => {
  const f = fixture(); await f.ready(); await f.client.startCall('+15550000000', { connectVoice: async () => callFixture().call });
  f.overrides.set('/api/calls/call-1/hangup', () => response({ error: 'CALL_CLEANUP_UNCONFIRMED' }, 503));
  await f.client.cancel();
  assert.equal(f.client.state.cleanupPending, true); assert.equal(f.client.state.canStart, false); assert.equal(f.client.state.canAcquire, false);
  f.setCall(null); f.setBusy(true); await f.client.refresh(); assert.equal(f.client.state.cleanupPending, true);
  f.setBusy(false); await f.client.refresh(); assert.equal(f.client.state.cleanupPending, false); assert.equal(f.client.state.canAcquire, true); await f.close();
});

test('SSE snapshots, reconnects and reads never extend the controller deadline', async () => {
  const f = fixture(); await f.ready(); const initial = f.client.state.lease.expiresAt;
  f.client.setConnectionState(false); await f.time.advance(10000);
  f.client.setConnectionState(true); await f.client.refresh(); f.client.handleEvent('snapshot', { activeSession: null });
  await f.time.advance(5000);
  assert.equal(posts(f, '/api/controller/renew').length, 0); assert.equal(f.client.state.lease.expiresAt, initial); assert.equal(f.client.state.renewPaused, true);
  await f.client.renew(); assert.equal(posts(f, '/api/controller/renew').length, 1); assert.ok(f.client.state.lease.expiresAt > initial); await f.close();
});

test('explicit renewal timer maintains a visible connected controller without disabling existing call controls', async () => {
  const f = fixture(); await f.ready(); const initial = f.client.state.lease.expiresAt;
  await f.time.advance(10000);
  assert.equal(posts(f, '/api/controller/renew').length, 1); assert.ok(f.client.state.lease.expiresAt > initial); assert.equal(f.client.state.canControl, true); await f.close();
});

test('offline lease expiry disconnects browser media and requests both cleanup actions', async () => {
  const f = fixture(); await f.ready(); const sdk = callFixture(); await f.client.startCall('+15550000000', { connectVoice: async () => sdk.call });
  f.client.markVoiceAccepted('call-1'); f.client.setConnectionState(false); await f.time.advance(30000);
  assert.equal(sdk.count(), 1); assert.equal(f.client.state.lease, null); assert.equal(f.client.state.canMute, false);
  assert.equal(posts(f, '/hangup').length, 1); assert.equal(posts(f, '/api/controller/revoke').length, 1); assert.equal(posts(f, '/api/controller/renew').length, 0); await f.close();
});

test('hidden-page return checks absolute deadline even when browser timers were suspended', async () => {
  const f = fixture(); await f.ready(); const sdk = callFixture(); await f.client.startCall('+15550000000', { connectVoice: async () => sdk.call });
  f.client.markVoiceAccepted('call-1'); f.client.setVisible(false); f.time.jump(31000); f.client.setVisible(true); await flush();
  assert.equal(f.client.state.lease, null); assert.equal(f.client.state.canControl, false); assert.equal(sdk.count(), 1);
  assert.equal(posts(f, '/api/controller/renew').length, 0); await f.close();
});

test('revoked renew invalidates existing media and late responses cannot revive it', async () => {
  const f = fixture(); await f.ready(); const sdk = callFixture(); await f.client.startCall('+15550000000', { connectVoice: async () => sdk.call });
  f.overrides.set('/api/controller/renew', () => response({ error: 'FORBIDDEN' }, 403));
  await assert.rejects(f.client.renew(), { code: 'FORBIDDEN' }); await flush();
  assert.equal(f.client.state.lease, null); assert.equal(f.client.state.canControl, false); assert.equal(sdk.count(), 1); await f.close();
});

test('create timeout marks the result uncertain, then cleans a late server-created call', async () => {
  const f = fixture(); await f.ready(); const create = deferred(); f.overrides.set('/api/calls', () => create.promise);
  const dialing = f.client.startCall('+15550000000', { connectVoice: async () => callFixture().call });
  const rejected = assert.rejects(dialing, { code: 'REQUEST_TIMEOUT' }); await flush(); f.setBusy(true);
  await f.time.advance(5000); await rejected;
  assert.equal(f.client.state.canStart, false); assert.equal(f.client.state.cleanupPending, true);
  create.resolve(response({ id: 'call-1', status: 'connecting' })); await flush();
  assert.equal(posts(f, '/hangup').length, 1); assert.equal(posts(f, '/voice').length, 0); await f.close();
});

test('page disposal sends hangup and revoke independently even when hangup never resolves', async () => {
  const f = fixture(); await f.ready(); const sdk = callFixture(); await f.client.startCall('+15550000000', { connectVoice: async () => sdk.call });
  const hanging = deferred(); f.overrides.set('/api/calls/call-1/hangup', () => hanging.promise);
  f.client.dispose(); await flush();
  assert.equal(f.client.state.phase, 'disposed'); assert.equal(f.client.state.authenticated, false); assert.equal(sdk.count(), 1);
  assert.equal(posts(f, '/hangup').length, 1); assert.equal(posts(f, '/api/controller/revoke').length, 1);
  for (const entry of posts(f).filter(entry => entry.path.endsWith('/hangup') || entry.path.endsWith('/revoke'))) { assert.equal(entry.options.keepalive, true); assert.equal(entry.options.signal.aborted, false); }
  assert.equal(f.client.state.canControl, false); hanging.resolve(response({ ok: true })); await flush(); await f.close();
});

test('brief disconnect during Voice preparation fences the old attempt even after immediate reconnect', async () => {
  const f = fixture(); await f.ready(); const preparing = deferred(); let connected = 0;
  f.overrides.set('/api/calls/call-1/voice', () => preparing.promise);
  const dialing = f.client.startCall('+15550000000', { connectVoice: async () => { connected += 1; return callFixture().call; } });
  const rejected = assert.rejects(dialing, { code: 'CALL_CANCELLED' }); await flush();
  f.client.setConnectionState(false); f.client.setConnectionState(true); await rejected; await flush();
  preparing.resolve(response({ token: 'FAKE_TOKEN_ONLY' })); await flush();
  assert.equal(connected, 0); assert.equal(f.client.state.lease, null); assert.equal(posts(f, '/api/controller/renew').length, 0); await f.close();
});

test('brief hidden-page transition permanently fences an outstanding SDK connect', async () => {
  const f = fixture(); await f.ready(); const connecting = deferred(), sdk = callFixture();
  const dialing = f.client.startCall('+15550000000', { connectVoice: () => connecting.promise });
  const rejected = assert.rejects(dialing, { code: 'CALL_CANCELLED' }); await flush();
  f.client.setVisible(false); f.client.setVisible(true); await rejected; connecting.resolve(sdk.call); await flush();
  assert.equal(sdk.count(), 1); assert.equal(f.client.markVoiceAccepted('call-1'), false); assert.equal(f.client.state.canMute, false); await f.close();
});

test('a terminal event cannot unlock dialing before the authoritative cleanup read completes', async () => {
  const f = fixture(); await f.ready(); const sdk = callFixture(); await f.client.startCall('+15550000000', { connectVoice: async () => sdk.call });
  const reading = deferred(); f.overrides.set('/api/browser-session', () => reading.promise);
  assert.equal(f.client.handleEvent('call', { id: 'call-1', status: 'completed' }), true); await flush();
  assert.equal(f.client.state.cleanupPending, true); assert.equal(f.client.state.canStart, false); assert.equal(f.client.state.busy, true);
  const lease = f.lease();
  reading.resolve(response({ mode: 'controlled', csrfToken: f.csrf,
    controller: { mode: 'held', ownSession: true, tabMatches: true, epoch: lease.epoch, expiresAt: lease.expiresAt },
    activeSession: null, busy: false, translationEngines: ['pocket-prefix'], defaultTranslationEngine: 'pocket-prefix' }));
  await flush(); assert.equal(f.client.state.cleanupPending, false); assert.equal(f.client.state.canStart, true); await f.close();
});

test('terminal call identity remains available for a safe cleanup retry while the budget gate is busy', async () => {
  const f = fixture(); await f.ready(); await f.client.startCall('+15550000000', { connectVoice: async () => callFixture().call });
  f.setCall(null); f.setBusy(true);
  f.client.handleEvent('call', { id: 'call-1', status: 'completed' }); await flush();
  assert.equal(f.client.state.call.id, 'call-1'); assert.equal(f.client.state.cleanupPending, true); assert.equal(f.client.state.canHangup, true);
  await f.client.cancel({ releaseControl: false });
  assert.equal(posts(f, '/hangup').length, 1); assert.equal(posts(f, '/hangup')[0].body.controller.epoch, f.lease().epoch);
  assert.equal(f.client.state.cleanupPending, false); assert.equal(f.client.state.renewPaused, true); await f.close();
});

test('unknown acquire timeout cannot enable another acquire before a fresh read', async () => {
  const f = fixture(); await f.client.boot(); f.client.setConnectionState(true);
  const acquiring = deferred(); f.overrides.set('/api/controller/acquire', () => acquiring.promise);
  const start = f.client.acquire(), rejected = assert.rejects(start, { code: 'REQUEST_TIMEOUT' }); await flush();
  await f.time.advance(5000); await rejected;
  assert.equal(f.client.state.canAcquire, false); assert.equal(f.client.state.error.code, 'REQUEST_TIMEOUT');
  await f.client.refresh(); assert.equal(f.client.state.canAcquire, true);
  acquiring.resolve(response({ tabId: f.client.tabId, leaseId: f.capability, epoch: 1, expiresAt: f.time.now() + 30000 })); await flush(); await f.close();
});

test('failed refresh blocks new dialing until a successful current projection is read', async () => {
  const f = fixture(); await f.ready();
  f.overrides.set('/api/browser-session', () => { throw new Error('offline'); }); await f.client.refresh();
  assert.equal(f.client.state.canStart, false); assert.equal(f.client.state.canRenew, false);
  f.overrides.delete('/api/browser-session'); await f.client.refresh(); assert.equal(f.client.state.canStart, true); await f.close();
});

test('old terminal events cannot cancel a new microphone attempt before its call ID is bound', async () => {
  const f = fixture(); await f.ready(); const oldSdk = callFixture(); await f.client.startCall('+15550000000', { connectVoice: async () => oldSdk.call });
  await f.client.cancel({ releaseControl: false }); const media = deferred(), nextSdk = callFixture();
  const next = f.client.startCall('+15550000000', { prepareMedia: () => media.promise, connectVoice: async () => nextSdk.call }); await flush();
  assert.equal(f.client.handleEvent('call', { id: 'call-1', status: 'completed' }), false);
  assert.equal(f.client.handleEvent('call', { id: 'call-1', status: 'ending' }), false);
  assert.equal(f.client.state.phase, 'preparing'); media.resolve(undefined); await next;
  assert.equal(nextSdk.count(), 0); await f.close();
});

test('a late old creation cleans only its captured call and cannot disable a newer generation', async () => {
  const f = fixture(); await f.ready(); const oldCreation = deferred();
  f.overrides.set('/api/calls', () => oldCreation.promise);
  const oldStart = f.client.startCall('+15550000000', { connectVoice: async () => callFixture().call });
  const oldRejected = assert.rejects(oldStart, { code: 'CALL_CANCELLED' }); await flush(); await f.client.cancel(); await oldRejected;
  await f.client.acquire();
  f.overrides.set('/api/calls', () => { const next = { id: 'call-2', status: 'connecting' }; f.setCall(next); f.setBusy(true); return response(next); });
  f.overrides.set('/api/calls/call-2/voice', () => response({ token: 'FAKE_TOKEN_ONLY', join: f.join,
    params: { sessionId: 'call-2', nonce: 'test-nonce', join: f.join },
    grant: { callId: 'call-2', incomingAllow: false, controller: { ...f.lease() }, expiresAt: f.lease().expiresAt } }));
  const newSdk = callFixture(); await f.client.startCall('+15550000000', { connectVoice: async () => newSdk.call }); f.client.markVoiceAccepted('call-2');
  oldCreation.resolve(response({ id: 'call-1', status: 'connecting' })); await flush();
  assert.equal(f.client.state.call.id, 'call-2'); assert.equal(f.client.state.phase, 'active'); assert.equal(f.client.state.canMute, true);
  assert.equal(f.client.state.cleanupPending, false); assert.equal(newSdk.count(), 0);
  assert.equal(posts(f, '/api/calls/call-1/hangup')[0].body.controller.epoch, 1); await f.close();
});

test('the first connecting event can precede create HTTP without letting old terminal events retire its attempt', async () => {
  const f = fixture(); await f.ready(); await f.client.startCall('+15550000000', { connectVoice: async () => callFixture().call });
  await f.client.cancel({ releaseControl: false });
  const creation = deferred(); f.overrides.set('/api/calls', () => creation.promise);
  f.overrides.set('/api/calls/call-2/voice', () => response({ token: 'FAKE_TOKEN_ONLY', join: f.join,
    params: { sessionId: 'call-2', nonce: 'test-nonce', join: f.join },
    grant: { callId: 'call-2', incomingAllow: false, controller: { ...f.lease() }, expiresAt: f.lease().expiresAt } }));
  const sdk = callFixture(); const dialing = f.client.startCall('+15550000000', { connectVoice: async () => sdk.call }); await flush();
  assert.equal(f.client.handleEvent('call', { id: 'call-1', status: 'completed' }), false);
  assert.equal(f.client.handleEvent('call', { id: 'call-2', status: 'connecting' }), true);
  assert.equal(f.client.handleEvent('call', { id: 'call-1', status: 'ending' }), false);
  assert.equal(f.client.handleEvent('call', { id: 'unrelated', status: 'failed' }), false);
  assert.equal(f.client.state.call.id, 'call-2');
  creation.resolve(response({ id: 'call-2', status: 'connecting' })); await dialing;
  assert.equal(f.client.markVoiceAccepted('call-2'), true); assert.equal(sdk.count(), 0); await f.close();
});

test('read-only cancellation and disposal never send control writes for another tab\'s active call', async () => {
  const f = fixture(); await f.ready(); await f.client.startCall('+15550000000', { connectVoice: async () => callFixture().call });
  const reader = f.makeClient(); await reader.boot(); reader.setConnectionState(true);
  assert.equal(reader.state.call.id, 'call-1'); assert.equal(reader.state.lease, null);
  const before = posts(f).length;
  await reader.cancel();
  assert.equal(posts(f).length, before); assert.equal(reader.state.phase, 'readonly'); assert.equal(reader.state.cleanupPending, false);
  assert.equal(reader.state.call.id, 'call-1');
  reader.dispose(); await flush();
  assert.equal(posts(f).length, before); assert.equal(reader.state.phase, 'disposed');
  assert.equal(f.client.state.call.id, 'call-1'); assert.equal(f.client.state.cleanupPending, false); await f.close();
});

test('logout immediately retires local authority and late acquisition without exposing its CSRF', async () => {
  const f = fixture(); await f.client.boot(); f.client.setConnectionState(true);
  const acquired = deferred(); const logout = deferred();
  f.overrides.set('/api/controller/acquire', () => acquired.promise);
  f.overrides.set('/auth/logout', () => logout.promise);
  const pendingAcquire = f.client.acquire().catch((error: any) => error); await flush();
  const ending = f.client.logout(); await flush();
  assert.equal(f.client.state.authenticated, false); assert.equal(f.client.state.lease, null);
  assert.equal(f.client.state.canAcquire, false); assert.equal(f.client.state.canStart, false);
  assert.equal(posts(f, '/auth/logout').length, 1);
  assert.equal(posts(f, '/auth/logout')[0].options.headers['x-phone-csrf'], f.csrf);
  assert.equal(JSON.stringify(f.client.state).includes(f.csrf), false);
  await assert.rejects(f.client.logout(), { code: 'UNAUTHORIZED' });
  acquired.resolve(response({ tabId: f.client.tabId, leaseId: f.capability, epoch: 1, expiresAt: 31000 }));
  await pendingAcquire; logout.resolve(response({ ok: true })); await ending;
  assert.equal(f.client.state.authenticated, false); assert.equal(f.client.state.canControl, false);
  assert.equal(f.client.state.phase, 'readonly'); await f.close();
});

test('logout failure or timeout keeps all actions disabled and reports that server logout is unconfirmed', async () => {
  const f = fixture(); await f.ready();
  f.overrides.set('/auth/logout', () => response({ error: 'REQUEST_FAILED' }, 503));
  await assert.rejects(f.client.logout(), { code: 'LOGOUT_UNCONFIRMED' });
  assert.equal(f.client.state.authenticated, false); assert.equal(f.client.state.error.code, 'LOGOUT_UNCONFIRMED');
  assert.equal(f.client.state.canStart, false); assert.equal(f.client.state.canRenew, false);
  assert.equal(f.client.state.canHangup, false); await f.close();
});

test('an SDK connection resolving after successful logout is disconnected and cannot restore controls', async () => {
  const f = fixture(); await f.ready(); const connection = deferred();
  f.overrides.set('/auth/logout', () => response({ ok: true }));
  const sdk = callFixture();
  const dialing = f.client.startCall('+15550000000', { connectVoice: () => connection.promise }).catch((error: any) => error);
  await flush(); assert.equal(f.client.state.phase, 'connecting');
  await f.client.logout(); connection.resolve(sdk.call); await dialing; await flush();
  assert.ok(sdk.count() >= 1); assert.equal(f.client.state.authenticated, false);
  assert.equal(f.client.state.lease, null); assert.equal(f.client.state.canControl, false);
  assert.equal(f.client.state.canMute, false); assert.equal(f.client.state.phase, 'readonly'); await f.close();
});
