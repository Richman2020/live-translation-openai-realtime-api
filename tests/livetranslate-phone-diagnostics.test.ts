import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LIVE_TRANSLATE_ITEM_CONFLICT_KINDS,
  LIVE_TRANSLATE_FAILURE_CODES,
  LIVE_TRANSLATE_PROTOCOL_DIAGNOSTIC_EXPECTATIONS,
  LIVE_TRANSLATE_PROTOCOL_DIAGNOSTIC_PATHS,
  LIVE_TRANSLATE_PROTOCOL_EVENT_TYPES,
  LIVE_TRANSLATE_PROTOCOL_VALUE_TYPES,
} from '../src/experiments/livetranslate-types';
import {
  LIVE_TRANSLATE_PHONE_FAILURE_CODES,
  LIVE_TRANSLATE_PHONE_WARNING_CODES,
} from '../src/solo/livetranslate-phone-types';

import {
  reportCloudLiveTranslateDiagnostic,
  sanitizeLiveTranslatePhoneDiagnostic,
  projectLiveTranslateProtocolFailure,
  projectLiveTranslateProtocolWarning,
  projectLiveTranslateSendObservation,
  projectLiveTranslatePhoneSendDiagnostic,
} from '../src/solo/livetranslate-phone-diagnostics';
import { sendDiagnosticFixture } from './fixtures/livetranslate-send-diagnostic';
import { LIVE_TRANSLATE_DIAGNOSTIC_MAX_WINDOW_BYTES } from '../src/experiments/livetranslate-send-diagnostics';

const protocolFailure = {
  role: 'local',
  stage: 'protocol_failure',
  fatal: true,
  at: 2400,
  code: 'LIVETRANSLATE_ITEM_CONFLICT',
  eventType: 'conversation.item.created',
  validationPath: 'item.id',
  expected: 'consistent_item_binding',
  actualType: 'string',
  receiveSequence: 21,
};

test('bounded send windows preserve raw callback gaps and unknown fields through both phone metadata boundaries', () => {
  const batch = sendDiagnosticFixture('send_failure');
  const first = projectLiveTranslatePhoneSendDiagnostic(
    {
      ...batch,
      role: 'local',
      sessionId: 'PRIVATE_PROVIDER_ID',
      audio: 'PRIVATE_PCM',
      transcript: 'PRIVATE_TRANSCRIPT',
      headers: { Authorization: 'PRIVATE_AUTH' },
    },
    'remote',
  )!;
  assert.equal(first.role, 'remote');
  assert.equal(first.stage, 'send_window');
  assert.deepEqual(first.sendDiagnostic, batch);
  const second = sanitizeLiveTranslatePhoneDiagnostic(first)!;
  assert.deepEqual(second.sendDiagnostic, batch);
  const lines: string[] = [];
  reportCloudLiveTranslateDiagnostic(
    {
      event: 'translation-live',
      data: { ...second, sessionId: '12345678-1234-4123-8123-123456789abc' },
    },
    (line) => lines.push(line),
  );
  const logged = JSON.parse(lines[0]);
  assert.equal(logged.callId, '12345678-1234-4123-8123-123456789abc');
  assert.equal(logged.sendDiagnostic.records[0].senderBufferedBytes, null);
  assert.equal(logged.sendDiagnostic.records[0].writableBufferedBytes, null);
  assert.equal(logged.sendDiagnostic.records[0].contiguousWrittenSequence, 0);
  assert.equal(logged.sendDiagnostic.records[0].prefixGapSequence, 1);
  assert.equal(logged.sendDiagnostic.records[0].completedBehindGapFrames, 1);
  assert.equal(lines[0].includes('PRIVATE'), false);
});

