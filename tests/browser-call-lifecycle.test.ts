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

test('audio diagnostics distinguish generated, sent and playback, isolate old sessions and reset for a new call', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  await f.element('start-call').events.click();
  const entry = { role: 'local', recipientRole: 'remote', generatedBytes: 8000, sentBytes: 8000 };
  f.audioEvent({ ...entry, stage: 'generated' });
  f.audioEvent({ ...entry, stage: 'sent' });
  assert.match(f.element('audio-delivery-local').textContent, /生成 1 段 · 已送出 1 段 · 线路确认播放 0 段/);
  f.audioEvent({ ...entry, stage: 'playback_confirmed', sessionId: 'retired' });
  f.audioEvent({ ...entry, stage: 'playback_confirmed', recipientRole: 'local' });
  assert.match(f.element('audio-delivery-local').textContent, /线路确认播放 0 段/);
  f.audioEvent({ ...entry, stage: 'playback_confirmed' });
  assert.match(f.element('audio-delivery-local').textContent, /线路确认播放 1 段/);
  assert.match(f.element('audio-delivery-remote').textContent, /尚无译音记录/);
  f.audioEvent({ role: 'remote', recipientRole: 'local', generatedBytes: 0, sentBytes: 0, stage: 'generated' });
  assert.match(f.element('audio-delivery-remote').textContent, /1 段未生成声音/);
  await f.element('end-call').events.click();
  await f.element('start-call').events.click();
  assert.match(f.element('audio-delivery-local').textContent, /尚无译音记录/);
});

test('31603 preserves cleanup while avoiding a claim that the destination phone declined', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  await f.element('start-call').events.click();
  f.outgoingCall().emit('error', { code: 31603 });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(f.element('app-error').textContent, /31603.*公网语音入口中断/);
  assert.ok(f.requests.some(path => path.includes('/hangup')));
});

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
  const lifecycle = createCallLifecycle({ requestMedia: async constraints => {
    requests += 1;
    for (const key of ['echoCancellation', 'noiseSuppression', 'autoGainControl']) assert.deepEqual(constraints.audio[key], { ideal: true });
    return f.stream;
  } });
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

test('capture reads actual processing booleans without copying device identifiers and clears them on cancel', async () => {
  const stream = { getAudioTracks: () => [{ getSettings: () => ({ echoCancellation: true, noiseSuppression: false, autoGainControl: 'unknown', deviceId: 'private-device', groupId: 'private-group' }) }] };
  const lifecycle = createCallLifecycle({ requestMedia: async () => stream });
  const attempt = lifecycle.begin();
  assert.equal(attempt.microphoneProcessing, null);
  await lifecycle.prepareMicrophone(attempt);
  assert.deepEqual(attempt.microphoneProcessing, { echoCancellation: true, noiseSuppression: false, autoGainControl: null });
  await lifecycle.useMicrophone(attempt, { audio: true });
  assert.equal(attempt.microphoneProcessing.echoCancellation, true);
  lifecycle.cancel(attempt);
  assert.equal(attempt.microphoneProcessing, null);
  assert.equal(lifecycle.begin().microphoneProcessing, null);
});

test('missing or throwing microphone settings never prevent handing capture to the SDK', async t => {
  for (const [name, stream] of Object.entries({
    missingTracks: {},
    missingSettings: { getAudioTracks: () => [{}] },
    emptySettings: { getAudioTracks: () => [{ getSettings: () => undefined }] },
    throwingSettings: { getAudioTracks: () => [{ getSettings: () => { throw new Error('device detail'); } }] },
  })) {
    await t.test(name, async () => {
      const lifecycle = createCallLifecycle({ requestMedia: async () => stream });
      const attempt = lifecycle.begin();
      await lifecycle.prepareMicrophone(attempt);
      assert.deepEqual(attempt.microphoneProcessing, { echoCancellation: null, noiseSuppression: null, autoGainControl: null });
      assert.equal(await lifecycle.useMicrophone(attempt, { audio: true }), stream);
      lifecycle.cancel();
    });
  }
});

