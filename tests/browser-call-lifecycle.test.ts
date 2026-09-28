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

test('translation timing displays each direction with milliseconds converted to seconds and genuine zero components', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  await f.element('start-call').events.click();
  f.callEvent({ status: 'active', translationReady: true });
  f.metricEvent({ role: 'local', value: 2300, transcriptionMs: 800, queueMs: 0, generationMs: 1500 });
  assert.equal(f.element('translation-timing-local').textContent,
    '英语 → 手机最近一句：服务端停说事件 → 首个译音数据 2.30 秒（等待转写 0.80 秒 · 等待发起 0.00 秒 · 生成首音 1.50 秒）');
  assert.match(f.element('translation-timing-remote').textContent, /尚无服务端计时/);
  f.metricEvent({ role: 'remote', value: 45125, transcriptionMs: 30000, queueMs: 125, generationMs: 15000 });
  assert.equal(f.element('translation-timing-remote').textContent,
    '中文 → 电脑最近一句：服务端停说事件 → 首个译音数据 45.13 秒（等待转写 30.00 秒 · 等待发起 0.13 秒 · 生成首音 15.00 秒）');
  f.metricEvent({ role: 'local', at: 1001, value: 0, transcriptionMs: 0, queueMs: 0, generationMs: 0 });
  assert.match(f.element('translation-timing-local').textContent, /首个译音数据 0\.00 秒（等待转写 0\.00 秒 · 等待发起 0\.00 秒 · 生成首音 0\.00 秒）/);
  assert.match(f.element('translation-timing-remote').textContent, /45\.13 秒/);
});

test('translation timing ignores wrong metric scope, invalid totals and malformed timestamps without overwriting valid data', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  await f.element('start-call').events.click();
  const valid = { role: 'local', value: 1200, transcriptionMs: 300, queueMs: 100, generationMs: 800 };
  f.metricEvent(valid);
  const expected = f.element('translation-timing-local').textContent;
  const invalid: Record<string, unknown>[] = [
    { scope: 'end_to_end' }, { name: 'round_trip_ms' }, { role: 'unknown' },
    { value: -1 }, { value: null }, { value: undefined }, { value: '1200' },
    { value: Infinity }, { value: NaN },
    { at: null }, { at: undefined }, { at: '1001' }, { at: Infinity },
  ];
  for (const patch of invalid) {
    f.metricEvent({ ...valid, at: 1001, ...patch });
    assert.equal(f.element('translation-timing-local').textContent, expected, `invalid metric ${JSON.stringify(patch)}`);
    assert.match(f.element('translation-timing-remote').textContent, /尚无服务端计时/);
  }
});

test('translation timing reports unavailable components when fields are missing, invalid or do not add up', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  await f.element('start-call').events.click();
  const valid = { role: 'local', value: 2000, transcriptionMs: 500, queueMs: 250, generationMs: 1250 };
  const invalid: Record<string, unknown>[] = [
    { transcriptionMs: undefined }, { queueMs: undefined }, { generationMs: undefined },
    { transcriptionMs: null }, { queueMs: '250' }, { generationMs: -1 },
    { generationMs: Infinity }, { generationMs: 0 }, { generationMs: 1251 },
  ];
  let at = 1000;
  for (const patch of invalid) {
    f.metricEvent({ ...valid, at: at++ });
    assert.match(f.element('translation-timing-local').textContent, /等待转写 0\.50 秒/);
    f.metricEvent({ ...valid, at: at++, ...patch });
    assert.equal(f.element('translation-timing-local').textContent,
      '英语 → 手机最近一句：服务端停说事件 → 首个译音数据 2.00 秒（分项时间不可用）');
  }
});

test('translation timing isolates sessions, freezes during ending and after completion, and clears both directions for the next call', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  const metric = { role: 'local', value: 1000, transcriptionMs: 200, queueMs: 0, generationMs: 800 };
  f.metricEvent({ ...metric, sessionId: 'session-1' });
  assert.match(f.element('translation-timing-local').textContent, /尚无服务端计时/);
  await f.element('start-call').events.click();
  f.metricEvent(metric);
  f.metricEvent({ ...metric, role: 'remote' });
  const local = f.element('translation-timing-local').textContent;
  const remote = f.element('translation-timing-remote').textContent;
  f.metricEvent({ ...metric, at: 1001, value: 9000, sessionId: 'retired-session' });
  assert.equal(f.element('translation-timing-local').textContent, local);
  f.callEvent({ status: 'ending' });
  f.metricEvent({ ...metric, at: 1002, value: 9000 });
  assert.equal(f.element('translation-timing-local').textContent, local);
  f.callEvent({ status: 'completed' });
  for (const role of ['local', 'remote']) f.metricEvent({ ...metric, role, at: 1003, value: 9000, sessionId: 'session-1' });
  assert.equal(f.element('translation-timing-local').textContent, local);
  assert.equal(f.element('translation-timing-remote').textContent, remote);
  await f.element('start-call').events.click();
  for (const role of ['local', 'remote']) {
    assert.match(f.element(`translation-timing-${role}`).textContent, /尚无服务端计时/);
    f.metricEvent({ ...metric, role, at: 1004, sessionId: 'session-1' });
    assert.match(f.element(`translation-timing-${role}`).textContent, /尚无服务端计时/);
  }
  f.metricEvent({ ...metric, value: 700, at: 1, transcriptionMs: 100, generationMs: 600 });
  assert.match(f.element('translation-timing-local').textContent, /首个译音数据 0\.70 秒/);
});

test('translation timing keeps the most recent event per direction without imposing ordering across directions', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  await f.element('start-call').events.click();
  f.metricEvent({ role: 'local', at: 2000, value: 1100 });
  const latest = f.element('translation-timing-local').textContent;
  f.metricEvent({ role: 'local', at: 1999, value: 9999 });
  assert.equal(f.element('translation-timing-local').textContent, latest);
  f.metricEvent({ role: 'remote', at: 1000, value: 2200 });
  assert.match(f.element('translation-timing-remote').textContent, /首个译音数据 2\.20 秒/);
  f.metricEvent({ role: 'local', at: 2001, value: 1500 });
  assert.match(f.element('translation-timing-local').textContent, /首个译音数据 1\.50 秒/);
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

test('selected input is frozen for the attempt and survives SDK reacquisition of default', async () => {
  const requests: any[] = [];
  const stream = { ...streamFixture().stream, getAudioTracks: () => [{ label: 'Meeting N earphone', getSettings: () => ({ deviceId: 'private-device' }) }] };
  const lifecycle = createCallLifecycle({ requestMedia: async constraints => { requests.push(constraints); return stream; } });
  const owner = createDeviceMediaOwner(lifecycle); const attempt = lifecycle.begin();
  const constraints = { audio: { deviceId: { exact: 'fixture-headset' }, autoGainControl: false } };
  await lifecycle.prepareMicrophone(attempt, constraints);
  constraints.audio.deviceId.exact = 'fixture-camera';
  owner.bind(attempt);
  assert.equal(await owner.getUserMedia({ audio: true }), stream);
  assert.equal(requests.length, 1);
  await owner.getUserMedia({ audio: { deviceId: { exact: 'default' }, autoGainControl: true } });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(value => value.audio.deviceId), [{ exact: 'fixture-headset' }, { exact: 'fixture-headset' }]);
  assert.equal(requests[1].audio.autoGainControl, false);
  assert.equal(attempt.microphoneName, 'Meeting N earphone');
  lifecycle.cancel();
  assert.equal(attempt.microphoneName, null); assert.equal(attempt.microphoneConstraints, null);
});

test('default input does not override later SDK constraints and missing labels stay unknown', async () => {
  const requests: any[] = [];
  const lifecycle = createCallLifecycle({ requestMedia: async constraints => { requests.push(constraints); return streamFixture().stream; } });
  const attempt = lifecycle.begin(); await lifecycle.prepareMicrophone(attempt);
  await lifecycle.useMicrophone(attempt, { audio: true });
  await lifecycle.useMicrophone(attempt, { audio: { deviceId: { exact: 'sdk-choice' } } });
  assert.deepEqual(requests[1].audio.deviceId, { exact: 'sdk-choice' });
  assert.equal(attempt.microphoneConstraints, null); assert.equal(attempt.microphoneName, null);
  lifecycle.cancel();
});

