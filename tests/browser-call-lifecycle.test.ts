import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { createCallLifecycle, createDeviceMediaOwner, microphoneErrorCode } from '../public/call-lifecycle.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function streamFixture() {
  let stopped = 0;
  const stream = { getTracks: () => [{ stop: () => { stopped += 1; } }] };
  return { stream, stopped: () => stopped };
}

test('a timed-out attempt cannot clear a newer call when its SDK connection rejects late', async () => {
  const lifecycle = createCallLifecycle();
  const old = lifecycle.begin('old');
  const pending = deferred<unknown>();
  const oldResult = lifecycle.connect(old, () => pending.promise);
  lifecycle.cancel(old);
  const next = lifecycle.begin('new');
  let newDisconnects = 0;
  const newCall = { disconnect: () => { newDisconnects += 1; } };
  assert.equal(await lifecycle.connect(next, async () => newCall), newCall);
  pending.reject(new Error('late SDK failure'));
  assert.equal(await oldResult, null);
  assert.equal(lifecycle.current, next);
  assert.equal(newDisconnects, 0);
  assert.equal(lifecycle.update(old, { phase: 'connected' }), false);
});

test('late successful SDK connection disconnects only the superseded call', async () => {
  const lifecycle = createCallLifecycle();
  const old = lifecycle.begin();
  const pending = deferred<unknown>();
  const oldResult = lifecycle.connect(old, () => pending.promise);
  const current = lifecycle.begin();
  let disconnected = 0;
  pending.resolve({ disconnect: () => { disconnected += 1; } });
  assert.equal(await oldResult, null);
  assert.equal(disconnected, 1);
  assert.equal(lifecycle.current, current);
});

test('a retired SDK media override cannot consume a newer attempt microphone after late connect resumes', async () => {
  const firstStream = streamFixture();
  const nextStream = streamFixture();
  let count = 0;
  const lifecycle = createCallLifecycle({ requestMedia: async () => (++count === 1 ? firstStream.stream : nextStream.stream) });
  const firstOwner = createDeviceMediaOwner(lifecycle);
  const old = lifecycle.begin();
  await lifecycle.prepareMicrophone(old);
  const resumeOldSdk = deferred<void>();
  const oldConnection = firstOwner.connect(old, async () => {
    await resumeOldSdk.promise;
    await firstOwner.getUserMedia({ audio: true });
    throw new Error('retired SDK must not receive a media stream');
  });
  lifecycle.cancel(old);
  assert.equal(firstOwner.retireIfPending(old), true);
  const nextOwner = createDeviceMediaOwner(lifecycle);
  const current = lifecycle.begin();
  await lifecycle.prepareMicrophone(current);
  nextOwner.bind(current);
  resumeOldSdk.resolve();
  assert.equal(await oldConnection, null);
  assert.equal(firstStream.stopped(), 1);
  assert.equal(nextStream.stopped(), 0);
  assert.equal(await nextOwner.getUserMedia({ audio: true }), nextStream.stream);
  assert.equal(nextStream.stopped(), 0);
});

test('microphone preparation requests once and hands the same live stream to the SDK', async () => {
  const f = streamFixture();
  let requests = 0;
  const lifecycle = createCallLifecycle({ requestMedia: async constraints => { requests += 1; assert.deepEqual(constraints, { audio: true }); return f.stream; } });
  const attempt = lifecycle.begin();
  await lifecycle.prepareMicrophone(attempt);
  assert.equal(attempt.microphoneReady, true);
  assert.equal(attempt.phase, 'preparing');
  assert.equal(await lifecycle.useMicrophone(attempt, { audio: true }), f.stream);
  assert.equal(requests, 1);
  assert.equal(attempt.phase, 'signaling');
  lifecycle.cancel(attempt);
  assert.equal(f.stopped(), 0, 'the SDK owns tracks once handed over; lifecycle must not cut normal audio');
});