test('SDK capture without a prepared stream preserves explicit device and processing choices', async () => {
  const requests: unknown[] = [];
  const lifecycle = createCallLifecycle({ requestMedia: async constraints => { requests.push(constraints); return streamFixture().stream; } });
  const constraints = { audio: { deviceId: { exact: 'selected' }, echoCancellation: false }, video: false };
  const original = structuredClone(constraints);
  const attempt = lifecycle.begin();
  await lifecycle.useMicrophone(attempt, constraints);
  assert.deepEqual(constraints, original, 'caller constraints are not mutated');
  assert.deepEqual(requests[0], { audio: { ...constraints.audio, noiseSuppression: { ideal: true }, autoGainControl: { ideal: true } }, video: false });
  await lifecycle.useMicrophone(attempt, { audio: false });
  assert.deepEqual(requests[1], { audio: false });
  lifecycle.cancel();
});

test('page reports actual capture settings and clears them after hangup', async () => {
  const stream = { ...streamFixture().stream, getAudioTracks: () => [{ getSettings: () => ({ echoCancellation: true, noiseSuppression: false }) }] };
  const f = await pageFixture(async () => stream);
  await f.element('start-call').events.click();
  assert.match(f.element('microphone-processing').textContent, /回声消除已开启.*降噪未开启.*自动音量浏览器未报告/);
  await f.element('end-call').events.click();
  assert.match(f.element('microphone-processing').textContent, /拨号或接听后显示/);
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
  assert.equal(current.microphoneProcessing, null);
  assert.equal(old.microphoneProcessing, null);
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
  assert.equal(attempt.microphoneProcessing, null);
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
async function pageFixture(requestMedia: (constraints: unknown) => Promise<unknown>, now: () => number = () => Date.now()) {
  const nodes = new Map<string, any>();
  function node(): any {
    return {
      textContent: '', value: '', hidden: false, disabled: false, dataset: {}, children: [], events: {},
      classList: { toggle() {}, add() {} }, style: { setProperty() {} },
      setAttribute() {}, removeAttribute() {}, focus() {},
      append(...children: any[]) { for (const child of children) { this.children.push(child); child.parentNode = this; } },
      replaceChildren(...children: any[]) { this.children = []; this.append(...children); },
      insertBefore(child: any, next: any) {
        const index = next ? this.children.indexOf(next) : this.children.length;
        assert.ok(index >= 0, 'insertBefore requires an existing sibling');
        this.children.splice(index, 0, child); child.parentNode = this;
      },
      replaceWith(child: any) { this.parentNode.insertBefore(child, this); this.remove(); },
      remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; },
      click() { this.events.click?.(); },
      querySelector() { return this.child || (this.child = node()); }, querySelectorAll() { return []; },
      addEventListener(name: string, handler: unknown) { this.events[name] = handler; },
    };
  }
  const element = (id: string) => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const requests: string[] = [];
  const sdkLogs: string[] = [];
  const exports: Blob[] = [];
  const localValues = new Map();
  let activeSession: any = null;
  let sessionCounter = 0;
  let mediaHandedToSdk: unknown;
  let sdkConnects = 0;
  let device: any;
  let outgoingCall: any;
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
    audio = Object.assign(new EventEmitter(), {
      isOutputSelectionSupported: true,
      availableOutputDevices: new Map([['default', { deviceId: 'default', label: 'Default speaker' }], ['headset', { deviceId: 'headset', label: 'Headphones' }]]),
      speakerDevices: {
        active: 'default',
        get() { return new Set([{ deviceId: this.active }]); },
        async set(id: string) { this.active = id; },
      },
    });
    constructor(_token: string, options: unknown) { super(); this.options = options; device = this; }
    async register() { this.emit('registered'); }
    async unregister() { this.emit('unregistered'); }
    destroy() {}
    async connect() { sdkConnects += 1; mediaHandedToSdk = await this.options.getUserMedia({ audio: true }); outgoingCall = new FakeCall(); return outgoingCall; }
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
    audioOutputModule: await import('../public/audio-output.js'),
    lifecycleModule: { createCallLifecycle, createDeviceMediaOwner, microphoneMessages: (await import('../public/call-lifecycle.js')).microphoneMessages },
    document: { getElementById: element, querySelector: element, querySelectorAll: () => [], createElement: node, createElementNS: node, body: node() },
    window: { Twilio: { Device: FakeDevice }, history: { replaceState() {} }, addEventListener() {}, scrollTo() {} },
    navigator: { mediaDevices: { getUserMedia: requestMedia } },
    location: { hash: '#token=offline-test-access-only', pathname: '/', search: '' },
    sessionStorage: { getItem: () => null, setItem() {} }, localStorage: { getItem: (key: string) => localValues.get(key) ?? null, setItem: (key: string, value: string) => localValues.set(key, value) },
    URLSearchParams, AbortController, structuredClone, EventSource: FakeEvents, Blob,
    URL: { createObjectURL: (blob: Blob) => { exports.push(blob); return 'blob:offline-export'; }, revokeObjectURL() {} },
    Date: class extends Date { static now() { return now(); } },
    console: { info: (...values: string[]) => sdkLogs.push(values.join(' ')) },
    setTimeout: (...args: Parameters<typeof setTimeout>) => { const timer = setTimeout(...args); timer.unref(); return timer; }, clearTimeout, setInterval: () => 1, clearInterval() {},
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
  await vm.runInContext(source.replace(importLine, 'lifecycleModule').replace("await import('./audio-output.js')", 'audioOutputModule'), context);
  await new Promise(resolve => setImmediate(resolve));
  sources[0].onopen();
  await new Promise(resolve => setImmediate(resolve));
  await element('enable-device').events.click();
  element('phone-number').value = '+12125551234';
  return {
    element, requests, device, sdkLogs, exports, outgoingCall: () => outgoingCall, sdkConnects: () => sdkConnects, media: () => mediaHandedToSdk,
    transcriptEvent(value: Record<string, unknown>) {
      sources[0].handlers.get('transcript')({ data: JSON.stringify({ sessionId: activeSession?.id, at: '2026-09-26T01:00:00.000Z', ...value }) });
    },
    translationEvent(value: Record<string, unknown>) {
      sources[0].handlers.get('translation-connection')({ data: JSON.stringify(value) });
    },
    audioEvent(value: Record<string, unknown>) {
      sources[0].handlers.get('translation-audio')({ data: JSON.stringify({ sessionId: activeSession?.id, ...value }) });
    },
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

test('signaling errors allow SDK recovery without ending the call or logging private SDK data', async () => {
  const stream = streamFixture();
  const f = await pageFixture(async () => stream.stream);
  await f.element('start-call').events.click();
  assert.equal(f.device.options.maxCallSignalingTimeoutMs, 30000);
  const call = f.outgoingCall();
  const error = { code: 31005, message: 'private-message', token: 'private-token', CallSid: 'private-call-id', sdp: 'private-sdp' };
  f.device.emit('error', error);
  call.emit('reconnecting', { ...error, code: 53001 });
  assert.match(f.element('bridge-caption').textContent, /正在恢复/);
  call.emit('warning', 'low-bytes-sent', error);
  call.emit('warning', 'private-warning');
  call.emit('warning-cleared', 'low-bytes-sent', error);
  call.emit('reconnected');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.some(path => path.endsWith('/hangup')), false);
  assert.equal(stream.stopped(), 0);
  assert.doesNotMatch(f.element('bridge-caption').textContent, /正在恢复/);
  const logs = f.sdkLogs.join('\n');
  assert.match(logs, /device-error.*31005/);
  assert.match(logs, /call-reconnecting.*53001/);
  assert.match(logs, /call-reconnected/);
  assert.match(logs, /call-warning.*low-bytes-sent/);
  assert.doesNotMatch(logs, /private-|CallSid|sdp|token/i);
  await f.element('end-call').events.click();
  assert.ok(f.requests.some(path => path.endsWith('/hangup')));
});

test('a terminal SDK call error still cleans up the backend session', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  await f.element('start-call').events.click();
  f.outgoingCall().emit('error', { code: 31005, message: 'private-gateway-hangup' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.requests.some(path => path.endsWith('/hangup')));
  assert.match(f.sdkLogs.join('\n'), /call-error.*31005/);
  assert.doesNotMatch(f.sdkLogs.join('\n'), /private-gateway-hangup/);
});

test('translation recovery tracks both roles independently and ignores stale or private event data', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  await f.element('start-call').events.click();
  f.callEvent({ status: 'active' });
  const event = { sessionId: 'session-1', role: 'remote', state: 'reconnecting', closeCode: 1006, text: 'private-text', token: 'private-token' };
  f.translationEvent({ ...event, sessionId: 'old-session' });
  assert.doesNotMatch(f.element('bridge-caption').textContent, /翻译短暂中断/);
  f.translationEvent(event);
  assert.match(f.element('bridge-caption').textContent, /翻译短暂中断.*重说/);
  f.translationEvent({ ...event, role: 'local' });
  f.translationEvent({ ...event, state: 'ready' });
  assert.equal(f.element('connection-text').textContent, '正在恢复翻译连接');
  f.translationEvent({ ...event, state: 'ready', role: 'local' });
  assert.match(f.element('bridge-caption').textContent, /翻译连接已恢复.*重说/);
  assert.equal(f.requests.some(path => path.endsWith('/hangup')), false);
  const logs = f.sdkLogs.join('\n');
  assert.match(logs, /remote.*reconnecting.*1006/);
  assert.doesNotMatch(logs, /private-|sessionId|old-session/);
  await f.element('end-call').events.click();
  await f.element('start-call').events.click();
  f.callEvent({ status: 'active' });
  f.translationEvent(event);
  assert.doesNotMatch(f.element('bridge-caption').textContent, /恢复|重说/);
  await f.element('end-call').events.click();
});

test('sound detection and SDK quality warnings remain separate and reset for the next call', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  await f.element('start-call').events.click();
  f.callEvent({ status: 'active' });
  const call = f.outgoingCall();
  call.emit('volume', 0, 0);
  call.emit('warning', 'constant-audio-input-level');
  assert.match(f.element('call-hint').textContent, /尚未检测.*安静时正常/);
  assert.equal(f.element('connection-text').textContent, '通话中');
  call.emit('volume', 0.08, 0.04);
  call.emit('volume', 0, 0);
  assert.equal(f.element('call-hint').textContent, '本次已检测到麦克风声音');
  call.emit('warning', 'low-bytes-sent');
  call.emit('warning', 'high-packet-loss');
  assert.match(f.element('connection-text').textContent, /连接质量异常/);
  call.emit('warning-cleared', 'low-bytes-sent');
  assert.match(f.element('connection-text').textContent, /连接质量异常/);
  call.emit('warning-cleared', 'high-packet-loss');
  assert.equal(f.element('connection-text').textContent, '通话中');
  assert.equal(f.requests.some(path => path.endsWith('/hangup')), false);
  await f.element('end-call').events.click();
  await f.element('start-call').events.click();
  f.callEvent({ status: 'active' });
  call.emit('volume', 0.8, 0.4);
  call.emit('warning', 'low-bytes-sent');
  assert.equal(f.element('call-hint').textContent, '麦克风已就绪');
  assert.equal(f.element('connection-text').textContent, '通话中');
  await f.element('end-call').events.click();
});