test('cancelled selected permission cannot publish a late microphone name or replace a new attempt', async () => {
  const pending = deferred<unknown>(); const late = streamFixture();
  const lifecycle = createCallLifecycle({ requestMedia: () => pending.promise });
  const old = lifecycle.begin(); const preparing = lifecycle.prepareMicrophone(old, { audio: { deviceId: { exact: 'fixture-headset' } } });
  await new Promise(resolve => setImmediate(resolve)); lifecycle.cancel(old);
  await assert.rejects(preparing, { code: 'CALL_CANCELLED' });
  const current = lifecycle.begin();
  pending.resolve({ ...late.stream, getAudioTracks: () => [{ label: 'Retired microphone' }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(late.stopped(), 1); assert.equal(old.microphoneName, null); assert.equal(current.microphoneName, null);
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

test('page selection and refresh do not capture and both call directions use the selected microphone exactly once', async t => {
  for (const direction of ['outbound', 'inbound']) await t.test(direction, async () => {
    const constraints: any[] = [];
    const stream = { ...streamFixture().stream, getAudioTracks: () => [{ label: 'Actual headset microphone', getSettings: () => ({}) }] };
    const f = await pageFixture(async value => { constraints.push(value); return stream; });
    await f.element('refresh-microphones').events.click();
    assert.ok(f.element('microphone-input').children.some((item: any) => item.textContent === 'Meeting N earphone'));
    assert.ok(f.element('microphone-input').children.some((item: any) => item.textContent === '4K USB Camera-Audio'));
    f.element('microphone-input').value = 'fixture-headset'; f.element('microphone-input').events.change();
    assert.equal(constraints.length, 0);
    if (direction === 'outbound') await f.element('start-call').events.click();
    else { const call = f.incoming(); await f.element('accept-call').events.click(); assert.equal(call.accepted, 1); }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(constraints.length, 1); assert.deepEqual(constraints[0].audio.deviceId, { exact: 'fixture-headset' });
    assert.equal(f.media(), stream);
    assert.equal(f.element('microphone-input').disabled, true); assert.equal(f.element('refresh-microphones').disabled, true);
    assert.match(f.element('microphone-actual').textContent, /Actual headset microphone/);
    assert.doesNotMatch(f.sdkLogs.join(' '), /fixture-headset|Actual headset microphone/);
    await f.element('end-call').events.click();
    assert.doesNotMatch(f.element('microphone-actual').textContent, /Actual headset microphone/);
    assert.equal(f.element('microphone-input').value, 'fixture-headset');
  });
});

test('a removed selected microphone fails before dialing or accepting without falling back', async t => {
  for (const direction of ['outbound', 'inbound']) await t.test(direction, async () => {
    let captures = 0;
    const f = await pageFixture(async () => { captures++; return streamFixture().stream; });
    f.element('microphone-input').value = 'fixture-headset'; f.element('microphone-input').events.change();
    // Even without devicechange notification, the fresh pre-call inventory detects removal.
    f.removeInput('fixture-headset');
    if (direction === 'outbound') await f.element('start-call').events.click();
    else { const call = f.incoming(); await f.element('accept-call').events.click(); assert.equal(call.accepted, 0); }
    assert.equal(captures, 0); assert.equal(f.requests.includes('POST /api/calls'), false); assert.equal(f.sdkConnects(), 0);
    assert.match(f.element('app-error').textContent, /选定的麦克风已不可用/);
    assert.equal(f.element('microphone-input').value, 'fixture-headset');
    const removed = f.element('microphone-input').children.find((item: any) => item.value === 'fixture-headset');
    assert.equal(removed.disabled, true); assert.match(removed.textContent, /已不可用/);
  });
});

test('default selection still displays the actual track label while missing names remain unknown', async t => {
  for (const label of ['4K USB Camera-Audio', '']) await t.test(label || 'unknown', async () => {
    const stream = { ...streamFixture().stream, getAudioTracks: () => [{ label, getSettings: () => ({}) }] };
    const f = await pageFixture(async () => stream); await f.element('start-call').events.click();
    assert.equal(f.element('microphone-input').value, '');
    assert.ok(f.element('microphone-actual').textContent.includes(label || '浏览器未提供设备名称'));
    await f.element('end-call').events.click();
  });
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
async function pageFixture(requestMedia: (constraints: unknown) => Promise<unknown>, now: () => number = () => Date.now(),
  options: { initialStatusFailure?: 'network' | 'timeout' | { status: number; error: string }; beforeResponse?: (path: string, signal: AbortSignal) => Promise<void> } = {}) {
  const nodes = new Map<string, any>();
  function node(): any {
    return {
      textContent: '', value: '', hidden: false, disabled: false, dataset: {}, children: [], events: {},
      get options() { return this.children; },
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
  const requestBodies: { path: string; body: any }[] = [];
  const beforeResponse = options.beforeResponse;
  type RequestTimeout = { delay: number; cleared: boolean; fire(): void };
  const timeouts = new Map<ReturnType<typeof setTimeout>, RequestTimeout>();
  const apiTimeouts: { path: string; timer: RequestTimeout }[] = [];
  const apiFailures = new Map<string, 'network' | 'timeout' | { status: number; error: string }>();
  if (options.initialStatusFailure) apiFailures.set('/api/status', options.initialStatusFailure);
  const intervals = new Map<number, { callback: () => void; delay: number }>();
  const windowEvents = new Map<string, () => void>();
  const sdkLogs: string[] = [];
  const exports: Blob[] = [];
  const localValues = new Map();
  let activeSession: any = null;
  let sessionCounter = 0;
  let mediaHandedToSdk: unknown;
  let sdkConnects = 0;
  let device: any;
  let outgoingCall: any;
  let inputDevices = [
    { kind: 'audioinput', deviceId: 'default', label: 'Default microphone' },
    { kind: 'audioinput', deviceId: 'fixture-headset', label: 'Meeting N earphone' },
    { kind: 'audioinput', deviceId: 'fixture-camera', label: '4K USB Camera-Audio' },
    { kind: 'audiooutput', deviceId: 'headset', label: 'Headphones' },
  ];
  const mediaDevices = Object.assign(new EventEmitter(), {
    getUserMedia: requestMedia,
    enumerateDevices: async () => inputDevices,
    addEventListener(name: string, listener: (...args: any[]) => void) { this.on(name, listener); },
    removeEventListener(name: string, listener: (...args: any[]) => void) { this.off(name, listener); },
  });
  class FakeCall extends EventEmitter {
    state: string;
    rejected = 0;
    accepted = 0;
    constructor(state = 'connecting') { super(); this.state = state; }
    status() { return this.state; }
    disconnect() { if (this.state !== 'pending') this.emit('disconnect'); }
    reject() { this.rejected += 1; this.emit('reject'); }
    accept() { this.accepted++; this.state = 'open'; device.options.getUserMedia({ audio: true }).then((stream: unknown) => { mediaHandedToSdk = stream; }); this.emit('accept'); }
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
    microphoneInputModule: await import('../public/microphone-input.js'),
    translationEngineModule: await import('../public/translation-engine.js'),
    lifecycleModule: { createCallLifecycle, createDeviceMediaOwner, microphoneMessages: (await import('../public/call-lifecycle.js')).microphoneMessages },
    document: { getElementById: element, querySelector: element, querySelectorAll: () => [], createElement: node, createElementNS: node, body: node() },
    window: { Twilio: { Device: FakeDevice }, history: { replaceState() {} }, addEventListener(name: string, callback: () => void) { windowEvents.set(name, callback); }, scrollTo() {} },
    navigator: { mediaDevices },
    location: { hash: '#token=offline-test-access-only', pathname: '/', search: '' },
    sessionStorage: { getItem: () => null, setItem() {} }, localStorage: { getItem: (key: string) => localValues.get(key) ?? null, setItem: (key: string, value: string) => localValues.set(key, value) },
    URLSearchParams, AbortController, structuredClone, EventSource: FakeEvents, Blob, TypeError,
    URL: { createObjectURL: (blob: Blob) => { exports.push(blob); return 'blob:offline-export'; }, revokeObjectURL() {} },
    Date: class extends Date { static now() { return now(); } },
    console: { info: (...values: string[]) => sdkLogs.push(values.join(' ')) },
    setTimeout: (...args: Parameters<typeof setTimeout>) => {
      const timer = setTimeout(...args); timer.unref();
      const entry = { delay: args[1] || 0, cleared: false, fire() { if (!entry.cleared) { clearTimeout(timer); Reflect.apply(args[0], undefined, args.slice(2)); } } };
      timeouts.set(timer, entry); return timer;
    },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => { const entry = timeouts.get(timer); if (entry) entry.cleared = true; clearTimeout(timer); },
    setInterval: (callback: () => void, delay: number) => { const id = intervals.size + 1; intervals.set(id, { callback, delay }); return id; },
    clearInterval: (id: number) => intervals.delete(id),
    fetch: async (path: string, options: any = {}) => {
      requests.push(`${options.method || 'GET'} ${path}`);
      apiTimeouts.push({ path, timer: [...timeouts.values()].at(-1) });
      if (options.body) requestBodies.push({ path, body: JSON.parse(options.body) });
      if (beforeResponse) await beforeResponse(path, options.signal);
      const failure = apiFailures.get(path);
      if (failure === 'network') throw new TypeError('private fetch transport details');
      if (failure === 'timeout') throw Object.assign(new Error('private timeout details'), { name: 'AbortError' });
      if (failure) return { ok: false, status: failure.status, json: async () => ({ error: failure.error }) };
      let payload: any = { ok: true };
      if (path === '/api/status') payload = { configured: true, activeSession, checks: [], translationEngines: ['legacy', 'continuous', 'continuous-nano', 'nano-captions', 'continuous-captions'], defaultTranslationEngine: 'legacy' };
      if (path === '/api/token') payload = { token: 'offline-sdk-token' };
      if (path === '/api/calls') {
        activeSession = { id: `session-${++sessionCounter}`, status: 'connecting', direction: 'outbound', to: '+12125551234', translationEngine: JSON.parse(options.body).translationEngine || 'legacy', translationReady: false };
        payload = { ...activeSession, connectionParams: { sessionId: activeSession.id, nonce: 'offline-nonce' } };
      }
      if (path === '/api/verify') {
        const translationEngine = JSON.parse(options.body).translationEngine || 'legacy';
        payload = { translationEngine, checks: [{ name: translationEngine === 'continuous-captions' ? 'continuousCaptions' : translationEngine === 'nano-captions' ? 'nanoCaptions' : translationEngine === 'continuous-nano' ? 'nanoTranslation' : translationEngine === 'continuous' ? 'openaiContinuous' : 'openaiRealtime', status: 'passed', code: translationEngine === 'continuous-captions' ? 'CONTINUOUS_CAPTIONS_READY' : translationEngine === 'nano-captions' ? 'NANO_CAPTIONS_READY' : translationEngine === 'continuous-nano' ? 'NANO_AND_CONTINUOUS_READY' : translationEngine === 'continuous' ? 'SESSION_UPDATED_BOTH_LANGUAGES' : 'SESSION_UPDATED' }] };
      }
      if (path.endsWith('/hangup')) activeSession = null;
      return { ok: true, json: async () => payload };
    },
  });
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const importLine = "await import('./call-lifecycle.js')";
  assert.ok(source.includes(importLine));
  await vm.runInContext(source.replace(importLine, 'lifecycleModule').replace("await import('./audio-output.js')", 'audioOutputModule').replace("await import('./microphone-input.js')", 'microphoneInputModule').replace("await import('./translation-engine.js')", 'translationEngineModule'), context);
  await new Promise(resolve => setImmediate(resolve));
  if (!options.initialStatusFailure) {
    sources[0].onopen();
    await new Promise(resolve => setImmediate(resolve));
    await element('enable-device').events.click();
  }
  element('phone-number').value = '+12125551234';
  return {
    element, requests, requestBodies, device, sdkLogs, exports, history: () => JSON.parse(localValues.get('ai-phone-calls-v1') || '[]'), outgoingCall: () => outgoingCall, sdkConnects: () => sdkConnects, media: () => mediaHandedToSdk,
    requestTimeout(path: string) { return apiTimeouts.filter(entry => entry.path === path).at(-1)?.timer; },
    failApi(path: string, failure: 'network' | 'timeout' | { status: number; error: string }) { apiFailures.set(path, failure); },
    restoreApi(path: string) { apiFailures.delete(path); },
    eventSourceCount: () => sources.length,
    async openEvents() { assert.ok(sources.length); sources[sources.length - 1].onopen(); await new Promise(resolve => setImmediate(resolve)); },
    pagehide() { windowEvents.get('pagehide')?.(); },
    async pollStatus() {
      const matching = [...intervals.values()].filter(timer => timer.delay === 10000);
      assert.equal(matching.length, 1, 'status polling must reuse its single existing interval');
      matching[0].callback();
      await new Promise(resolve => setImmediate(resolve));
    },
    removeInput(id: string) { inputDevices = inputDevices.filter(item => item.deviceId !== id); },
    inputChanged() { mediaDevices.emit('devicechange'); },
    transcriptEvent(value: Record<string, unknown>) {
      sources[0].handlers.get('transcript')({ data: JSON.stringify({ sessionId: activeSession?.id, at: '2026-09-26T01:00:00.000Z', ...value }) });
    },
    captionEvent(value: Record<string, unknown>) {
      sources[0].handlers.get('caption-status')({ data: JSON.stringify({ sessionId: activeSession?.id, ...value }) });
    },
    translationEvent(value: Record<string, unknown>) {
      sources[0].handlers.get('translation-connection')({ data: JSON.stringify(value) });
    },
    audioEvent(value: Record<string, unknown>) {
      sources[0].handlers.get('translation-audio')({ data: JSON.stringify({ sessionId: activeSession?.id, ...value }) });
    },
    metricEvent(value: Record<string, unknown>) {
      sources[0].handlers.get('translation-metric')({ data: JSON.stringify({ sessionId: activeSession?.id,
        name: 'speech_stop_to_first_audio_ms', scope: 'provider_generation', at: 1000, ...value }) });
    },
    callEvent(patch: Record<string, unknown>) {
      assert.ok(activeSession, 'create a call before delivering its provider event');
      activeSession = { ...activeSession, ...patch };
      sources[0].handlers.get('call')({ data: JSON.stringify(activeSession) });
      if (['failed', 'completed'].includes(activeSession.status)) activeSession = null;
    },
    incoming() {
      activeSession = { id: `incoming-${++sessionCounter}`, direction: 'inbound', status: 'ringing', from: '+12125551234', translationEngine: 'legacy', translationReady: false };
      const call = new FakeCall('pending');
      device.emit('incoming', call);
      return call;
    },
  };
}

test('page sends the chosen engine, locks it during calls, and waits for explicit translation readiness', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  assert.equal(f.element('translation-engine').value, 'legacy');
  await f.element('start-call').events.click();
  assert.equal(f.requestBodies.find(entry => entry.path === '/api/calls')?.body.translationEngine, 'legacy');
  await f.element('end-call').events.click();
  f.element('translation-engine').value = 'continuous';
  f.element('translation-engine').events.change();
  await f.element('start-call').events.click();
  assert.equal(f.requestBodies.filter(entry => entry.path === '/api/calls').at(-1)?.body.translationEngine, 'continuous');
  assert.equal(f.element('translation-engine').disabled, true);
  f.element('translation-engine').value = 'legacy';
  f.element('translation-engine').events.change();
  assert.equal(f.element('translation-engine').value, 'continuous');
  assert.match(f.element('translation-engine-status').textContent, /本通电话使用：连续翻译实验版/);
  for (const translationReady of [false, undefined, 'true']) {
    f.callEvent({ status: 'active', translationReady });
    assert.match(f.element('readiness-copy').textContent, /电话已接通.*请等就绪后说话/);
    assert.match(f.element('connection-text').textContent, /翻译准备中/);
  }
  f.callEvent({ status: 'active', translationReady: true });
  assert.equal(f.element('connection-text').textContent, '翻译已就绪');
  assert.match(f.element('transcript-engine-note').textContent, /仅提供译文.*不显示原文/);
  f.metricEvent({ role: 'local', value: 999, transcriptionMs: 100, queueMs: 0, generationMs: 899 });
  assert.match(f.element('translation-timing-local').textContent, /不使用旧版逐句停说计时/);
  assert.doesNotMatch(f.element('translation-timing-local').textContent, /0\.99/);
  f.callEvent({ status: 'ending', cleanupUnconfirmed: true, error: 'CALL_CLEANUP_UNCONFIRMED' });
  assert.equal(f.element('translation-engine').disabled, true);
  await f.element('end-call').events.click();
  assert.equal(f.element('translation-engine').disabled, false);
  assert.equal(f.element('translation-engine').value, 'continuous');
});

test('verification is scoped to the selected engine and changing versions clears its prior result', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  f.element('translation-engine').value = 'continuous';
  f.element('translation-engine').events.change();
  const verifying = f.element('verify-connections').events.click();
  assert.equal(f.element('translation-engine').disabled, true);
  f.element('translation-engine').value = 'legacy';
  f.element('translation-engine').events.change();
  assert.equal(f.element('translation-engine').value, 'continuous');
  await verifying;
  assert.equal(f.requestBodies.find(entry => entry.path === '/api/verify')?.body.translationEngine, 'continuous');
  assert.match(f.element('verification-results').children[0].textContent, /本次验证结果：连续翻译实验版/);
  assert.equal(f.element('verification-results').children[1].title, '中英双向连续翻译会话已确认配置。');
  assert.equal(f.requestTimeout('/api/verify').delay, 75000);
  assert.equal(f.requestTimeout('/api/verify').cleared, true);
  f.element('translation-engine').value = 'legacy';
  f.element('translation-engine').events.change();
  assert.equal(f.element('verification-results').children.length, 1);
  assert.match(f.element('verification-results').children[0].textContent, /当前版本.*重新验证/);
  assert.match(f.element('verification-engine').textContent, /验证版本：当前版本/);
});

test('dialing reserves preflight transport margin while timeout still releases prepared media', async () => {
  const stream = streamFixture();
  let dialSignal: AbortSignal;
  const f = await pageFixture(async () => stream.stream, undefined, {
    beforeResponse: async (path, signal) => {
      if (path !== '/api/calls') return;
      dialSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('offline timeout'), { name: 'AbortError' })), { once: true });
      });
    },
  });
  f.element('translation-engine').value = 'continuous';
  f.element('translation-engine').events.change();
  const dialing = f.element('start-call').events.click();
  await new Promise(resolve => setImmediate(resolve));
  const timer = f.requestTimeout('/api/calls');
  assert.equal(timer.delay, 30000);
  assert.equal(timer.cleared, false);
  assert.equal(dialSignal.aborted, false);
  assert.equal(f.requestTimeout('/api/status').delay, 20000);
  assert.equal(f.sdkConnects(), 0);
  timer.fire(); // Exercise AbortController cleanup without a real 30-second wait.
  await dialing;
  assert.equal(dialSignal.aborted, true);
  assert.equal(timer.cleared, true);
  assert.equal(stream.stopped(), 1);
  assert.equal(f.sdkConnects(), 0);
  assert.match(f.element('app-error').textContent, /本机服务响应超时/);
  assert.equal(f.element('start-call').disabled, false);
});

test('canceling delayed continuous preflight still cleans up its late session with the normal hangup deadline', async () => {
  const pending = deferred<void>();
  const stream = streamFixture();
  const f = await pageFixture(async () => stream.stream, undefined, {
    beforeResponse: async path => { if (path === '/api/calls') await pending.promise; },
  });
  f.element('translation-engine').value = 'continuous';
  f.element('translation-engine').events.change();
  const dialing = f.element('start-call').events.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requestTimeout('/api/calls').delay, 30000);
  await f.element('end-call').events.click();
  assert.equal(stream.stopped(), 1);
  pending.resolve();
  await dialing;
  assert.equal(f.sdkConnects(), 0);
  const hangup = f.requests.find(request => /^POST \/api\/calls\/[^/]+\/hangup$/.test(request));
  assert.ok(hangup, 'a canceled attempt must end the session returned after preflight');
  assert.equal(f.requestTimeout(hangup.slice(5)).delay, 20000);
  assert.equal(f.requestTimeout(hangup.slice(5)).cleared, true);
  assert.equal(f.requestTimeout('/api/calls').cleared, true);
  assert.equal(f.element('start-call').disabled, false);
});

