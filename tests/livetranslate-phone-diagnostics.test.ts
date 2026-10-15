import assert from 'node:assert/strict';
import test from 'node:test';

import {
  reportCloudLiveTranslateDiagnostic,
  sanitizeLiveTranslatePhoneDiagnostic,
} from '../src/solo/livetranslate-phone-diagnostics';

test('voice declarations retain requested, created/done and both ACK layers without an effective-voice guess', () => {
  const base = {
    role: 'local',
    at: 1200,
    clock: 'application_epoch_ms',
    stage: 'voice_evidence',
    requestedVoice: 'Andre',
    topLevelVoice: 'Andre',
    nestedVoice: 'Tina',
    voicePolicy: 'approved_andre_tina_metadata_conflict',
    topLevelVoiceStatus: 'reported',
    nestedVoiceStatus: 'reported',
  };
  const created = sanitizeLiveTranslatePhoneDiagnostic({
    ...base,
    voiceEvent: 'response.created',
    responseVoice: 'Andre',
    responseVoiceStatus: 'reported',
  });
  const done = sanitizeLiveTranslatePhoneDiagnostic({
    ...base,
    voiceEvent: 'response.done',
    responseVoice: 'Tina',
    responseVoiceStatus: 'reported',
  });
  assert.equal(created?.requestedVoice, 'Andre');
  assert.equal(created?.nestedVoice, 'Tina');
  assert.equal(created?.responseVoice, 'Andre');
  assert.equal(done?.responseVoice, 'Tina');
  assert.equal('effectiveVoice' in (done ?? {}), false);
  const missing = sanitizeLiveTranslatePhoneDiagnostic({
    ...base,
    responseVoice: null,
    responseVoiceStatus: 'missing',
  });
  assert.equal(missing?.responseVoice, null);
  assert.equal(missing?.responseVoiceStatus, 'missing');
});

test('diagnostic projection rejects accessors, arbitrary payloads, phone numbers and exception text', () => {
  let getters = 0;
  const hostile = {
    role: 'remote',
    stage: 'failed',
    at: 1400,
    code: 'LIVETRANSLATE_PHONE_SESSION_FAILED:arbitrary-untrusted-content',
    apiKey: 'fixture-secret-must-not-leak',
    Authorization: 'fixture-auth-must-not-leak',
    phone: '+12025550100',
    text: 'fixture-private-speech',
    sourceId: 'supplier-id',
    responseId: 'supplier-response',
    url: 'https://example.invalid/?secret=fixture',
    queuedBytes: -1,
    bytes: Infinity,
    inputTokens: NaN,
    closeCode: 1006,
    httpStatusCode: 403,
  };
  Object.defineProperty(hostile, 'model', {
    get() {
      getters += 1;
      throw new Error('DO_NOT_READ');
    },
  });
  const safe = sanitizeLiveTranslatePhoneDiagnostic(hostile);
  assert.deepEqual(safe, {
    role: 'remote',
    stage: 'failed',
    at: 1400,
    closeCode: 1006,
    httpStatusCode: 403,
  });
  assert.equal(getters, 0);
  assert.equal(
    sanitizeLiveTranslatePhoneDiagnostic({
      ...hostile,
      stage: 'supplier-free-text',
    }),
    undefined,
  );
});

test('playback queue and mark diagnostics cannot claim a receiver started playing', () => {
  for (const stage of ['playback_queued', 'playback_drained']) {
    const safe = sanitizeLiveTranslatePhoneDiagnostic({
      role: 'local',
      stage,
      at: 2000,
      bytes: 8000,
      actualPlaybackStartAt: 1500,
    });
    assert.equal(safe?.actualPlaybackStartAt, null);
    assert.equal(safe?.bytes, 8000);
  }
});

test('input submission and supplier endpoint estimates keep their distinct measurement basis', () => {
  const submitted = sanitizeLiveTranslatePhoneDiagnostic({
    role: 'local',
    stage: 'input_received',
    at: 1900,
    clock: 'application_epoch_ms',
    basis: 'model_input_submitted',
    bytes: 6400,
    inputAudioMs: 200,
    sourceSequence: 1,
    responseSequence: 2,
  });
  assert.equal(submitted?.basis, 'model_input_submitted');
  assert.equal(submitted?.inputAudioMs, 200);
  const estimated = sanitizeLiveTranslatePhoneDiagnostic({
    role: 'local',
    stage: 'source_stopped',
    at: 2000,
    providerAudioMs: 1850,
    providerEndpointBasis: 'provider_stream_estimate',
    acousticSpeechEndAt: 1800,
  });
  assert.equal(estimated?.providerEndpointBasis, 'provider_stream_estimate');
  assert.equal(estimated?.providerAudioMs, 1850);
  assert.equal('acousticSpeechEndAt' in (estimated ?? {}), false);
});

test('only exact fixed warnings/failures and scalar usage can enter the selected service log', () => {
  const safe = sanitizeLiveTranslatePhoneDiagnostic({
    role: 'local',
    stage: 'failed',
    at: 2200,
    code: 'LIVETRANSLATE_SOURCE_ANCHOR_MISSING',
  });
  assert.equal(safe?.code, 'LIVETRANSLATE_SOURCE_ANCHOR_MISSING');
  const lines: string[] = [];
  reportCloudLiveTranslateDiagnostic(
    {
      event: 'translation-live',
      data: {
        role: 'local',
        stage: 'usage',
        at: 2300,
        sessionId: '12345678-1234-4123-8123-123456789abc',
        usageBasis: 'provider_reported',
        inputAudioTokens: 140,
        inputTextTokens: 47,
        outputAudioTokens: 209,
        outputTextTokens: 104,
        providerSessionId: 'supplier-private-id',
        text: 'private-content',
      },
    },
    (line) => lines.push(line),
  );
  const record = JSON.parse(lines[0]);
  assert.equal(record.callId, '12345678-1234-4123-8123-123456789abc');
  assert.equal(record.inputTextTokens, 47);
  assert.equal(record.event, 'CLOUD_LIVETRANSLATE_DIAGNOSTIC');
  assert.equal(lines[0].includes('private'), false);
  reportCloudLiveTranslateDiagnostic(
    {
      event: 'translation-live',
      data: {
        role: 'local',
        stage: 'warning',
        at: 2500,
        code: 'LIVETRANSLATE_APPROVED_ANDRE_TINA_CONFLICT',
      },
    },
    () => {
      throw new Error('BROKEN_LOG');
    },
  );
});