test('send window projection never executes getters or toJSON and rejects malformed records at both boundaries', () => {
  let getterReads = 0;
  const accessor = {
    get() {
      getterReads += 1;
      throw new Error('PRIVATE');
    },
  };
  const sample = sendDiagnosticFixture();
  Object.defineProperty(sample, 'headers', accessor);
  Object.defineProperty(sample.records[0], 'audio', accessor);
  Object.defineProperty(sample, 'toJSON', accessor);
  assert.ok(projectLiveTranslatePhoneSendDiagnostic(sample, 'local'));
  assert.equal(getterReads, 0);
  const guardedRecords = [] as unknown[];
  Object.defineProperty(guardedRecords, '0', accessor);
  const invalid = [
    { ...sample, records: guardedRecords },
    { ...sample, records: Array(25).fill(sample.records[0]) },
    { ...sample, records: [{ ...sample.records[0], stage: 'PRIVATE' }] },
    { ...sample, records: [{ ...sample.records[0], senderBufferedBytes: -1 }] },
    {
      ...sample,
      records: [{ ...sample.records[0], callbackDurationMs: Infinity }],
    },
  ];
  for (const item of invalid) {
    assert.equal(
      projectLiveTranslatePhoneSendDiagnostic(item, 'local'),
      undefined,
    );
    assert.equal(
      sanitizeLiveTranslatePhoneDiagnostic({
        role: 'local',
        stage: 'send_window',
        at: 1000,
        sendDiagnostic: item,
      }),
      undefined,
    );
  }
  assert.equal(getterReads, 0);
  const top = { ...sample };
  Object.defineProperty(top, 'records', accessor);
  assert.equal(
    projectLiveTranslatePhoneSendDiagnostic(top, 'remote'),
    undefined,
  );
  assert.equal(getterReads, 0);
  reportCloudLiveTranslateDiagnostic(
    {
      event: 'translation-live',
      data: projectLiveTranslatePhoneSendDiagnostic(sample, 'remote'),
    },
    () => {
      throw new Error('SINK_FAILURE');
    },
  );
});

test('the final send log fits its trusted envelope without silently losing the fault window', () => {
  const batch = sendDiagnosticFixture('send_failure');
  batch.records = Array.from({ length: 24 }, () => ({ ...batch.records[0] }));
  // Synthetic large finite metadata builds a valid body just under its 32 KiB
  // cap. The final sink must trim old metadata and keep the fault snapshot.
  for (const record of batch.records) {
    for (const key of Object.keys(record)) {
      if (
        Buffer.byteLength(JSON.stringify(batch)) >=
        LIVE_TRANSLATE_DIAGNOSTIC_MAX_WINDOW_BYTES - 40
      )
        break;
      const data = record as unknown as Record<string, unknown>;
      if (
        typeof data[key] === 'number' ||
        [
          'senderBufferedBytes',
          'writableBufferedBytes',
          'webSocketBufferedBytes',
          'eventLoopSampleCount',
          'eventLoopMeanMs',
          'eventLoopMaxMs',
          'callbackDurationMs',
          'firstUnconfirmedSequence',
          'prefixGapSequence',
          'oldestUnfinishedAgeMs',
        ].includes(key)
      )
        data[key] = 1.2345678901234567e-150;
    }
  }
  const bodyBytes = Buffer.byteLength(JSON.stringify(batch));
  assert.ok(bodyBytes <= LIVE_TRANSLATE_DIAGNOSTIC_MAX_WINDOW_BYTES);
  assert.ok(bodyBytes >= LIVE_TRANSLATE_DIAGNOSTIC_MAX_WINDOW_BYTES - 200);
  const first = projectLiveTranslatePhoneSendDiagnostic(batch, 'local');
  assert.ok(
    first,
    'The inner body is valid, so this specifically tests final-envelope accounting',
  );
  const lines: string[] = [];
  const receipt = reportCloudLiveTranslateDiagnostic(
    {
      event: 'translation-live',
      data: { ...first, sessionId: '12345678-1234-4123-8123-123456789abc' },
    },
    (line) => lines.push(line),
  );
  assert.equal(lines.length, 1);
  assert.ok(
    Buffer.byteLength(lines[0]) <= LIVE_TRANSLATE_DIAGNOSTIC_MAX_WINDOW_BYTES,
  );
  const retained = JSON.parse(lines[0]);
  assert.equal(retained.role, 'local');
  assert.equal(retained.callId, '12345678-1234-4123-8123-123456789abc');
  assert.equal(retained.message, 'LiveTranslate input send diagnostic');
  assert.equal(retained.sendDiagnostic.trigger, 'send_failure');
  assert.ok(retained.sendDiagnostic.summary.windowTruncatedRecords > 0);
  assert.equal(retained.sendDiagnostic.summary.truncatedRecords, 0);
  assert.deepEqual(
    retained.sendDiagnostic.records.at(-1),
    batch.records.at(-1),
  );
  assert.equal(retained.sendDiagnostic.summary.futureSuppressedRecords, null);
  assert.deepEqual(receipt, {
    status: 'sink_returned',
    generatedRows: 1,
    sinkReturnedRows: 1,
    discardedWindows: 0,
    railwayStored: null,
  });
});

