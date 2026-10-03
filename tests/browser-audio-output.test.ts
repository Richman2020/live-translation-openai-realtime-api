import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createAudioOutput } from '../public/audio-output.js';

function deferred() {
  let resolve!: () => void; let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
class AudioFixture extends EventEmitter {
  src = ''; srcObject: unknown = null; preload = ''; loop = false; volume = 1;
  sinkId = ''; plays = 0; pauses = 0; loads = 0;
  playResult = () => Promise.resolve();
  sinkResult = (_id: string) => Promise.resolve();
  addEventListener(event: string, listener: (...args: any[]) => void) { this.on(event, listener); }
  removeEventListener(event: string, listener: (...args: any[]) => void) { this.off(event, listener); }
  setSinkId(id: string) { this.sinkId = id; return this.sinkResult(id); }
  play() { this.plays++; return this.playResult(); }
  pause() { this.pauses++; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  load() { this.loads++; }
}
function helperFixture() {
  const helper = Object.assign(new EventEmitter(), {
    isOutputSelectionSupported: true,
    availableOutputDevices: new Map(['default', 'communications', 'headset'].map(deviceId => [deviceId, { deviceId, label: deviceId === 'headset' ? 'USB 耳机' : '' }])),
    active: new Set([{ deviceId: 'default' }]),
    sets: [] as string[],
    setResult: async (id: string) => { helper.active = new Set([{ deviceId: id }]); },
    speakerDevices: {
      get: () => helper.active,
      set: async (id: string) => { helper.sets.push(id); await helper.setResult(id); },
    },
  });
  return helper;
}
function fixture(timeoutMs = 1000) {
  const audios: AudioFixture[] = []; const snapshots: any[] = [];
  const output = createAudioOutput({ timeoutMs, onChange: value => snapshots.push(value), createAudio: () => {
    const audio = new AudioFixture(); audios.push(audio); return audio;
  } });
  const helper = helperFixture(); output.bind(helper);
  return { output, helper, audios, snapshots };
}

test('selection uses available devices and confirms the SDK readback without automatic switching', async () => {
  const f = fixture();
  assert.equal(f.output.snapshot.selectedId, 'default');
  assert.deepEqual(f.helper.sets, []);
  assert.equal(f.output.snapshot.devices[1].label, '默认通信输出');
  assert.equal(await f.output.select('headset'), true);
  assert.equal(f.output.snapshot.selectedId, 'headset');
  assert.deepEqual(f.helper.sets, ['headset']);
  assert.equal(f.output.snapshot.status, 'idle');
  const copy = f.output.snapshot; copy.devices[0].label = 'mutated';
  assert.notEqual(f.output.snapshot.devices[0].label, 'mutated');
});

test('a resolved SDK set without matching readback is not reported as successful', async () => {
  const f = fixture(); f.helper.setResult = async () => {};
  assert.equal(await f.output.select('headset'), false);
  assert.equal(f.output.snapshot.selectedId, 'default');
  assert.match(f.output.snapshot.message, /未确认/);
  assert.equal(await f.output.select('missing'), false);
  assert.deepEqual(f.helper.sets, ['headset']);
});

test('failed selection reports actual route and excludes arbitrary SDK error messages', async () => {
  const f = fixture();
  f.helper.setResult = async () => { throw new Error('private device identifier'); };
  assert.equal(await f.output.select('headset'), false);
  assert.equal(f.output.snapshot.selectedId, 'default');
  assert.match(f.output.snapshot.message, /切换失败/);
  assert.doesNotMatch(JSON.stringify(f.snapshots), /private device identifier/);
});

test('test audio uses the SDK-confirmed sink and completes only at ended, releasing audio', async () => {
  const f = fixture(); await f.output.select('headset');
  const result = f.output.test(); await tick(); const audio = f.audios[0];
  assert.equal(audio.src, '/assets/speaker-test.wav');
  assert.equal(audio.sinkId, 'headset'); assert.equal(audio.plays, 1);
  assert.equal(f.output.snapshot.status, 'testing');
  audio.emit('ended'); assert.equal(await result, true);
  assert.equal(f.output.snapshot.status, 'idle'); assert.match(f.output.snapshot.message, /请自行确认/);
  assert.equal(audio.src, ''); assert.equal(audio.pauses, 1); assert.equal(audio.loads, 1);
  assert.equal(audio.listenerCount('ended'), 0); assert.equal(audio.listenerCount('error'), 0);
});

test('unsupported output selection still tests system default without setSinkId or microphone capture', async () => {
  const f = fixture(); f.helper.isOutputSelectionSupported = false; f.output.refresh();
  assert.equal(f.output.snapshot.supported, false);
  assert.equal(await f.output.select('headset'), false);
  const result = f.output.test(); await tick();
  assert.equal(f.audios[0].sinkId, ''); assert.equal(f.audios[0].plays, 1);
  f.audios[0].emit('ended'); assert.equal(await result, true);
  assert.deepEqual(f.helper.sets, []);
});

test('routing rejection never falls back to playing through another output', async () => {
  const helper = helperFixture(); const audio = new AudioFixture();
  audio.sinkResult = async () => { throw Object.assign(new Error('private'), { name: 'NotAllowedError' }); };
  const output = createAudioOutput({ createAudio: () => audio }); output.bind(helper);
  assert.equal(await output.test(), false);
  assert.equal(audio.plays, 0); assert.equal(audio.pauses, 1);
  assert.match(output.snapshot.message, /浏览器阻止/); assert.doesNotMatch(output.snapshot.message, /private/);
});

test('missing player sink support does not silently use default when SDK reports a selected sink', async () => {
  const audio = new AudioFixture(); Object.defineProperty(audio, 'setSinkId', { value: undefined });
  const output = createAudioOutput({ createAudio: () => audio }); output.bind(helperFixture());
  assert.equal(await output.test(), false); assert.equal(audio.plays, 0);
  assert.equal(audio.loads, 1); assert.match(output.snapshot.message, /无法将测试音送往已选设备/);
});

test('cancel during pending sink selection prevents a delayed play', async () => {
  const pending = deferred(); const audio = new AudioFixture(); audio.sinkResult = () => pending.promise;
  const output = createAudioOutput({ createAudio: () => audio }); output.bind(helperFixture());
  const result = output.test(); output.cancelTest(); assert.equal(await result, false);
  pending.resolve(); await tick(); assert.equal(audio.plays, 0); assert.equal(audio.src, '');
});

test('play rejection and media error release resources instead of reporting completion', async () => {
  const helper = helperFixture(); const audio = new AudioFixture();
  audio.playResult = async () => { throw Object.assign(new Error(), { name: 'NotAllowedError' }); };
  const output = createAudioOutput({ createAudio: () => audio }); output.bind(helper);
  assert.equal(await output.test(), false); assert.match(output.snapshot.message, /浏览器阻止/);
  const f = fixture(); const result = f.output.test(); f.audios[0].emit('error');
  assert.equal(await result, false); assert.equal(f.audios[0].loads, 1);
  assert.match(f.output.snapshot.message, /无法播放/);
});

test('a pending play has a bounded timeout and late completion cannot restore testing state', async () => {
  const pending = deferred(); const audio = new AudioFixture(); audio.playResult = () => pending.promise;
  const output = createAudioOutput({ timeoutMs: 10, createAudio: () => audio }); output.bind(helperFixture());
  assert.equal(await output.test(), false); assert.match(output.snapshot.message, /超时/);
  const after = output.snapshot; pending.resolve(); await tick();
  assert.deepEqual(output.snapshot, after); assert.equal(audio.pauses, 1);
});

test('cancel stops a test and ignores late play resolution', async () => {
  const pending = deferred(); const audio = new AudioFixture(); audio.playResult = () => pending.promise;
  const output = createAudioOutput({ createAudio: () => audio }); output.bind(helperFixture());
  const result = output.test(); await tick(); output.cancelTest();
  assert.equal(await result, false); const after = output.snapshot;
  pending.resolve(); await tick(); assert.deepEqual(output.snapshot, after);
  assert.equal(audio.src, ''); assert.equal(audio.listenerCount('ended'), 0);
});

test('rebinding detaches listeners and ignores a retired selection result', async () => {
  const f = fixture(); const pending = deferred(); f.helper.setResult = () => pending.promise;
  const selected = f.output.select('headset'); assert.equal(f.output.snapshot.status, 'selecting');
  const next = helperFixture(); next.active = new Set([{ deviceId: 'communications' }]);
  f.output.bind(next); const after = f.output.snapshot;
  assert.equal(f.helper.listenerCount('deviceChange'), 0);
  pending.resolve(); assert.equal(await selected, false);
  assert.deepEqual(f.output.snapshot, after); assert.deepEqual(next.sets, []);
});

test('selection timeout returns false but keeps the helper locked until the real SDK switch settles', async () => {
  const f = fixture(10); const pending = deferred();
  f.helper.setResult = async id => { await pending.promise; f.helper.active = new Set([{ deviceId: id }]); };
  assert.equal(await f.output.select('headset'), false);
  assert.equal(f.output.snapshot.status, 'selecting');
  assert.match(f.output.snapshot.message, /超时.*关闭通话再重新开启/);
  assert.equal(await f.output.select('communications'), false);
  assert.deepEqual(f.helper.sets, ['headset']);
  pending.resolve(); await tick();
  assert.equal(f.output.snapshot.status, 'idle');
  assert.equal(f.output.snapshot.selectedId, 'headset');
  assert.match(f.output.snapshot.message, /输出已切换/);
});

test('a timed-out switch that later rejects unlocks with a failure and the actual route', async () => {
  const f = fixture(10); const pending = deferred(); f.helper.setResult = () => pending.promise;
  assert.equal(await f.output.select('headset'), false);
  pending.reject(new Error('private routing error')); await tick();
  assert.equal(f.output.snapshot.status, 'idle'); assert.equal(f.output.snapshot.selectedId, 'default');
  assert.match(f.output.snapshot.message, /切换失败/); assert.doesNotMatch(f.output.snapshot.message, /private/);
});

test('rebinding releases an unresolved selection immediately and cancels its timeout', async () => {
  const f = fixture(10); const pending = deferred(); f.helper.setResult = () => pending.promise;
  const selected = f.output.select('headset'); const next = helperFixture();
  f.output.bind(next); assert.equal(await selected, false);
  assert.equal(await f.output.select('communications'), true); const after = f.output.snapshot;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(f.output.snapshot, after);
  pending.resolve(); await tick();
  assert.deepEqual(f.output.snapshot, after); assert.deepEqual(next.sets, ['communications']);
});

test('rebinding after timeout prevents the late old switch from replacing the new route', async () => {
  const f = fixture(10); const pending = deferred();
  f.helper.setResult = async id => { await pending.promise; f.helper.active = new Set([{ deviceId: id }]); };
  assert.equal(await f.output.select('headset'), false);
  const next = helperFixture(); f.output.bind(next);
  assert.equal(await f.output.select('communications'), true); const after = f.output.snapshot;
  pending.resolve(); await tick();
  assert.equal(f.helper.active.values().next().value?.deviceId, 'headset');
  assert.deepEqual(f.output.snapshot, after); assert.equal(f.output.snapshot.selectedId, 'communications');
});

test('rebinding cancels playback and stale callbacks cannot change the new binding', async () => {
  const f = fixture(); const result = f.output.test(); await tick(); const audio = f.audios[0];
  f.output.bind(null); const after = f.output.snapshot;
  assert.equal(await result, false); assert.equal(audio.pauses, 1);
  audio.emit('ended'); f.helper.emit('deviceChange');
  assert.deepEqual(f.output.snapshot, after);
});

test('a device change reflects SDK fallback and cancels a test of the removed output', async () => {
  const f = fixture(); await f.output.select('headset'); const result = f.output.test(); await tick();
  f.helper.availableOutputDevices.delete('headset'); f.helper.active = new Set([{ deviceId: 'default' }]);
  f.helper.emit('deviceChange');
  assert.equal(await result, false); assert.equal(f.output.snapshot.selectedId, 'default');
  assert.match(f.output.snapshot.message, /输出设备已改变/);
  assert.deepEqual(f.helper.sets, ['headset']);
});

test('multiple active SDK sinks require an explicit single selection before test', async () => {
  const f = fixture(); f.helper.active = new Set([{ deviceId: 'default' }, { deviceId: 'headset' }]);
  f.output.refresh(); assert.equal(await f.output.test(), false);
  assert.equal(f.audios.length, 0); assert.match(f.output.snapshot.message, /选择一个/);
});