test('RTC diagnostic logs are rate limited, retain SDK units, and include only allowed finite numeric fields', async () => {
  let now = 10000;
  const f = await pageFixture(async () => streamFixture().stream, () => now);
  await f.element('start-call').events.click();
  const call = f.outgoingCall();
  const sample = {
    bytesSent: 1400, bytesReceived: 1600, packetsLost: 2, packetsLostFraction: 12.5,
    audioInputLevel: 1000, audioOutputLevel: 1200, callSid: 'private-call', ip: 'private-ip', sdp: 'private-sdp',
    audio: 'private-audio', token: 'private-token', extra: 123, totals: { bytesSent: 999999 },
  };
  call.emit('volume', 0.07, 0.12);
  call.emit('volume', 0.02, 0.03);
  now += 4999; call.emit('sample', sample);
  assert.equal(f.sdkLogs.filter(log => log.startsWith('[AI Phone RTC]')).length, 0);
  now += 1; call.emit('sample', sample); call.emit('sample', sample);
  const entries = () => f.sdkLogs.filter(log => log.startsWith('[AI Phone RTC]')).map(log => JSON.parse(log.slice('[AI Phone RTC] '.length)));
  assert.deepEqual(entries(), [{ bytesSent: 1400, bytesReceived: 1600, packetsLost: 2, packetLossPercent: 12.5, audioInputLevel: 1000, audioOutputLevel: 1200, inputVolumePeak: 0.07, outputVolumePeak: 0.12 }]);
  call.emit('volume', NaN, Infinity);
  now += 5000;
  call.emit('sample', { ...sample, bytesSent: Infinity, bytesReceived: '1600', packetsLost: -1, packetsLostFraction: NaN, audioInputLevel: 32768, audioOutputLevel: null });
  assert.equal(entries().length, 1, 'invalid numbers are omitted, not represented as successful zero readings');
  assert.doesNotMatch(f.sdkLogs.join('\n'), /private-|callSid|sdp|token|totals/);
  await f.element('end-call').events.click();
  now += 5000; call.emit('sample', sample);
  assert.equal(entries().length, 1, 'ended calls cannot keep logging RTC samples');
});