test('fault anchors and unknown transport measurements survive phone logging without claiming platform storage', () => {
  const batch = sendDiagnosticFixture('transport_closed');
  const raw = {
    ...batch.records[0],
    callbackError: true,
    callbackErrorCode: 'EPIPE' as const,
  };
  const failure = {
    ...batch.records[0],
    stage: 'send_failed' as const,
    sendReason: 'write_callback_error' as const,
  };
  batch.firstFailure = { failure, precedingRawCallback: raw };
  batch.records[0] = {
    ...batch.records[0],
    stage: 'transport_closed',
    closeCode: 1006,
  };
  const lines: string[] = [];
  const event = {
    event: 'translation-live',
    data: {
      ...projectLiveTranslatePhoneSendDiagnostic(batch, 'remote'),
      sessionId: '12345678-1234-4123-8123-123456789abc',
    },
  };
  const receipt = reportCloudLiveTranslateDiagnostic(event, (line) =>
    lines.push(line),
  );
  assert.ok(receipt);
  assert.equal(receipt.railwayStored, null);
  const retained = JSON.parse(lines[0]);
  assert.equal(retained.role, 'remote');
  assert.deepEqual(retained.sendDiagnostic.firstFailure, batch.firstFailure);
  assert.equal(retained.sendDiagnostic.records[0].senderBufferedBytes, null);
  assert.equal(retained.sendDiagnostic.records[0].writableBufferedBytes, null);
  assert.equal(retained.sendDiagnostic.records[0].perMessageDeflate, null);
  assert.equal(
    retained.sendDiagnostic.firstFailure.precedingRawCallback.prefixGapSequence,
    1,
  );
  assert.equal(
    retained.sendDiagnostic.firstFailure.failure.oldestUnfinishedAgeMs,
    25,
  );
  assert.equal(retained.sendDiagnostic.summary.windowTruncatedRecords, 0);
  assert.equal(retained.sendDiagnostic.summary.truncatedRecords, 0);

  let attempts = 0;
  const failed = reportCloudLiveTranslateDiagnostic(event, () => {
    attempts += 1;
    throw new Error('PRIVATE_LOG_SINK_FAILURE');
  });
  assert.equal(attempts, 1);
  assert.deepEqual(failed, {
    status: 'sink_threw',
    generatedRows: 1,
    sinkReturnedRows: 0,
    discardedWindows: 1,
    railwayStored: null,
  });
});

test('send observations expose bounded progress and trust the authenticated track, not callback text', () => {
  const event = {
    role: 'local',
    stage: 'send_written',
    at: 2400,
    eventType: 'input_audio_buffer.append',
    sendSequence: 9,
    observedSequence: 21,
    audioBytes: 640,
    acceptedAudioBytes: 6400,
    writtenAudioBytes: 5760,
    pendingAudioBytes: 640,
    pendingWireBytes: 900,
    readyState: 1,
    bufferedBytes: 1024,
    queuedDurationMs: 120,
    callbackDurationMs: 100,
    text: 'private-content',
    Authorization: 'private-auth',
    wire: 'private-audio',
  };
  const safe = projectLiveTranslateSendObservation(event, 'remote')!;
  assert.equal(safe.role, 'remote');
  assert.equal(safe.basis, 'transport_write_completed_not_received');
  assert.equal(safe.sendEventType, 'input_audio_buffer.append');
  for (const key of [
    'sendSequence',
    'observedSequence',
    'audioBytes',
    'acceptedAudioBytes',
    'writtenAudioBytes',
    'pendingAudioBytes',
    'pendingWireBytes',
    'readyState',
    'bufferedBytes',
    'queuedDurationMs',
    'callbackDurationMs',
  ] as const)
    assert.equal(safe[key], event[key]);
  const logged = sanitizeLiveTranslatePhoneDiagnostic(safe)!;
  assert.equal(logged.writtenAudioBytes, 5760);
  assert.equal(JSON.stringify(logged).includes('private-'), false);
  for (const sendReason of [
    'transport_not_open',
    'transport_buffer_limit',
    'pending_input_limit',
    'oldest_send_timeout',
    'write_callback_error',
    'write_throw',
  ]) {
    const failed = projectLiveTranslateProtocolFailure({
      ...protocolFailure,
      code: 'LIVETRANSLATE_SEND_UNAVAILABLE',
      sendReason,
      readyState: 3,
      bufferedBytes: 1048577,
      pendingAudioBytes: 64000,
      sendSequence: 10,
      callbackDurationMs: 2000,
    })!;
    assert.equal(failed.sendReason, sendReason);
    assert.equal(
      sanitizeLiveTranslatePhoneDiagnostic(failed)?.bufferedBytes,
      1048577,
    );
  }
});