test('incoming calls show the server legacy engine while retaining the next outgoing comparison choice', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  f.element('translation-engine').value = 'continuous';
  f.element('translation-engine').events.change();
  f.incoming();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.element('translation-engine').value, 'legacy');
  assert.equal(f.element('translation-engine').disabled, true);
  assert.match(f.element('translation-engine-status').textContent, /本通电话使用：当前版本/);
  await f.element('end-call').events.click();
  assert.equal(f.element('translation-engine').value, 'continuous');
});

test('continuous call history and exports retain the actual selected version with translated text', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  f.element('save-history-toggle').events.click();
  f.element('translation-engine').value = 'continuous';
  f.element('translation-engine').events.change();
  await f.element('start-call').events.click();
  f.transcriptEvent({ id: 'continuous-local-0', role: 'local', kind: 'translation', text: 'No coffee, please.', final: true });
  f.element('export-current').events.click();
  const text = await f.exports[0].text();
  assert.match(text, /翻译版本：连续翻译实验版/);
  assert.match(text, /仅包含服务返回的译文/);
  assert.match(text, /No coffee, please\./);
  f.callEvent({ status: 'completed' });
  assert.equal(f.history()[0].translationEngine, 'continuous');
  assert.match(f.element('history-list').children[0].children[1].textContent, /连续翻译实验版/);
});