test('confirmed cleanup clears its stale banner while preserving unrelated SDK and provider errors', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  await f.element('start-call').events.click();
  f.callEvent({ status: 'ending', cleanupUnconfirmed: true, error: 'CALL_CLEANUP_UNCONFIRMED' });
  assert.match(f.element('app-error').textContent, /线路关闭待确认/);
  f.callEvent({ status: 'completed', cleanupUnconfirmed: false, error: undefined });
  assert.equal(f.element('app-error').hidden, true);
  assert.equal(f.element('end-call').disabled, true);
  await f.element('start-call').events.click();
  f.callEvent({ status: 'ending', cleanupUnconfirmed: true, error: 'CALL_CLEANUP_UNCONFIRMED' });
  f.device.emit('error', { code: 31005 });
  f.callEvent({ status: 'completed', cleanupUnconfirmed: false, error: undefined });
  assert.equal(f.element('app-error').hidden, false);
  assert.match(f.element('app-error').textContent, /31005/);
  await f.element('start-call').events.click();
  f.callEvent({ status: 'ending', cleanupUnconfirmed: true, error: 'CALL_CLEANUP_UNCONFIRMED' });
  f.callEvent({ status: 'failed', cleanupUnconfirmed: false, error: 'TWILIO_CALL_FAILED', providerErrorCode: 21216, providerHttpStatus: 400 });
  assert.equal(f.element('app-error').hidden, false);
  assert.match(f.element('app-error').textContent, /21216/);
});