test('canceling preparation stops a stream which has not yet been handed to the SDK', async () => {
  const f = streamFixture();
  const lifecycle = createCallLifecycle({ requestMedia: async () => f.stream });
  const attempt = lifecycle.begin();
  await lifecycle.prepareMicrophone(attempt);
  lifecycle.cancel(attempt);
  assert.equal(f.stopped(), 1);
  await assert.rejects(lifecycle.useMicrophone(attempt, {}), { code: 'CALL_CANCELLED' });
});

test('canceling an unanswered permission prompt rejects promptly and stops a late stream', async () => {
  const pending = deferred<unknown>();
  const f = streamFixture();
  const lifecycle = createCallLifecycle({ requestMedia: () => pending.promise });
  const old = lifecycle.begin();
  const prepared = lifecycle.prepareMicrophone(old);
  const rejected = assert.rejects(prepared, { code: 'CALL_CANCELLED' });
  await Promise.resolve();
  assert.equal(old.phase, 'microphone');
  lifecycle.cancel(old);
  await rejected;
  const current = lifecycle.begin();
  pending.resolve(f.stream);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.stopped(), 1);
  assert.equal(lifecycle.current, current);
  assert.equal(current.microphoneReady, false);
});

test('unanswered microphone permission is bounded and a later grant cannot revive it', async () => {
  const pending = deferred<unknown>();
  const f = streamFixture();
  const lifecycle = createCallLifecycle({ requestMedia: () => pending.promise, mediaTimeoutMs: 10 });
  const attempt = lifecycle.begin();
  await assert.rejects(lifecycle.prepareMicrophone(attempt), { code: 'MICROPHONE_TIMEOUT' });
  assert.equal(attempt.failureCode, 'MICROPHONE_TIMEOUT');
  assert.equal(attempt.microphoneReady, false);
  pending.resolve(f.stream);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.stopped(), 1);
  assert.equal(attempt.microphoneReady, false);
});

test('microphone errors distinguish permissions, absent devices and unavailable hardware', async t => {
  for (const [name, expected] of [
    ['NotAllowedError', 'MICROPHONE_PERMISSION_DENIED'],
    ['NotFoundError', 'MICROPHONE_NOT_FOUND'],
    ['NotReadableError', 'MICROPHONE_UNAVAILABLE'],
    ['UnexpectedError', 'MICROPHONE_FAILED'],
  ]) {
    await t.test(name, async () => {
      const error = Object.assign(new Error('private device detail'), { name });
      const lifecycle = createCallLifecycle({ requestMedia: async () => { throw error; } });
      const attempt = lifecycle.begin();
      await assert.rejects(lifecycle.prepareMicrophone(attempt), error);
      assert.equal(microphoneErrorCode(error), expected);
      assert.equal(attempt.failureCode, expected);
      assert.equal(attempt.microphoneReady, false);
      lifecycle.cancel();
    });
  }
});

test('a browser without mediaDevices reports unsupported without claiming microphone readiness', async () => {
  const lifecycle = createCallLifecycle();
  const attempt = lifecycle.begin();
  await assert.rejects(lifecycle.prepareMicrophone(attempt), { code: 'MICROPHONE_UNSUPPORTED' });
  assert.equal(attempt.failureCode, 'MICROPHONE_UNSUPPORTED');
  assert.equal(attempt.microphoneReady, false);
});

