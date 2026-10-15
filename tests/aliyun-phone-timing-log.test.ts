import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diagnosticLogRecord } from '../src/solo/diagnostic-log';
import { reportCloudPlanBTiming } from '../src/solo/cloud-service';

const pipelineId = 'aa112233-4455-4667-8899-aabbccddeeff';

test('Plan B runtime timing records contain only local correlation, enums and finite timestamps', () => {
  const record = diagnosticLogRecord(
    'translation-timing',
    {
      pipelineId,
      sessionId: 'private-internal-session',
      utteranceId: 'planb_local_caption:source_2:2',
      role: 'local',
      sourceRevision: 3,
      sessionEpoch: 1,
      stage: 'playback_drained',
      at: 1700000000123,
      basis: 'transport_mark_observed',
      actualPlaybackStartAt: 123,
      rawModelText: 'private spoken words',
      text: 'private transcript',
      apiKey: 'private credential',
      phone: '+12125550123',
    },
    'log-wall-time',
  );
  assert.deepEqual(record, {
    at: 'log-wall-time',
    event: 'translation-timing',
    role: 'local',
    pipelineId,
    utteranceId: 'planb_local_caption:source_2:2',
    sourceRevision: 3,
    sessionEpoch: 1,
    stage: 'playback_drained',
    observedAtEpochMs: 1700000000123,
    basis: 'transport_mark_observed',
    actualPlaybackStartAt: null,
  });
});

test('untrusted provider labels or phone-like IDs cannot be serialized as timing', () => {
  const record = diagnosticLogRecord(
    'translation-timing',
    {
      pipelineId: 'API-key-or-call-SID',
      utteranceId: 'private recognized words',
      role: 'private-person',
      stage: 'private raw error',
      basis: 'secret',
      at: Infinity,
      sourceRevision: NaN,
      sessionEpoch: -1,
    },
    'log-wall-time',
  );
  assert.deepEqual(record, {
    at: 'log-wall-time',
    event: 'translation-timing',
    actualPlaybackStartAt: null,
  });
});

test('selected cloud timing logger ignores transcript events and never logs their contents', (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => lines.push(line));
  reportCloudPlanBTiming({
    event: 'transcript',
    data: { text: 'not a timing record' },
  });
  reportCloudPlanBTiming({
    event: 'translation-timing',
    data: {
      role: 'remote',
      utteranceId: 'planb_remote_source_2',
      stage: 'translation_complete',
      basis: 'application_observed',
      at: 12,
      text: 'private payload',
      apiKey: 'secret',
    },
  });
  assert.equal(lines.length, 1);
  const actual = JSON.parse(lines[0]);
  assert.equal(actual.event, 'translation-timing');
  assert.equal(actual.observedAtEpochMs, 12);
  assert.equal(actual.actualPlaybackStartAt, null);
  assert.ok(!lines[0].includes('private payload'));
  assert.ok(!lines[0].includes('secret'));
});

test('a runtime diagnostic sink failure cannot escape into call cleanup', (t) => {
  t.mock.method(console, 'log', () => {
    throw new Error('offline sink failure');
  });
  assert.doesNotThrow(() =>
    reportCloudPlanBTiming({
      event: 'translation-timing',
      data: {
        role: 'local',
        stage: 'playback_start_unavailable',
        at: 1,
        basis: 'unavailable',
      },
    }),
  );
});