test('new transport and response summaries reject arbitrary values and getters at both boundaries', () => {
  let getters = 0;
  const event = {
    stage: 'send_failed',
    at: 2400,
    eventType: 'private-event',
    sendReason: 'private-reason',
    closeCode: 1006,
    readyState: 77,
    bufferedBytes: -1,
    callbackDurationMs: Infinity,
  };
  Object.defineProperty(event, 'pendingAudioBytes', {
    get() {
      getters += 1;
      throw new Error('DO_NOT_READ');
    },
  });
  const safe = projectLiveTranslateSendObservation(event, 'local')!;
  assert.equal(safe.closeCode, 1006);
  for (const key of [
    'sendEventType',
    'sendReason',
    'readyState',
    'bufferedBytes',
    'callbackDurationMs',
    'pendingAudioBytes',
  ])
    assert.equal((safe as unknown as Record<string, unknown>)[key], undefined);
  assert.equal(getters, 0);
  assert.equal(
    projectLiveTranslateSendObservation(
      { ...event, stage: 'private-stage' },
      'local',
    ),
    undefined,
  );
  const completed = sanitizeLiveTranslatePhoneDiagnostic({
    role: 'local',
    stage: 'response_completed',
    at: 2400,
    outputItemCount: 0,
    outputTextCharacters: 0,
    outputAudioSeen: false,
    inputAcceptedAudioMs: 21000,
    inputWrittenAudioMs: 20000,
    transcript: 'private-content',
  })!;
  assert.equal(completed.outputItemCount, 0);
  assert.equal(completed.outputAudioSeen, false);
  assert.equal(completed.inputAcceptedAudioMs, 21000);
  assert.equal(completed.inputWrittenAudioMs, 20000);
  assert.equal('transcript' in completed, false);
});

test('fatal diagnostics preserve all fixed conflict branches and local receive ordinal', () => {
  for (const conflictKind of LIVE_TRANSLATE_ITEM_CONFLICT_KINDS) {
    const event = { ...protocolFailure, conflictKind };
    const projected = projectLiveTranslateProtocolFailure(event);
    assert.equal(projected?.conflictKind, conflictKind);
    assert.equal(projected?.receiveSequence, 21);
    assert.equal(projected?.fatal, true);
    assert.equal(projected?.code, 'LIVETRANSLATE_ITEM_CONFLICT');
    const logged = sanitizeLiveTranslatePhoneDiagnostic(projected);
    assert.equal(logged?.conflictKind, conflictKind);
    assert.equal(logged?.eventType, 'conversation.item.created');
    assert.equal(logged?.validationPath, 'item.id');
    assert.equal(logged?.expected, 'consistent_item_binding');
    assert.equal(logged?.actualType, 'string');
  }
});