test('own voice page requests, readiness, records and exports preserve its distinct engine', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  assert.equal(f.element('translation-engine').value, 'legacy');
  f.element('save-history-toggle').events.click();
  f.element('translation-engine').value = 'continuous-nano';
  f.element('translation-engine').events.change();
  assert.match(f.element('translation-engine-status').textContent, /本人声线实验版.*增加等待/);
  assert.match(f.element('translation-engine-help').textContent, /电脑中文 → 手机英文.*本人声线.*电脑中文保留连续翻译原声/);
  await f.element('verify-connections').events.click();
  assert.equal(f.requestBodies.find(entry => entry.path === '/api/verify')?.body.translationEngine, 'continuous-nano');
  assert.match(f.element('verification-results').children[0].textContent, /本人声线实验版/);
  assert.equal(f.requestTimeout('/api/verify').delay, 150000);
  assert.equal(f.element('verification-results').children[1].children[0].textContent, '本人声线与双向连续翻译');
  assert.match(f.element('verification-results').children[1].title, /本人声线已预热.*连续翻译连接已就绪/);
  await f.element('start-call').events.click();
  assert.equal(f.requestBodies.find(entry => entry.path === '/api/calls')?.body.translationEngine, 'continuous-nano');
  assert.equal(f.requestTimeout('/api/calls').delay, 150000);
  assert.equal(f.element('translation-engine').disabled, true);
  f.callEvent({ status: 'active', translationReady: false });
  assert.match(f.element('connection-text').textContent, /本人声线准备中/);
  f.callEvent({ status: 'active', translationReady: true });
  assert.equal(f.element('connection-text').textContent, '本人声线翻译已就绪');
  assert.match(f.element('transcript-engine-note').textContent, /本人声线版仅提供译文/);
  f.transcriptEvent({ id: 'nano-local-0', role: 'local', kind: 'translation', text: 'Please call at five.', final: true });
  f.element('export-current').events.click();
  const text = await f.exports[0].text();
  assert.match(text, /翻译版本：本人声线实验版/);
  assert.match(text, /仅包含服务返回的译文/);
  assert.match(text, /电脑中文.*本机本人声线.*电脑中文保留连续翻译原声/);
  assert.match(text, /Please call at five\./);
  f.callEvent({ status: 'completed' });
  assert.equal(f.history()[0].translationEngine, 'continuous-nano');
  assert.match(f.element('history-list').children[0].children[1].textContent, /本人声线实验版/);
});

