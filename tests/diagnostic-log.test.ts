import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagnosticLogRecord } from '../src/solo/diagnostic-log';

const pipelineId = 'aa112233-4455-4667-8899-aabbccddeeff';
test('audio log retains exact anonymous correlation and monotonic elapsed time only', () => {
  const actual = diagnosticLogRecord(
    'translation-audio',
    {
      pipelineId,
      deliveryId: 'continuous_7',
      clock: 'bridge_monotonic',
      role: 'local',
      stage: 'playback_confirmed',
      createdAtMs: 100,
      sentAtMs: 101,
      acknowledgedAtMs: 500,
      sentToMarkMs: 399,
      outstandingAudioMs: 400,
      rms: 120.5,
      peak: 1000,
      audio: 'private waveform',
      text: 'private transcript',
      sessionId: 'private session',
      streamSid: 'MZprivate',
      apiKey: 'private credential',
      error: { message: 'private provider error' },
    },
    'test-clock',
  );
  assert.deepEqual(actual, {
    at: 'test-clock',
    event: 'translation-audio',
    role: 'local',
    pipelineId,
    clock: 'bridge_monotonic',
    stage: 'playback_confirmed',
    deliveryId: 'continuous_7',
    createdAtMs: 100,
    sentAtMs: 101,
    acknowledgedAtMs: 500,
    sentToMarkMs: 399,
    outstandingAudioMs: 400,
    rms: 120.5,
    peak: 1000,
  });
});

test('log rejects arbitrary strings, invalid numbers and unsafe IDs', () => {
  const actual = diagnosticLogRecord(
    'translation-audio',
    {
      pipelineId: 'credential',
      deliveryId: 'provider-secret',
      clock: 'private-clock',
      stage: 'private-error',
      role: 'private-name',
      sentToMarkMs: NaN,
      outstandingAudioMs: Infinity,
      peak: 32769,
      rms: -1,
      sentBytes: 'private-data',
      providerElapsedMs: {},
      generatedBytes: 0,
    },
    'test-clock',
  );
  assert.deepEqual(actual, {
    at: 'test-clock',
    event: 'translation-audio',
    generatedBytes: 0,
  });
  assert.equal(
    diagnosticLogRecord('transcript', { text: 'private' }),
    undefined,
  );
});

test('provider timing logging cannot expose complete session metadata', () => {
  const actual = diagnosticLogRecord(
    'translation-provider',
    {
      pipelineId,
      role: 'local',
      stage: 'session_created',
      observedAtMs: 10,
      expiresAtEpochSeconds: 1790600000,
      session: { id: 'private' },
      id: 'private',
    },
    'test-clock',
  );
  assert.deepEqual(actual, {
    at: 'test-clock',
    event: 'translation-provider',
    role: 'local',
    pipelineId,
    observedAtMs: 10,
    stage: 'session_created',
    expiresAtEpochSeconds: 1790600000,
  });
});

test('existing caption and legacy generation diagnostics remain available', () => {
  assert.equal(
    diagnosticLogRecord('caption-input', {
      stage: 'asr-final',
      finalCharacters: 6,
    })?.stage,
    'asr-final',
  );
  assert.equal(
    diagnosticLogRecord('translation-metric', {
      name: 'speech_stop_to_first_audio_ms',
      scope: 'provider_generation',
      value: 600,
    })?.value,
    600,
  );
});

test('input energy windows retain timing but never samples or content', () => {
  const record = diagnosticLogRecord(
    'translation-input',
    {
      pipelineId,
      role: 'local',
      clock: 'bridge_monotonic',
      observedAtMs: 300,
      windowStartedAtMs: 100,
      windowEndedAtMs: 300,
      audioDurationMs: 200,
      rms: 0,
      peak: 0,
      mediaTimestampMs: 400,
      payload: 'private audio',
      text: 'private words',
      callSid: 'private account',
    },
    'test-clock',
  );
  assert.deepEqual(record, {
    at: 'test-clock',
    event: 'translation-input',
    pipelineId,
    role: 'local',
    clock: 'bridge_monotonic',
    observedAtMs: 300,
    windowStartedAtMs: 100,
    windowEndedAtMs: 300,
    audioDurationMs: 200,
    rms: 0,
    peak: 0,
    mediaTimestampMs: 400,
  });
});