test('protocol field enums survive both metadata boundaries without accepting arbitrary values', () => {
  for (const [fieldName, values] of [
    ['eventType', [...LIVE_TRANSLATE_PROTOCOL_EVENT_TYPES, 'unknown', null]],
    ['validationPath', LIVE_TRANSLATE_PROTOCOL_DIAGNOSTIC_PATHS],
    ['expected', LIVE_TRANSLATE_PROTOCOL_DIAGNOSTIC_EXPECTATIONS],
    ['actualType', LIVE_TRANSLATE_PROTOCOL_VALUE_TYPES],
  ] as const) {
    for (const value of values) {
      const projected = projectLiveTranslateProtocolFailure({
        ...protocolFailure,
        [fieldName]: value,
      });
      assert.equal(projected?.[fieldName], value);
      assert.equal(
        sanitizeLiveTranslatePhoneDiagnostic(projected)?.[fieldName],
        value,
      );
    }
  }
  const hostile = {
    ...protocolFailure,
    conflictKind: 'supplier-private-text',
    eventType: '+12025550100',
    validationPath: 'secret-path',
    expected: 'secret-token',
    actualType: 'private-speech',
    sourceId: 'private-source',
    responseId: 'private-response',
    text: 'private-content',
    Authorization: 'private-auth',
    receiveSequence: 0,
  };
  assert.deepEqual(projectLiveTranslateProtocolFailure(hostile), {
    role: 'local',
    stage: 'protocol_failure',
    at: 2400,
    fatal: true,
    code: 'LIVETRANSLATE_ITEM_CONFLICT',
  });
  for (const sequence of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(
      projectLiveTranslateProtocolFailure({
        ...protocolFailure,
        receiveSequence: sequence,
      })?.receiveSequence,
      undefined,
    );
  }
  assert.equal(
    projectLiveTranslateProtocolFailure({
      ...protocolFailure,
      code: 'private-code',
    }),
    undefined,
  );
});

test('first and second protocol projections never invoke getters, including fatal and code', () => {
  let getters = 0;
  const hostile = { ...protocolFailure };
  for (const name of [
    'eventType',
    'validationPath',
    'expected',
    'actualType',
    'conflictKind',
    'receiveSequence',
  ])
    Object.defineProperty(hostile, name, {
      get() {
        getters += 1;
        throw new Error('DO_NOT_READ');
      },
      configurable: true,
    });
  assert.deepEqual(projectLiveTranslateProtocolFailure(hostile), {
    role: 'local',
    stage: 'protocol_failure',
    at: 2400,
    fatal: true,
    code: 'LIVETRANSLATE_ITEM_CONFLICT',
  });
  assert.deepEqual(sanitizeLiveTranslatePhoneDiagnostic(hostile), {
    role: 'local',
    stage: 'protocol_failure',
    at: 2400,
    fatal: true,
    code: 'LIVETRANSLATE_ITEM_CONFLICT',
  });
  for (const name of ['fatal', 'code']) {
    const event = { ...protocolFailure };
    Object.defineProperty(event, name, {
      get() {
        getters += 1;
        throw new Error('DO_NOT_READ');
      },
    });
    assert.equal(projectLiveTranslateProtocolFailure(event), undefined);
    assert.equal(projectLiveTranslateProtocolWarning(event), undefined);
  }
  assert.equal(getters, 0);
});

test('only fixed error and warning codes cross their corresponding callback boundary', () => {
  for (const code of [
    ...LIVE_TRANSLATE_FAILURE_CODES,
    ...LIVE_TRANSLATE_PHONE_FAILURE_CODES,
  ]) {
    assert.equal(
      projectLiveTranslateProtocolFailure({ ...protocolFailure, code })?.code,
      code,
    );
    assert.equal(
      projectLiveTranslateProtocolWarning({
        ...protocolFailure,
        fatal: false,
        code,
      })?.code,
      (LIVE_TRANSLATE_PHONE_WARNING_CODES as readonly string[]).includes(code)
        ? code
        : undefined,
    );
  }
  for (const code of LIVE_TRANSLATE_PHONE_WARNING_CODES) {
    assert.equal(
      projectLiveTranslateProtocolWarning({
        ...protocolFailure,
        fatal: false,
        code,
      })?.code,
      code,
    );
    if (!(LIVE_TRANSLATE_FAILURE_CODES as readonly string[]).includes(code)) {
      assert.equal(
        projectLiveTranslateProtocolFailure({ ...protocolFailure, code }),
        undefined,
      );
      assert.equal(
        sanitizeLiveTranslatePhoneDiagnostic({ ...protocolFailure, code })
          ?.code,
        undefined,
      );
    }
  }
});

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