for (const engine of ['continuous-nano', 'nano-captions']) test(`${engine} warmup keeps selection locked and late preflight cannot revive a cancelled call`, async () => {
  const pending = deferred<void>();
  const stream = streamFixture();
  const f = await pageFixture(async () => stream.stream, undefined, {
    beforeResponse: async path => { if (path === '/api/calls') await pending.promise; },
  });
  f.element('translation-engine').value = engine;
  f.element('translation-engine').events.change();
  const dialing = f.element('start-call').events.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requestTimeout('/api/calls').delay, 150000);
  assert.equal(f.element('translation-engine').disabled, true);
  assert.equal(f.element('start-call').disabled, true);
  assert.match(f.element('translation-engine-status').textContent, /首次准备.*2 分钟.*尚未拨出/);
  assert.match(f.element('start-call').querySelector('span').textContent, /正在准备本人声线/);
  assert.match(f.element('bridge-caption').textContent, /准备好后才拨号/);
  assert.equal(f.sdkConnects(), 0);
  await f.element('end-call').events.click();
  assert.equal(stream.stopped(), 1);
  pending.resolve();
  await dialing;
  assert.equal(f.sdkConnects(), 0);
  const hangup = f.requests.find(request => /^POST \/api\/calls\/[^/]+\/hangup$/.test(request));
  assert.ok(hangup);
  assert.equal(f.requestTimeout(hangup.slice(5)).delay, 20000);
  assert.equal(f.element('start-call').disabled, false);
});

test('caption mode sends its engine, verifies it and reports original audio separately from text', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  assert.equal(f.element('translation-engine').value, 'legacy');
  f.element('translation-engine').value = 'nano-captions';
  f.element('translation-engine').events.change();
  assert.match(f.element('translation-engine-help').textContent, /英文原声直接送到电脑.*不生成中文声音/);
  assert.equal(f.element('return-audio-label').textContent, 'English 原声 ＋ 中文字幕');
  assert.equal(f.element('connection-mode-label').textContent, '本人英文本音 · 原声与字幕');
  assert.match(f.element('transcript-subtitle').textContent, /直接听英文原声/);
  await f.element('verify-connections').events.click();
  assert.equal(f.requestBodies.find(entry => entry.path === '/api/verify')?.body.translationEngine, 'nano-captions');
  assert.equal(f.requestTimeout('/api/verify').delay, 150000);
  assert.match(f.element('verification-results').children[0].textContent, /英文原声＋中文字幕/);
  assert.equal(f.element('verification-results').children[1].children[0].textContent, '本人声线、出程翻译与回程字幕');
  assert.match(f.element('verification-results').children[1].title, /本人声线.*回程字幕连接已就绪/);
  await f.element('start-call').events.click();
  assert.equal(f.requestBodies.find(entry => entry.path === '/api/calls')?.body.translationEngine, 'nano-captions');
  assert.equal(f.requestTimeout('/api/calls').delay, 150000);
  f.callEvent({ status: 'active', translationReady: true });
  assert.equal(f.element('connection-text').textContent, '本人声线与英文原声已就绪');
  assert.equal(f.element('audio-delivery-heading').textContent, '声音传送与字幕处理状态');
  assert.match(f.element('audio-delivery-remote').textContent, /英文原声.*直接转发.*不生成中文声音/);
  assert.doesNotMatch(f.element('audio-delivery-remote').textContent, /中文 → 电脑|生成 \d/);
  f.metricEvent({ role: 'local', name: 'nano_text_to_audio_ms', scope: 'local_synthesis', value: 1234 });
  assert.match(f.element('translation-timing-local').textContent, /本人声线合成 1\.23 秒/);
  f.metricEvent({ role: 'remote', name: 'nano_text_to_audio_ms', scope: 'local_synthesis', value: 4567 });
  assert.match(f.element('translation-timing-remote').textContent, /尚无字幕延迟测量/);
  f.audioEvent({ role: 'remote', recipientRole: 'local', generatedBytes: 0, sentBytes: 160, stage: 'sent' });
  assert.doesNotMatch(f.element('audio-delivery-remote').textContent, /已送出 1|生成 1/);
  await f.element('end-call').events.click();
});

test('native continuous captions select and verify without Nano warmup and reject incompatible latency metrics', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  assert.equal(f.element('translation-engine').value, 'legacy');
  f.element('translation-engine').value = 'continuous-captions';
  f.element('translation-engine').events.change();
  assert.match(f.element('translation-engine-status').textContent, /连续直出＋中文字幕测试候选.*模型声音/);
  assert.match(f.element('translation-engine-help').textContent, /模型声音.*直接送到电话.*不使用本人声线.*回程保持英文原声/);
  assert.equal(f.element('connection-mode-label').textContent, '模型声音连续直出 · 原声与字幕');
  assert.equal(f.element('return-audio-label').textContent, 'English 原声 ＋ 中文字幕');
  await f.element('verify-connections').events.click();
  assert.equal(f.requestBodies.find(entry => entry.path === '/api/verify')?.body.translationEngine, 'continuous-captions');
  assert.equal(f.requestTimeout('/api/verify').delay, 75000);
  assert.equal(f.element('verification-results').children[1].children[0].textContent, '连续直出翻译与回程字幕');
  assert.match(f.element('verification-results').children[1].title, /出程使用模型声音/);
  await f.element('start-call').events.click();
  assert.equal(f.requestBodies.find(entry => entry.path === '/api/calls')?.body.translationEngine, 'continuous-captions');
  assert.equal(f.requestTimeout('/api/calls').delay, 30000);
  assert.equal(f.element('translation-engine').disabled, true);
  f.callEvent({ status: 'active', translationReady: false });
  assert.equal(f.element('connection-text').textContent, '电话已接通 · 翻译准备中');
  assert.doesNotMatch(f.element('bridge-caption').textContent, /本人声线/);
  f.callEvent({ translationReady: true });
  assert.equal(f.element('connection-text').textContent, '连续直出与英文原声已就绪');
  assert.match(f.element('translation-timing-note').textContent, /模型声音.*连续英文译音.*回程保持英文原声/);
  const localTiming = f.element('translation-timing-local').textContent;
  assert.match(localTiming, /连续翻译.*不使用旧版逐句停说计时/);
  for (const role of ['local', 'remote']) {
    for (const metric of [
      { name: 'nano_boundary_wait_ms', scope: 'text_boundary' },
      { name: 'nano_text_to_audio_ms', scope: 'local_synthesis' },
      { name: 'speech_stop_to_first_audio_ms', scope: 'provider_generation' },
    ]) f.metricEvent({ role, ...metric, value: 98765 });
  }
  assert.equal(f.element('translation-timing-local').textContent, localTiming);
  assert.match(f.element('translation-timing-remote').textContent, /独立识别与翻译.*尚无字幕延迟测量/);
  f.audioEvent({ role: 'local', recipientRole: 'remote', generatedBytes: 160, sentBytes: 160, stage: 'generated' });
  assert.match(f.element('audio-delivery-local').textContent, /英语 → 手机：生成 1 块/);
  f.audioEvent({ role: 'remote', recipientRole: 'local', generatedBytes: 0, sentBytes: 160, stage: 'sent' });
  assert.match(f.element('audio-delivery-remote').textContent, /英文原声.*直接转发.*不生成中文声音/);
  assert.doesNotMatch(f.element('audio-delivery-remote').textContent, /已送出 1|生成 1/);
  await f.element('end-call').events.click();
});

test('caption mode separates text boundary wait from synthesis and rejects late or unrelated metrics', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  f.element('translation-engine').value = 'nano-captions';
  f.element('translation-engine').events.change();
  await f.element('start-call').events.click();
  const boundary = { role: 'local', name: 'nano_boundary_wait_ms', scope: 'text_boundary', value: 9400, at: 1000 };
  f.metricEvent(boundary);
  assert.match(f.element('translation-timing-local').textContent, /分节等待 9\.40 秒.*尚无合成计时/);
  f.metricEvent({ role: 'local', name: 'nano_text_to_audio_ms', scope: 'local_synthesis', value: 1700, at: 1100 });
  assert.match(f.element('translation-timing-local').textContent, /分节等待 9\.40 秒.*合成 1\.70 秒/);
  const expected = f.element('translation-timing-local').textContent;
  for (const patch of [{ at: 999 }, { role: 'remote' }, { scope: 'local_synthesis' }, { sessionId: 'old-call' }, { value: -1 }]) {
    f.metricEvent({ ...boundary, value: 99999, ...patch });
    assert.equal(f.element('translation-timing-local').textContent, expected);
  }
  await f.element('end-call').events.click();
  await f.element('start-call').events.click();
  assert.doesNotMatch(f.element('translation-timing-local').textContent, /9\.40|1\.70/);
  await f.element('end-call').events.click();
});