// Run the shipped page handlers offline, with inert DOM, media and provider fixtures.
async function pageFixture(requestMedia: (constraints: unknown) => Promise<unknown>) {
  const nodes = new Map<string, any>();
  function node(): any {
    return {
      textContent: '', value: '', hidden: false, disabled: false, dataset: {}, children: [], events: {},
      classList: { toggle() {}, add() {} }, style: { setProperty() {} },
      setAttribute() {}, removeAttribute() {}, focus() {},
      append(...children: unknown[]) { this.children.push(...children); },
      replaceChildren(...children: unknown[]) { this.children = children; },
      querySelector() { return this.child || (this.child = node()); }, querySelectorAll() { return []; },
      addEventListener(name: string, handler: unknown) { this.events[name] = handler; },
    };
  }
  const element = (id: string) => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const requests: string[] = [];
  let activeSession: any = null;
  let sessionCounter = 0;
  let mediaHandedToSdk: unknown;
  let sdkConnects = 0;
  let device: any;
  class FakeCall extends EventEmitter {
    state: string;
    rejected = 0;
    constructor(state = 'connecting') { super(); this.state = state; }
    status() { return this.state; }
    disconnect() { if (this.state !== 'pending') this.emit('disconnect'); }
    reject() { this.rejected += 1; this.emit('reject'); }
  }
  class FakeDevice extends EventEmitter {
    options: any;
    constructor(_token: string, options: unknown) { super(); this.options = options; device = this; }
    async register() { this.emit('registered'); }
    async unregister() { this.emit('unregistered'); }
    destroy() {}
    async connect() { sdkConnects += 1; mediaHandedToSdk = await this.options.getUserMedia({ audio: true }); return new FakeCall(); }
  }
  const sources: any[] = [];
  class FakeEvents {
    onopen?: () => void;
    handlers = new Map();
    constructor() { sources.push(this); }
    addEventListener(name: string, handler: unknown) { this.handlers.set(name, handler); }
    close() {}
  }
  const context = vm.createContext({
    lifecycleModule: { createCallLifecycle, createDeviceMediaOwner, microphoneMessages: (await import('../public/call-lifecycle.js')).microphoneMessages },
    document: { getElementById: element, querySelector: element, querySelectorAll: () => [], createElement: node, createElementNS: node, body: node() },
    window: { Twilio: { Device: FakeDevice }, history: { replaceState() {} }, addEventListener() {}, scrollTo() {} },
    navigator: { mediaDevices: { getUserMedia: requestMedia } },
    location: { hash: '#token=offline-test-access-only', pathname: '/', search: '' },
    sessionStorage: { getItem: () => null, setItem() {} }, localStorage: { getItem: () => null, setItem() {} },
    URLSearchParams, AbortController, structuredClone, EventSource: FakeEvents,
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    fetch: async (path: string, options: any = {}) => {
      requests.push(`${options.method || 'GET'} ${path}`);
      let payload: any = { ok: true };
      if (path === '/api/status') payload = { configured: true, activeSession, checks: [] };
      if (path === '/api/token') payload = { token: 'offline-sdk-token' };
      if (path === '/api/calls') {
        activeSession = { id: `session-${++sessionCounter}`, status: 'connecting', direction: 'outbound', to: '+12125551234' };
        payload = { ...activeSession, connectionParams: { sessionId: activeSession.id, nonce: 'offline-nonce' } };
      }
      if (path.endsWith('/hangup')) activeSession = null;
      return { ok: true, json: async () => payload };
    },
  });
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const importLine = "await import('./call-lifecycle.js')";
  assert.ok(source.includes(importLine));
  await vm.runInContext(source.replace(importLine, 'lifecycleModule'), context);
  await new Promise(resolve => setImmediate(resolve));
  sources[0].onopen();
  await new Promise(resolve => setImmediate(resolve));
  await element('enable-device').events.click();
  element('phone-number').value = '+12125551234';
  return {
    element, requests, device, sdkConnects: () => sdkConnects, media: () => mediaHandedToSdk,
    callEvent(patch: Record<string, unknown>) {
      assert.ok(activeSession, 'create a call before delivering its provider event');
      activeSession = { ...activeSession, ...patch };
      sources[0].handlers.get('call')({ data: JSON.stringify(activeSession) });
      if (['failed', 'completed'].includes(activeSession.status)) activeSession = null;
    },
    incoming() {
      activeSession = { id: `incoming-${++sessionCounter}`, direction: 'inbound', status: 'ringing', from: '+12125551234' };
      const call = new FakeCall('pending');
      device.emit('incoming', call);
      return call;
    },
  };
}

