import assert from 'node:assert/strict';
import { test } from 'node:test';

import { analyzePcmuPlayback } from '../src/solo/translation-audio-measurement';

// Fixed G.711 code 0x90 decodes to 15996; 0xff is digital silence. Energy
// detection deliberately does not claim that this constant signal is speech.
const silence = (ms: number) => Buffer.alloc(ms * 8, 0xff);
const energy = (ms: number) => Buffer.alloc(ms * 8, 0x90);

test('leading/trailing silence remains in FIFO duration but not active frames', () => {
  const audio = Buffer.concat([silence(40), energy(40), silence(60)]);
  assert.deepEqual(
    analyzePcmuPlayback(audio, [{ atMs: 100, bytes: audio.length }]),
    {
      firstEnergyAtMs: 140,
      lastEnergyAtMs: 180,
      activeDurationMs: 40,
      totalAudioMs: 140,
      scheduledEndMs: 240,
      thresholdRms: 300,
      frameMs: 20,
    },
  );
});

test('arrival gaps and queued backlog map to actual FIFO scheduling', () => {
  const audio = Buffer.concat([
    energy(20),
    silence(20),
    energy(20),
    energy(20),
  ]);
  const result = analyzePcmuPlayback(audio, [
    { atMs: 100, bytes: 160 },
    { atMs: 200, bytes: 160 },
    { atMs: 205, bytes: 160 },
    { atMs: 210, bytes: 160 },
  ]);
  assert.equal(result.firstEnergyAtMs, 100);
  assert.equal(result.lastEnergyAtMs, 260);
  assert.equal(result.scheduledEndMs, 260);
  assert.equal(result.activeDurationMs, 60);
  assert.equal(result.totalAudioMs, 80);
});

test('a gap at an energy frame boundary belongs to neither adjacent silence nor energy', () => {
  const beforeGap = analyzePcmuPlayback(
    Buffer.concat([energy(20), silence(20)]),
    [
      { atMs: 0, bytes: 160 },
      { atMs: 100, bytes: 160 },
    ],
  );
  assert.equal(beforeGap.lastEnergyAtMs, 20);
  assert.equal(beforeGap.scheduledEndMs, 120);
  const afterGap = analyzePcmuPlayback(
    Buffer.concat([silence(20), energy(20)]),
    [
      { atMs: 0, bytes: 160 },
      { atMs: 100, bytes: 160 },
    ],
  );
  assert.equal(afterGap.firstEnergyAtMs, 100);
});

test('activity windows span transport boundaries without restarting detection', () => {
  const audio = Buffer.concat([silence(10), energy(10), silence(20)]);
  const contiguous = analyzePcmuPlayback(audio, [{ atMs: 50, bytes: 320 }]);
  const split = analyzePcmuPlayback(audio, [
    { atMs: 50, bytes: 3 },
    { atMs: 50, bytes: 77 },
    { atMs: 50, bytes: 79 },
    { atMs: 50, bytes: 1 },
    { atMs: 50, bytes: 160 },
  ]);
  assert.deepEqual(split, contiguous);
  assert.equal(split.firstEnergyAtMs, 50); // Approximate 20 ms frame start.
  assert.equal(split.lastEnergyAtMs, 70);
  assert.equal(split.activeDurationMs, 20);
  const withGapInsideWindow = analyzePcmuPlayback(audio, [
    { atMs: 50, bytes: 80 },
    { atMs: 150, bytes: 240 },
  ]);
  assert.equal(withGapInsideWindow.firstEnergyAtMs, 150);
  assert.equal(withGapInsideWindow.lastEnergyAtMs, 170); // 20 ms post-gap frame.
  assert.equal(withGapInsideWindow.activeDurationMs, 20);
});

test('underflow splits a partial frame without attributing post-gap energy to pre-gap silence', () => {
  const audio = Buffer.concat([silence(10), energy(5), silence(5)]);
  const grouped = analyzePcmuPlayback(audio, [
    { atMs: 50, bytes: 80 },
    { atMs: 1050, bytes: 80 },
  ]);
  assert.equal(grouped.firstEnergyAtMs, 1050);
  assert.equal(grouped.lastEnergyAtMs, 1060);
  assert.equal(grouped.activeDurationMs, 10);
  assert.equal(grouped.totalAudioMs, 20);
  assert.equal(grouped.scheduledEndMs, 1060);
  const split = analyzePcmuPlayback(audio, [
    { atMs: 50, bytes: 3 },
    { atMs: 50, bytes: 77 },
    { atMs: 1050, bytes: 17 },
    { atMs: 1051, bytes: 63 },
  ]);
  assert.deepEqual(split, grouped);
});

test('partial final frame uses its true sample count and duration', () => {
  const audio = Buffer.concat([silence(20), energy(5)]);
  const result = analyzePcmuPlayback(audio, [{ atMs: 10, bytes: 200 }]);
  assert.equal(result.firstEnergyAtMs, 30);
  assert.equal(result.lastEnergyAtMs, 35);
  assert.equal(result.activeDurationMs, 5);
  assert.equal(result.totalAudioMs, 25);
});

test('empty audio and all-silent audio have no energy times', () => {
  assert.deepEqual(analyzePcmuPlayback(Buffer.alloc(0), []), {
    firstEnergyAtMs: null,
    lastEnergyAtMs: null,
    activeDurationMs: 0,
    totalAudioMs: 0,
    scheduledEndMs: null,
    thresholdRms: 300,
    frameMs: 20,
  });
  const silent = analyzePcmuPlayback(silence(25), [{ atMs: 5, bytes: 200 }]);
  assert.equal(silent.firstEnergyAtMs, null);
  assert.equal(silent.lastEnergyAtMs, null);
  assert.equal(silent.activeDurationMs, 0);
  assert.equal(silent.scheduledEndMs, 30);
  // μ-law 0xfe decodes to 8: low-level audio is below the RMS threshold.
  assert.equal(
    analyzePcmuPlayback(Buffer.alloc(160, 0xfe), [{ atMs: 0, bytes: 160 }])
      .activeDurationMs,
    0,
  );
});

test('reject invalid byte counts, unmatched audio and unordered/nonfinite arrivals', () => {
  for (const bytes of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(
      () => analyzePcmuPlayback(Buffer.alloc(1), [{ atMs: 0, bytes }]),
      RangeError,
    );
  }
  for (const atMs of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () => analyzePcmuPlayback(Buffer.alloc(1), [{ atMs, bytes: 1 }]),
      RangeError,
    );
  }
  assert.throws(
    () => analyzePcmuPlayback(Buffer.alloc(2), [{ atMs: 0, bytes: 1 }]),
    RangeError,
  );
  assert.throws(() => analyzePcmuPlayback(Buffer.alloc(1), []), RangeError);
  assert.throws(
    () => analyzePcmuPlayback(Buffer.alloc(0), [{ atMs: 0, bytes: 1 }]),
    RangeError,
  );
  assert.throws(
    () =>
      analyzePcmuPlayback(Buffer.alloc(2), [
        { atMs: 1, bytes: 1 },
        { atMs: 0, bytes: 1 },
      ]),
    RangeError,
  );
});