for (const engine of ['nano-captions', 'continuous-captions']) test(`${engine} status is separate, safe, session-scoped and recovered from a status snapshot`, async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  f.element('translation-engine').value = engine;
  f.element('translation-engine').events.change();
  await f.element('start-call').events.click();
  f.callEvent({ status: 'active', translationReady: true, captionState: 'connecting' });
  assert.equal(f.element('caption-status').hidden, false);
  assert.match(f.element('caption-status').textContent, /字幕连接准备中/);
  f.captionEvent({ state: 'ready', sessionId: 'old-session' });
  assert.match(f.element('caption-status').textContent, /字幕连接准备中/);
  f.captionEvent({ state: 'invented', code: 'private-provider-detail' });
  assert.match(f.element('caption-status').textContent, /字幕连接准备中/);
  f.captionEvent({ state: 'ready' });
  assert.match(f.element('caption-status').textContent, /字幕连接已就绪/);
  f.captionEvent({ state: 'failed', code: 'private-provider-detail' });
  assert.match(f.element('caption-status').textContent, /字幕暂不可用.*英文原声继续传送.*通话仍可继续/);
  assert.doesNotMatch(f.element('caption-status').textContent, /private-provider-detail/);
  assert.equal(f.element('connection-text').textContent, engine === 'nano-captions' ? '本人声线与英文原声已就绪' : '连续直出与英文原声已就绪');
  assert.equal(f.element('end-call').disabled, false);
  assert.equal(f.requests.some(path => path.endsWith('/hangup')), false);
  f.translationEvent({ sessionId: 'session-1', role: 'remote', state: 'disconnected' });
  assert.equal(f.element('connection-text').textContent, engine === 'nano-captions' ? '本人声线与英文原声已就绪' : '连续直出与英文原声已就绪');
  f.translationEvent({ sessionId: 'session-1', role: 'local', state: 'disconnected' });
  assert.equal(f.element('connection-text').textContent, '正在恢复翻译连接');
  f.translationEvent({ sessionId: 'session-1', role: 'local', state: 'ready' });
  assert.match(f.element('bridge-caption').textContent, /请重说/);
  f.transcriptEvent({ id: 'remote:translation:recovery_caption:0', role: 'remote', kind: 'translation', text: '回程字幕。', final: true });
  assert.match(f.element('bridge-caption').textContent, /请重说/);
  f.transcriptEvent({ id: 'local:translation:recovery_voice:0', role: 'local', kind: 'translation', text: 'Please repeat.', final: true });
  assert.doesNotMatch(f.element('bridge-caption').textContent, /请重说/);
  f.callEvent({ captionState: 'ready' });
  await f.pollStatus();
  assert.match(f.element('caption-status').textContent, /字幕连接已就绪/);
  f.callEvent({ status: 'completed' });
  f.captionEvent({ state: 'failed', sessionId: 'session-1' });
  assert.match(f.element('caption-status').textContent, /通话已结束/);
  await f.element('start-call').events.click();
  assert.match(f.element('caption-status').textContent, /字幕连接准备中/);
  await f.element('end-call').events.click();
});

for (const engine of ['nano-captions', 'continuous-captions']) test(`${engine} drafts pair English with Chinese even with original preference off, including history and export`, async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  f.element('save-history-toggle').events.click();
  f.element('show-original-toggle').events.click();
  f.element('translation-engine').value = engine;
  f.element('translation-engine').events.change();
  await f.element('start-call').events.click();
  const original = { id: 'remote:original:caption_a:0', role: 'remote', kind: 'original' };
  const translation = { id: 'remote:translation:caption_a:0', role: 'remote', kind: 'translation' };
  f.transcriptEvent({ ...translation, text: '五点', final: false });
  f.transcriptEvent({ ...original, text: 'Not five.', final: true });
  const rows = () => f.element('transcript').children;
  assert.equal(rows().length, 2);
  assert.equal(rows()[0].dataset.transcriptId, original.id);
  assert.equal(rows()[0].className.split(/\s+/).includes('original-entry'), false);
  assert.equal(rows()[0].className.split(/\s+/).includes('caption-original-entry'), true);
  assert.equal(rows()[1].children[0].children[2].textContent, '更新中');
  f.transcriptEvent({ ...translation, text: '不是五点。', final: true });
  assert.equal(rows().length, 2);
  assert.equal(rows()[1].children[0].children[2].textContent, '');
  f.element('export-current').events.click();
  const text = await f.exports[0].text();
  if (engine === 'nano-captions') {
    assert.match(text, /翻译版本：英文原声＋中文字幕/);
    assert.match(text, /电脑听英文原声，手机听本人英文本音/);
  } else {
    assert.match(text, /翻译版本：连续直出＋中文字幕（测试候选）/);
    assert.match(text, /电脑听英文原声，手机听模型声音的连续英文译音/);
    assert.doesNotMatch(text, /本人声线|本人英文本音/);
  }
  assert.match(text, /对方英文原声直接送到电脑，不生成中文声音/);
  assert.match(text, /\[对方 · 原文\] Not five\.\r\n\[对方 · 译文\] 不是五点。/);
  assert.doesNotMatch(text, /以双方实际听到的译音为准|未开启原文转写|未定稿\]/);
  f.callEvent({ status: 'completed' });
  assert.equal(f.history()[0].translationEngine, engine);
  const historyRows = f.element('history-detail').children.slice(1);
  assert.equal(historyRows[0].dataset.transcriptId, original.id);
  assert.equal(historyRows[0].className.split(/\s+/).includes('original-entry'), false);
  assert.equal(historyRows[1].children[1].children[0].textContent, '不是五点。');
});

for (const engine of ['nano-captions', 'continuous-captions']) test(`${engine} empty final captions remove invalid drafts instead of leaving blank or stale rows`, async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  f.element('translation-engine').value = engine;
  f.element('translation-engine').events.change();
  await f.element('start-call').events.click();
  const emit = (kind: string, text: string, final: boolean, sessionId?: string) => f.transcriptEvent({ id: `remote:${kind}:empty_case:0`, role: 'remote', kind, text, final, ...(sessionId ? { sessionId } : {}) });
  emit('original', 'uncertain noise', false);
  emit('translation', '不确定的声音', false);
  assert.equal(f.element('transcript').children.length, 2);
  emit('original', '', true, 'previous-session');
  assert.equal(f.element('transcript').children.length, 2);
  emit('original', '', true);
  emit('translation', '', true);
  assert.equal(f.element('transcript').children.length, 0);
  assert.equal(f.element('empty-conversation').hidden, false);
  assert.equal(f.element('export-current').disabled, true);
  await f.element('end-call').events.click();
});

for (const engine of ['nano-captions', 'continuous-captions']) test(`${engine} ASR turns use stable source time across late completions, paired translations, history and export`, async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  f.element('save-history-toggle').events.click();
  f.element('translation-engine').value = engine;
  f.element('translation-engine').events.change();
  await f.element('start-call').events.click();
  const emit = (id: string, kind: string, at: number, text: string) => f.transcriptEvent({ id: `remote:${kind}:${id}:0`, role: 'remote', kind, at, text, final: true });
  const ids = () => f.element('transcript').children.map((row: any) => row.dataset.transcriptId);
  emit('second', 'original', 2000, 'Second statement.');
  f.transcriptEvent({ id: 'continuous_local_0', role: 'local', kind: 'translation', at: 1500, text: 'Local response.', final: false });
  const local = f.element('transcript').children[1];
  emit('first', 'original', 1000, 'First statement.');
  assert.deepEqual(ids(), ['remote:original:first:0', 'continuous_local_0', 'remote:original:second:0']);
  emit('second', 'translation', 2000, '第二句。');
  emit('first', 'translation', 1000, '第一句。');
  const expected = ['remote:original:first:0', 'remote:translation:first:0', 'continuous_local_0', 'remote:original:second:0', 'remote:translation:second:0'];
  assert.deepEqual(ids(), expected);
  assert.equal(f.element('transcript').children[2], local, 'unchanged local row is reused');
  f.element('export-current').events.click();
  const text = await f.exports[0].text();
  assert.match(text, /\[对方 · 原文\] First statement\.\r\n\[对方 · 译文\] 第一句。\r\n\[你 · 译文 · 未定稿\] Local response\.\r\n\[对方 · 原文\] Second statement\.\r\n\[对方 · 译文\] 第二句。/);
  f.callEvent({ status: 'completed' });
  assert.deepEqual(f.element('history-detail').children.slice(1).map((row: any) => row.dataset.transcriptId), expected);
});