test('real page handlers create no call while microphone permission is pending or canceled', async () => {
  const pending = deferred<unknown>();
  const stream = streamFixture();
  const f = await pageFixture(() => pending.promise);
  const dialing = f.element('start-call').events.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.element('call-hint').textContent, '正在等待麦克风');
  assert.equal(f.element('end-call-label').textContent, '取消准备');
  assert.equal(f.requests.includes('POST /api/calls'), false);
  await f.element('end-call').events.click();
  await dialing;
  pending.resolve(stream.stream);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stream.stopped(), 1);
  assert.equal(f.requests.includes('POST /api/calls'), false);
  assert.equal(f.sdkConnects(), 0);
  assert.equal(f.element('start-call').disabled, false);
});

test('real page handlers reuse authorized microphone media and distinguish permission denial', async () => {
  const stream = streamFixture();
  let requests = 0;
  const ready = await pageFixture(async () => { requests += 1; return stream.stream; });
  await ready.element('start-call').events.click();
  assert.equal(requests, 1);
  assert.equal(ready.media(), stream.stream);
  assert.equal(ready.sdkConnects(), 1);
  assert.equal(ready.requests.filter(path => path === 'POST /api/calls').length, 1);
  assert.equal(stream.stopped(), 0);
  await ready.element('end-call').events.click();

  const denied = await pageFixture(async () => { throw Object.assign(new Error('private details'), { name: 'NotAllowedError' }); });
  await denied.element('start-call').events.click();
  assert.match(denied.element('app-error').textContent, /麦克风访问未获允许/);
  assert.equal(denied.requests.includes('POST /api/calls'), false);
  assert.equal(denied.element('start-call').disabled, false);
});

test('a rejected provider call event visibly identifies Twilio 21216 without inventing its cause or retaining a busy call', async () => {
  const stream = streamFixture();
  const f = await pageFixture(async () => stream.stream);
  await f.element('start-call').events.click();
  assert.equal(f.element('start-call').disabled, true);
  f.callEvent({ status: 'failed', error: 'TWILIO_CALL_FAILED', providerErrorCode: 21216, providerHttpStatus: 400, message: 'private-provider-message' });
  assert.equal(f.element('app-error').hidden, false);
  const message = f.element('app-error').textContent;
  assert.match(message, /Twilio 已拦截这次外呼/);
  assert.match(message, /Trust Hub/);
  assert.match(message, /21216/);
  assert.match(message, /HTTP 400/);
  assert.doesNotMatch(message, /Business|必须|余额|private-provider-message/);
  assert.equal(f.element('start-call').disabled, false);
  assert.equal(f.element('end-call').disabled, true);
});

test('hanging up an incoming call before its status snapshot rejects SDK ringing and finds the backend session', async () => {
  const f = await pageFixture(async () => { throw new Error('must not request a microphone'); });
  const call = f.incoming();
  await f.element('end-call').events.click();
  assert.equal(call.rejected, 1, 'pending incoming calls require reject; disconnect is a no-op');
  assert.ok(f.requests.includes('POST /api/calls/incoming-1/hangup'));
});

test('incoming cancellation during microphone permission releases late media and never accepts', async () => {
  const media = deferred<unknown>();
  const stream = streamFixture();
  const f = await pageFixture(() => media.promise);
  const call = f.incoming();
  await new Promise(resolve => setImmediate(resolve));
  const accepting = f.element('accept-call').events.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.element('accept-call').disabled, true);
  call.emit('cancel');
  await accepting;
  media.resolve(stream.stream);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stream.stopped(), 1);
  assert.ok(f.requests.includes('POST /api/calls/incoming-1/hangup'));
  assert.equal(f.element('incoming-banner').hidden, true);
});
