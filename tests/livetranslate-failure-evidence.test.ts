import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { describeLiveTranslateProtocolEvidence } from '../src/experiments/livetranslate-protocol-evidence';
import type {
  LiveTranslateProtocolDiagnostic,
  LiveTranslateProtocolEvent,
} from '../src/experiments/livetranslate-types';

const actual = JSON.parse(
  readFileSync(
    new URL(
      './fixtures/livetranslate-protocol/actual-failure-summary.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

test('retained actual failure summary cannot be upgraded into a real event replay or an Aiden rejection', () => {
  assert.equal(actual.recordKind, 'actual_execution_summary_not_event_payload');
  assert.equal(actual.realCapturePayloadAvailable, false);
  assert.equal(actual.replayableActualEventCapture, false);
  const evidence = describeLiveTranslateProtocolEvidence(actual);
  assert.equal(
    evidence.classification,
    'unclassified_local_event_failure_missing_payload',
  );
  assert.equal(evidence.specificValidationCaptured, false);
  assert.equal(evidence.exactValidation, null);
  assert.equal(evidence.actualModelAndVoice, 'unknown');
  assert.equal(evidence.remoteAuthentication, 'not_established');
  assert.equal(evidence.timeline.recordingSend, 'not_started');
  for (const key of [
    'connectionEstablished',
    'firstFrame',
    'sessionUpdateSubmitted',
    'configurationAccepted',
    'failure',
    'closeRequested',
    'transportClosed',
  ] as const) {
    assert.equal(evidence.timeline[key].status, 'not_captured');
    assert.equal(evidence.timeline[key].at, null);
  }
  assert.equal(actual.costs.knownSubtotalCny, null);
  assert.equal(actual.costs.actualPlatformBilledCny, null);
});

// Everything below is explicitly synthetic; it is not captured provider traffic.
const event = (
  stage: LiveTranslateProtocolEvent['stage'],
): LiveTranslateProtocolEvent => ({
  role: 'local',
  at: 12,
  stage,
  eventType: null,
  eventIdPresent: false,
  schema: {},
  unknownKeyCount: 0,
});
const diagnostic: LiveTranslateProtocolDiagnostic = {
  role: 'local',
  at: 20,
  stage: 'configuring',
  eventType: 'session.updated',
  validationPath: 'session.audio.output.voice',
  expected: 'Aiden',
  actualType: 'string',
  fatal: true,
  code: 'LIVETRANSLATE_CONFIGURATION_REJECTED',
};

test('synthetic evidence separates protocol progress, complete output, acoustic acceptance and missing usage', () => {
  const base = {
    status: 'completed' as const,
    protocolEvents: [
      event('configuration_accepted'),
      {
        ...event('server_frame'),
        eventType: 'session.finished' as const,
      },
    ],
    clips: [{ sendCompletedAt: 10 }],
    audio: [{ responseDoneAt: 20 }],
    counters: { inputBytesSent: 3200, audioBytesSaved: 4800 },
    usage: [],
  };
  const complete = describeLiveTranslateProtocolEvidence(base);
  assert.equal(complete.outcomes.protocol, 'finished_observed');
  assert.equal(complete.outcomes.englishAudio, 'complete_output_observed');
  assert.equal(complete.outcomes.maleVoiceAcceptance, 'not_evaluated');
  assert.equal(complete.outcomes.acousticVoice, 'unknown_not_measured');
  assert.equal(complete.outcomes.usage, 'unknown_not_returned');
  assert.equal(
    describeLiveTranslateProtocolEvidence({
      ...base,
      usage: [{ basis: 'unknown' }],
    }).outcomes.usage,
    'unknown_not_returned',
  );
  const partial = describeLiveTranslateProtocolEvidence({
    ...base,
    status: 'cancelled',
    errorCode: 'LIVETRANSLATE_AUDITION_CANCELLED',
  });
  assert.equal(partial.outcomes.protocol, 'stopped_with_error');
  assert.equal(partial.outcomes.englishAudio, 'partial_output_preserved');
  assert.equal(
    describeLiveTranslateProtocolEvidence({
      ...base,
      counters: { inputBytesSent: 3200, audioBytesSaved: 0 },
      audio: [],
    }).outcomes.englishAudio,
    'no_audio_observed',
  );
});

test('synthetic transport open is not authentication and a typed configuration rejection preserves the exact path', () => {
  const evidence = describeLiveTranslateProtocolEvidence({
    startedAt: 2,
    endedAt: 21,
    errorCode: diagnostic.code,
    protocolEvents: [event('transport_open')],
    protocolDiagnostics: [diagnostic],
    confirmedSessions: [],
    counters: { inputBytesSent: 0 },
  });
  assert.equal(evidence.timeline.connectionEstablished.sinceStartMs, 10);
  assert.equal(evidence.remoteAuthentication, 'not_established');
  assert.equal(
    evidence.classification,
    'session_configuration_or_identity_rejected',
  );
  assert.equal(
    evidence.exactValidation?.validationPath,
    'session.audio.output.voice',
  );
  assert.equal(evidence.exactValidation?.expected, 'Aiden');
  assert.equal(evidence.exactValidation?.actualType, 'string');
  assert.equal(evidence.timeline.transportClosed.status, 'not_captured');
});

test('synthetic HTTP denial, proxy authentication and explicit supplier error remain separate', () => {
  const base = { counters: { inputBytesSent: 0 }, confirmedSessions: [] };
  assert.equal(
    describeLiveTranslateProtocolEvidence({ ...base, httpStatusCode: 403 })
      .classification,
    'http_access_rejected_origin_unconfirmed',
  );
  assert.equal(
    describeLiveTranslateProtocolEvidence({ ...base, httpStatusCode: 407 })
      .classification,
    'proxy_authentication_rejected',
  );
  const supplier = describeLiveTranslateProtocolEvidence({
    ...base,
    protocolEvents: [event('provider_error')],
  });
  assert.equal(supplier.classification, 'explicit_supplier_or_gateway_error');
  assert.equal(supplier.actualModelAndVoice, 'unknown');
  const voice = describeLiveTranslateProtocolEvidence({
    ...base,
    protocolEvents: [
      {
        ...event('provider_error'),
        providerError: {
          shape: 'nested_error',
          code: 'invalid_value',
          type: 'invalid_request_error',
          parameter: 'session.voice',
        },
      },
    ],
  });
  assert.equal(voice.classification, 'supplier_voice_parameter_rejected');
  assert.equal(voice.remoteAuthentication, 'not_established');
  const transport = describeLiveTranslateProtocolEvidence({
    ...base,
    errorCode: 'LIVETRANSLATE_CONNECTION_FAILED',
    protocolDiagnostics: [
      {
        ...diagnostic,
        stage: 'connecting',
        eventType: null,
        validationPath: 'frame',
        expected: 'error_free_transport',
        actualType: 'missing',
      },
    ],
  });
  assert.equal(
    transport.classification,
    'transport_failure_origin_unconfirmed',
  );
});