for (const engine of ['nano-captions', 'continuous-captions']) test(`${engine} timestamp updates reorder an existing paired DOM group without duplicate rows`, async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  f.element('translation-engine').value = engine;
  f.element('translation-engine').events.change();
  await f.element('start-call').events.click();
  f.transcriptEvent({ id: 'remote:original:second:0', role: 'remote', kind: 'original', at: 2000, text: 'Second.', final: true });
  f.transcriptEvent({ id: 'remote:translation:first:0', role: 'remote', kind: 'translation', at: 3000, text: '第一', final: false });
  f.transcriptEvent({ id: 'remote:translation:first:0', role: 'remote', kind: 'translation', at: 1000, text: '第一句。', final: true });
  assert.deepEqual(f.element('transcript').children.map((row: any) => row.dataset.transcriptId), ['remote:translation:first:0', 'remote:original:second:0']);
  f.transcriptEvent({ id: 'remote:original:first:0', role: 'remote', kind: 'original', at: 1000, text: 'First.', final: true });
  assert.deepEqual(f.element('transcript').children.map((row: any) => row.dataset.transcriptId), ['remote:original:first:0', 'remote:translation:first:0', 'remote:original:second:0']);
  await f.element('end-call').events.click();
});

test('legacy transcript turns retain first arrival when timestamps arrive out of order', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  await f.element('start-call').events.click();
  for (const [id, at] of [['second', 2000], ['first', 1000]]) {
    f.transcriptEvent({ id: `remote:original:${id}:0`, role: 'remote', kind: 'original', at, text: String(id), final: true });
  }
  assert.deepEqual(f.element('transcript').children.map((row: any) => row.dataset.transcriptId), ['remote:original:second:0', 'remote:original:first:0']);
  await f.element('end-call').events.click();
});

for (const engine of ['nano-captions', 'continuous-captions']) test(`incoming legacy calls ignore caption events and retain the next outgoing ${engine} choice`, async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  f.element('translation-engine').value = engine;
  f.element('translation-engine').events.change();
  f.incoming();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.element('translation-engine').value, 'legacy');
  f.captionEvent({ state: 'failed' });
  assert.equal(f.element('caption-status').hidden, true);
  assert.equal(f.element('return-audio-label').textContent, 'English → 中文');
  f.callEvent({ status: 'completed' });
  assert.equal(f.element('translation-engine').value, engine);
});

test('own voice timing accepts only local synthesis metrics and never presents legacy turn latency', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  f.element('translation-engine').value = 'continuous-nano';
  f.element('translation-engine').events.change();
  await f.element('start-call').events.click();
  f.callEvent({ status: 'active', translationReady: true });
  assert.match(f.element('translation-timing-note').textContent, /不等于实际电话延迟/);
  f.metricEvent({ role: 'local', value: 999, transcriptionMs: 100, queueMs: 0, generationMs: 899 });
  assert.match(f.element('translation-timing-local').textContent, /等待完整译文句子.*尚无合成计时/);
  f.metricEvent({ role: 'local', name: 'nano_text_to_audio_ms', scope: 'provider_generation', value: 999 });
  assert.match(f.element('translation-timing-local').textContent, /尚无合成计时/);
  f.metricEvent({ role: 'remote', name: 'nano_text_to_audio_ms', scope: 'local_synthesis', value: 999 });
  assert.match(f.element('translation-timing-remote').textContent, /连续翻译原声.*不使用旧版逐句停说计时/);
  f.metricEvent({ role: 'local', name: 'nano_text_to_audio_ms', scope: 'local_synthesis', value: 1234 });
  assert.match(f.element('translation-timing-local').textContent, /本人声线合成 1\.23 秒（含合成排队）/);
  assert.doesNotMatch(f.element('translation-timing-local').textContent, /服务端停说|等待转写/);
});

test('own voice service and sentence failures have actionable Chinese messages', async () => {
  for (const [error, expected] of [
    ['NANOVOICE_NOT_READY', /本人声线尚未准备好/],
    ['NANOVOICE_TIMEOUT', /本人声线准备或合成超时/],
    ['nano_text_too_long:local', /等待完整句子时文字过长.*较短的完整句子/],
    ['nano_text_boundary_failed:local', /译文过长或句子边界无法确认.*较短的完整句子/],
    ['nano_queue_overflow:local', /本人声线合成或播放积压过多/],
    ['nano_worker_closed:local', /本人声线服务连接中断/],
    ['nano_unknown_failure:local', /本人声线合成未完成/],
  ] as const) {
    const f = await pageFixture(async () => streamFixture().stream);
    await f.element('start-call').events.click();
    f.callEvent({ status: 'failed', error });
    assert.match(f.element('app-error').textContent, expected);
    assert.doesNotMatch(f.element('app-error').textContent, /NANOVOICE_|nano_/);
  }
});

test('input overflow reports incomplete capture separately from continuous playback backlog', async () => {
  for (const [error, expected] of [
    ['continuous_input_before_ready_overflow:local', /输入声音已无法完整保留.*等翻译就绪/],
    ['translation_input_overflow:remote', /输入声音已无法完整保留.*等翻译就绪/],
    ['continuous_playback_overflow:remote', /连续翻译声音积压过多/],
  ] as const) {
    const f = await pageFixture(async () => streamFixture().stream);
    await f.element('start-call').events.click();
    f.callEvent({ status: 'failed', error });
    assert.match(f.element('app-error').textContent, expected);
    assert.doesNotMatch(f.element('app-error').textContent, /识别错误/);
  }
});

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
  assert.match(f.element('bridge-caption').textContent, /恢复中/);
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
  f.callEvent({ status: 'active', translationReady: true });
  const event = { sessionId: 'session-1', role: 'remote', state: 'reconnecting', closeCode: 1006, text: 'private-text', token: 'private-token' };
  f.translationEvent({ ...event, sessionId: 'old-session' });
  assert.doesNotMatch(f.element('bridge-caption').textContent, /翻译短暂中断/);
  f.translationEvent(event);
  assert.match(f.element('bridge-caption').textContent, /翻译恢复中.*暂停/);
  f.translationEvent({ ...event, role: 'local' });
  f.translationEvent({ ...event, state: 'ready' });
  assert.equal(f.element('connection-text').textContent, '正在恢复翻译连接');
  f.translationEvent({ ...event, state: 'ready', role: 'local' });
  assert.match(f.element('bridge-caption').textContent, /已恢复.*重说/);
  assert.equal(f.requests.some(path => path.endsWith('/hangup')), false);
  const logs = f.sdkLogs.join('\n');
  assert.match(logs, /remote.*reconnecting.*1006/);
  assert.doesNotMatch(logs, /private-|sessionId|old-session/);
  await f.element('end-call').events.click();
  await f.element('start-call').events.click();
  f.callEvent({ status: 'active', translationReady: true });
  f.translationEvent(event);
  assert.doesNotMatch(f.element('bridge-caption').textContent, /恢复|重说/);
  await f.element('end-call').events.click();
});

