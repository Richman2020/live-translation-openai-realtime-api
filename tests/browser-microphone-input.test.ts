import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createMicrophoneInput } from '../public/microphone-input.js';

test('inventory uses only audio inputs, retains unavailable selection and never captures', async () => {
  let captures = 0;
  let devices = [
    { kind: 'audioinput', deviceId: 'headset', label: 'Headset microphone' },
    { kind: 'audioinput', deviceId: 'camera', label: 'Camera microphone' },
    { kind: 'audiooutput', deviceId: 'speaker', label: 'Speaker' },
  ];
  const mediaDevices = { enumerateDevices: async () => devices, getUserMedia: async () => { captures++; } };
  const input = createMicrophoneInput({ mediaDevices });
  await input.refresh(); assert.equal(input.snapshot.devices.length, 2);
  assert.equal(input.select('speaker'), false); assert.equal(input.select('headset'), true);
  assert.deepEqual(await input.constraints(), { audio: { deviceId: { exact: 'headset' } } });
  devices = devices.filter(device => device.deviceId !== 'headset');
  await input.refresh(); assert.equal(input.snapshot.selectedId, 'headset');
  assert.equal(input.snapshot.selectedAvailable, false);
  await assert.rejects(input.constraints(), { code: 'MICROPHONE_SELECTED_UNAVAILABLE' });
  assert.equal(input.select(''), true); assert.deepEqual(await input.constraints(), { audio: true });
  assert.equal(captures, 0); input.dispose();
});

test('a failed enumeration cannot authorize a previously selected device', async () => {
  let failure = false;
  const input = createMicrophoneInput({ mediaDevices: { enumerateDevices: async () => {
    if (failure) throw new Error('private device failure');
    return [{ kind: 'audioinput', deviceId: 'headset', label: 'Headset' }];
  } } });
  await input.refresh(); input.select('headset'); failure = true;
  await assert.rejects(input.constraints(), { code: 'MICROPHONE_SELECTED_UNAVAILABLE' });
  assert.equal(input.snapshot.selectedAvailable, false); assert.doesNotMatch(input.snapshot.message, /private/);
  input.dispose();
});

test('disposing ignores late enumeration and removes the devicechange listener', async () => {
  let resolve!: (devices: any[]) => void;
  const pending = new Promise<any[]>(yes => { resolve = yes; });
  const mediaDevices = Object.assign(new EventEmitter(), {
    enumerateDevices: () => pending,
    addEventListener(name: string, listener: (...args: any[]) => void) { this.on(name, listener); },
    removeEventListener(name: string, listener: (...args: any[]) => void) { this.off(name, listener); },
  });
  let changes = 0; const input = createMicrophoneInput({ mediaDevices, onChange: () => { changes++; } });
  const refreshing = input.refresh(); input.dispose(); const previous = changes;
  assert.equal(mediaDevices.listenerCount('devicechange'), 0);
  resolve([{ kind: 'audioinput', deviceId: 'late', label: 'Late device' }]);
  assert.equal(await refreshing, false); assert.equal(changes, previous);
  await assert.rejects(input.constraints(), { code: 'MICROPHONE_SELECTED_UNAVAILABLE' });
});