test('transcripts pair by role, item and content index despite reversed arrival, consistently in history and export', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  f.element('save-history-toggle').events.click();
  await f.element('start-call').events.click();
  const emit = (role: string, kind: string, index: number, text: string, at: string) => f.transcriptEvent({ id: `${role}:${kind}:shared:${index}`, role, kind, text, final: true, at });
  emit('local', 'translation', 0, 'Local translation zero', '2026-09-26T02:00:00.000Z');
  const firstTranslation = f.element('transcript').children[0];
  emit('remote', 'original', 0, 'Remote original zero', '2026-09-26T01:00:00.000Z');
  emit('local', 'translation', 1, 'Local translation one', '2026-09-26T00:00:00.000Z');
  emit('remote', 'translation', 0, 'Remote translation zero', '2026-09-26T03:00:00.000Z');
  emit('local', 'original', 1, 'Local original one', '2026-09-26T04:00:00.000Z');
  emit('local', 'original', 0, 'Local original zero', '2026-09-26T05:00:00.000Z');
  const expected = ['local:original:shared:0', 'local:translation:shared:0', 'remote:original:shared:0', 'remote:translation:shared:0', 'local:original:shared:1', 'local:translation:shared:1'];
  const ids = (id: string) => f.element(id).children.map((child: any) => child.dataset.transcriptId).filter(Boolean);
  assert.deepEqual(ids('transcript'), expected);
  assert.equal(f.element('transcript').children[1], firstTranslation, 'late original inserts before its existing translation without redrawing it');
  f.element('export-current').events.click();
  const text = await f.exports[0].text();
  const lines = text.split('\r\n').filter(line => line.startsWith('['));
  assert.deepEqual(lines, ['[你 · 原文] Local original zero', '[你 · 译文] Local translation zero', '[对方 · 原文] Remote original zero', '[对方 · 译文] Remote translation zero', '[你 · 原文] Local original one', '[你 · 译文] Local translation one']);
  f.callEvent({ status: 'completed' });
  assert.deepEqual(ids('history-detail'), expected);
});