test('sound detection and SDK quality warnings remain separate and reset for the next call', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  await f.element('start-call').events.click();
  f.callEvent({ status: 'active', translationReady: true });
  const call = f.outgoingCall();
  call.emit('volume', 0, 0);
  call.emit('warning', 'constant-audio-input-level');
  assert.match(f.element('call-hint').textContent, /尚未检测.*安静时正常/);
  assert.equal(f.element('connection-text').textContent, '翻译已就绪');
  call.emit('volume', 0.08, 0.04);
  call.emit('volume', 0, 0);
  assert.equal(f.element('call-hint').textContent, '本次已检测到麦克风声音');
  call.emit('warning', 'low-bytes-sent');
  call.emit('warning', 'high-packet-loss');
  assert.match(f.element('connection-text').textContent, /连接质量异常/);
  call.emit('warning-cleared', 'low-bytes-sent');
  assert.match(f.element('connection-text').textContent, /连接质量异常/);
  call.emit('warning-cleared', 'high-packet-loss');
  assert.equal(f.element('connection-text').textContent, '翻译已就绪');
  assert.equal(f.requests.some(path => path.endsWith('/hangup')), false);
  await f.element('end-call').events.click();
  await f.element('start-call').events.click();
  f.callEvent({ status: 'active', translationReady: true });
  call.emit('volume', 0.8, 0.4);
  call.emit('warning', 'low-bytes-sent');
  assert.equal(f.element('call-hint').textContent, '麦克风已就绪');
  assert.equal(f.element('connection-text').textContent, '翻译已就绪');
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

test('existing status polling continues through a local outage and clears only its recovered connection warning', async t => {
  for (const failure of ['network', 'timeout'] as const) await t.test(failure, async () => {
    const f = await pageFixture(async () => streamFixture().stream);
    const before = f.requests.length;
    f.failApi('/api/status', failure);
    await f.pollStatus();
    assert.equal(f.element('local-state').textContent, '本机服务未连接');
    assert.equal(f.element('start-call').disabled, true);
    assert.equal(f.element('app-error').hidden, false);
    assert.match(f.element('app-error').textContent, failure === 'network' ? /无法连接本机服务/ : /本机服务响应超时/);
    await f.pollStatus();
    assert.equal(f.element('app-error').hidden, false, 'another failed read must retain the warning');
    f.restoreApi('/api/status');
    await f.pollStatus();
    assert.equal(f.element('local-state').textContent, '本机服务已连接');
    assert.equal(f.element('start-call').disabled, false);
    assert.equal(f.element('app-error').hidden, true);
    assert.equal(f.element('app-error').textContent, '');
    assert.deepEqual(f.requests.slice(before), ['GET /api/status', 'GET /api/status', 'GET /api/status']);
    assert.equal(f.sdkConnects(), 0, 'recovery must never initiate a call');
  });
});

test('initial local outage recovers via polling, establishes exactly one event stream and allows user registration without dialing', async () => {
  let captures = 0;
  const f = await pageFixture(async () => { captures++; return streamFixture().stream; }, undefined, { initialStatusFailure: 'network' });
  assert.equal(f.eventSourceCount(), 0);
  assert.equal(f.element('enable-device').disabled, true);
  assert.match(f.element('app-error').textContent, /无法连接本机服务/);
  f.restoreApi('/api/status');
  await f.pollStatus();
  assert.equal(f.eventSourceCount(), 1, 'successful recovery creates the SSE missing after the initial failure');
  assert.equal(f.element('app-error').hidden, true);
  assert.equal(f.element('enable-device').disabled, false);
  assert.equal(f.element('start-call').disabled, true, 'status success alone does not establish event connectivity or register a phone');
  assert.equal(f.requests.includes('GET /api/token'), false, 'polling does not register a phone automatically');
  await f.pollStatus();
  assert.equal(f.eventSourceCount(), 1, 'repeated status reads must not duplicate the source');
  await f.openEvents();
  await f.element('enable-device').events.click();
  assert.equal(f.element('start-call').disabled, false);
  assert.match(f.element('device-state').textContent, /已注册/);
  assert.equal(f.eventSourceCount(), 1);
  assert.equal(captures, 0);
  assert.equal(f.sdkConnects(), 0);
  assert.equal(f.requests.includes('POST /api/calls'), false);
  assert.equal(f.requests.some(request => request.includes('/api/verify')), false);
});

test('successful late status reads do not create SSE after page disposal or explicit authentication rejection', async () => {
  const disposed = await pageFixture(async () => streamFixture().stream, undefined, { initialStatusFailure: 'network' });
  disposed.restoreApi('/api/status');
  const reading = disposed.element('refresh-status').events.click();
  disposed.pagehide();
  await reading;
  assert.equal(disposed.eventSourceCount(), 0);
  assert.equal(disposed.element('enable-device').disabled, true);
  const afterDispose = disposed.requests.length;
  await disposed.pollStatus();
  assert.equal(disposed.requests.length, afterDispose);

  const rejected = await pageFixture(async () => streamFixture().stream, undefined, { initialStatusFailure: { status: 401, error: 'UNAUTHORIZED' } });
  rejected.restoreApi('/api/status');
  await rejected.element('refresh-status').events.click();
  assert.equal(rejected.eventSourceCount(), 0);
  assert.equal(rejected.element('enable-device').disabled, true);
  assert.match(rejected.element('app-error').textContent, /本机访问凭据已失效/);
  const afterRejection = rejected.requests.length;
  await rejected.pollStatus();
  assert.equal(rejected.requests.length, afterRejection);
});

test('a successful status read preserves uncertain dial and hangup failures', async () => {
  const dialing = await pageFixture(async () => streamFixture().stream);
  dialing.failApi('/api/calls', 'network');
  await dialing.element('start-call').events.click();
  assert.match(dialing.element('app-error').textContent, /无法连接本机服务/);
  await dialing.pollStatus();
  assert.equal(dialing.element('app-error').hidden, false, 'successful status cannot establish whether a failed POST placed a call');
  assert.match(dialing.element('app-error').textContent, /无法连接本机服务/);
  assert.equal(dialing.sdkConnects(), 0);

  const ending = await pageFixture(async () => streamFixture().stream);
  await ending.element('start-call').events.click();
  ending.failApi('/api/calls/session-1/hangup', 'network');
  await ending.element('end-call').events.click();
  assert.match(ending.element('app-error').textContent, /结束通话尚未确认：无法连接本机服务/);
  await ending.pollStatus();
  assert.equal(ending.element('app-error').hidden, false);
  assert.match(ending.element('app-error').textContent, /结束通话尚未确认/);
});

test('connection recovery reinstates pending cleanup and preserves newer provider or SDK errors', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  await f.element('start-call').events.click();
  f.callEvent({ status: 'ending', cleanupUnconfirmed: true, error: 'CALL_CLEANUP_UNCONFIRMED' });
  f.failApi('/api/status', 'network');
  await f.pollStatus();
  assert.match(f.element('app-error').textContent, /无法连接本机服务/);
  f.restoreApi('/api/status');
  await f.pollStatus();
  assert.equal(f.element('app-error').hidden, false);
  assert.match(f.element('app-error').textContent, /线路关闭待确认/);
  assert.equal(f.element('start-call').disabled, true);
  f.callEvent({ status: 'failed', cleanupUnconfirmed: false, error: 'TWILIO_CALL_FAILED', providerErrorCode: 21216 });
  await f.pollStatus();
  assert.equal(f.element('app-error').hidden, false);
  assert.match(f.element('app-error').textContent, /21216/);
  f.failApi('/api/status', 'network');
  await f.pollStatus();
  f.device.emit('error', { code: 31005 });
  f.restoreApi('/api/status');
  await f.pollStatus();
  assert.equal(f.element('app-error').hidden, false);
  assert.match(f.element('app-error').textContent, /31005/);
});

test('authentication failures are not cleared by successful status reads or retried by outage polling', async () => {
  const f = await pageFixture(async () => streamFixture().stream);
  f.failApi('/api/status', { status: 401, error: 'UNAUTHORIZED' });
  await f.pollStatus();
  assert.match(f.element('app-error').textContent, /本机访问凭据已失效/);
  const before = f.requests.length;
  await f.pollStatus();
  assert.equal(f.requests.length, before, 'known rejected local credentials require reopening, not repeated polling');
  f.restoreApi('/api/status');
  await f.element('refresh-status').events.click();
  assert.equal(f.element('app-error').hidden, false);
  assert.match(f.element('app-error').textContent, /本机访问凭据已失效/);
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