test('output selection controls bind the SDK and cannot reroute during a call', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  assert.equal(f.element('audio-output').value, 'default');
  f.element('audio-output').value = 'headset';
  await f.element('audio-output').events.change();
  assert.equal(f.device.audio.speakerDevices.active, 'headset');
  assert.equal(f.requests.some(path => path === 'POST /api/calls'), false);
  await f.element('start-call').events.click();
  assert.equal(f.element('audio-output').disabled, true);
  assert.equal(f.element('test-audio-output').disabled, true);
  f.element('audio-output').value = 'default';
  await f.element('audio-output').events.change();
  assert.equal(f.device.audio.speakerDevices.active, 'headset');
  await f.element('end-call').events.click();
  assert.equal(f.element('audio-output').disabled, false);
});

test('playback diagnostics track active players, ignore a retired temporary player and clear old listeners', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  await f.element('start-call').events.click();
  const player = () => Object.assign(new EventEmitter(), {
    paused: false, muted: false, volume: 1, error: null,
    addEventListener: EventEmitter.prototype.on,
    removeEventListener: EventEmitter.prototype.removeListener,
  });
  const master = player(); const temporary = player();
  f.outgoingCall().emit('audio', master);
  f.outgoingCall().emit('audio', temporary);
  temporary.paused = true; temporary.emit('pause');
  assert.match(f.element('browser-playback').textContent, /播放器处于播放状态/);
  assert.match(f.element('browser-playback').textContent, /仍需确认耳机听感/);
  f.outgoingCall().emit('volume', 0, 0.2);
  assert.match(f.element('browser-playback').textContent, /本次已检测到接收声音/);
  master.muted = true; master.emit('volumechange');
  assert.match(f.element('browser-playback').textContent, /播放器已静音/);
  await f.element('end-call').events.click();
  assert.equal(master.listenerCount('playing'), 0);
  assert.equal(temporary.listenerCount('pause'), 0);
  master.emit('playing');
  assert.match(f.element('browser-playback').textContent, /将在通话时显示/);
});

test('a pending output switch blocks outgoing and incoming media until actual SDK settlement', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  const pending = deferred<void>();
  f.device.audio.speakerDevices.set = async () => { await pending.promise; f.device.audio.speakerDevices.active = 'headset'; };
  f.element('audio-output').value = 'headset';
  const selection = f.element('audio-output').events.change();
  assert.equal(f.element('start-call').disabled, true);
  await f.element('start-call').events.click();
  assert.equal(f.sdkConnects(), 0);
  const incoming = f.incoming();
  assert.equal(incoming.rejected, 1);
  pending.resolve(); await selection;
  assert.equal(f.element('start-call').disabled, false);
});

test('partial transcript updates replace only their own paired row and keep final text in exports', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  await f.element('start-call').events.click();
  const original = { id: 'local:original:turn_a:0', role: 'local', kind: 'original' };
  const translation = { id: 'local:translation:turn_a:0', role: 'local', kind: 'translation' };
  f.transcriptEvent({ ...translation, text: 'Where', final: false });
  f.transcriptEvent({ ...original, text: '哪里？', final: true });
  const originalNode = f.element('transcript').children[0];
  f.transcriptEvent({ ...translation, text: 'Where is it?', final: true });
  const children = f.element('transcript').children;
  assert.equal(children.length, 2);
  assert.equal(children[0], originalNode);
  assert.equal(children[1].children[1].children[0].textContent, 'Where is it?');
  assert.equal(children[1].children[0].children[2].textContent, '');
  f.element('export-current').events.click();
  const text = await f.exports[0].text();
  assert.match(text, /\[你 · 原文\] 哪里？\r\n\[你 · 译文\] Where is it\?/);
  assert.doesNotMatch(text, /未定稿/);
  await f.element('end-call').events.click();
});
