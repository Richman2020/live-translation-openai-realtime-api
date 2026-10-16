import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const raw = readFileSync(
  new URL(
    './fixtures/livetranslate-protocol/actual-call-6e0d0fba-metadata.redacted.json',
    import.meta.url,
  ),
);
const fixture = JSON.parse(raw.toString('utf8'));
const expectedHash =
  '8b796b13295dacbd2dd0c9e4c5e959f57f32b1f7290e6794afa04ef41e600370';
type Row = {
  role: string;
  stage: string;
  at: number;
  sourceSequence?: number;
  responseSequence?: number;
  actualPlaybackStartAt?: null;
};
const lifecycle = fixture.responseLifecycle as Row[];

test('actual application metadata projection is immutable, self-contained and contains only safe selected fields', () => {
  assert.equal(createHash('sha256').update(raw).digest('hex'), expectedHash);
  assert.equal(
    fixture.provenance.evidenceKind,
    'actual_application_log_metadata_projection_not_provider_frame_or_audio_replay',
  );
  assert.equal(
    fixture.provenance.callId,
    '6e0d0fba-85b4-4354-a26d-db12750716fc',
  );
  assert.equal(
    fixture.provenance.baseline,
    'e31ceb45d515c6fd93c8baff2761aec7949f18a8',
  );
  assert.equal(fixture.provenance.clock, 'application_epoch_ms');
  assert.deepEqual(
    fixture.provenance.sources.map((source: { rows: number }) => source.rows),
    [1704, 10, 30],
  );
  for (const source of fixture.provenance.sources)
    assert.match(source.sha256, /^[a-f0-9]{64}$/u);
  const allowed = new Set([
    'role',
    'stage',
    'at',
    'sourceSequence',
    'responseSequence',
    'sequence',
    'actualPlaybackStartAt',
    'fatal',
    'eventType',
    'validationPath',
    'expected',
    'actualType',
    'code',
    'receiveSequence',
    'reason',
    'layer',
    'elapsedMs',
    'providerAudioMs',
    'inputAudioMs',
    'differenceMs',
    'outstandingAudioMs',
    'queuedBytes',
  ]);
  for (const row of [
    ...lifecycle,
    ...fixture.sourceInputOffsets,
    ...fixture.criticalEvents,
    ...fixture.peakQueueObservations,
  ]) {
    for (const key of Object.keys(row))
      assert.ok(allowed.has(key), `unexpected log payload field: ${key}`);
    assert.ok(Number.isSafeInteger(row.at));
    assert.ok(['local', 'remote', 'unknown'].includes(row.role));
  }
});

test('actual response lifecycle has six local and four remote responses, below the unrelated 257 boundary', () => {
  const created = lifecycle.filter((row) => row.stage === 'response_created');
  const completed = lifecycle.filter(
    (row) => row.stage === 'response_completed',
  );
  assert.equal(created.length, 10);
  assert.equal(created.filter((row) => row.role === 'local').length, 6);
  assert.equal(created.filter((row) => row.role === 'remote').length, 4);
  assert.equal(completed.length, 10);
  assert.deepEqual(
    created.map((row) => row.responseSequence),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.ok(created.length < 257);
  assert.ok(
    !fixture.criticalEvents.some((row: { code?: string }) =>
      row.code?.includes('CAPACITY'),
    ),
  );
});

test('actual first transport fatal precedes failed state by three ms and call-end request by 61903 ms', () => {
  const replay = [...fixture.criticalEvents].sort(
    (left, right) => left.at - right.at,
  );
  assert.deepEqual(
    replay.map((row) => row.stage),
    ['protocol_failure', 'failed', 'call_termination'],
  );
  const [fatal, failed, ended] = replay;
  assert.equal(fatal.role, 'remote');
  assert.equal(fatal.code, 'LIVETRANSLATE_SEND_UNAVAILABLE');
  assert.equal(fatal.validationPath, 'transport.send');
  assert.equal(fatal.expected, 'send_available');
  assert.equal(fatal.actualType, 'number');
  assert.equal(fatal.receiveSequence, 96);
  assert.equal(new Date(fatal.at).toISOString(), '2026-10-16T03:26:27.798Z');
  assert.equal(failed.at - fatal.at, 3);
  assert.equal(ended.at - fatal.at, 61903);
  assert.equal(ended.reason, 'CALL_END_REQUESTED');
  assert.equal(
    ended.role,
    'unknown',
    'a later request is not proof of who hung up',
  );
  assert.ok(
    fixture.unknowns.includes('websocket_ready_state_at_failure_not_captured'),
  );
  assert.ok(
    fixture.unknowns.includes(
      'websocket_buffered_bytes_at_failure_not_captured',
    ),
  );
  assert.equal(Object.hasOwn(fatal, 'readyState'), false);
  assert.equal(Object.hasOwn(fatal, 'bufferedAmount'), false);
});

test('all five local first-audio responses drained; response 10 content and real playback remain unknown', () => {
  const audio = lifecycle.filter(
    (row) => row.stage === 'audio_first_sample' && row.role === 'local',
  );
  const drained = lifecycle.filter(
    (row) => row.stage === 'playback_drained' && row.role === 'local',
  );
  assert.deepEqual(
    audio.map((row) => row.responseSequence),
    [1, 2, 4, 6, 8],
  );
  assert.deepEqual(
    drained.map((row) => row.responseSequence),
    [1, 2, 4, 6, 8],
  );
  const last = lifecycle.filter((row) => row.responseSequence === 10);
  assert.deepEqual(
    last.map((row) => row.stage),
    ['response_created', 'response_completed'],
  );
  assert.equal(last[1].at - last[0].at, 1580);
  assert.ok(
    fixture.unknowns.includes('response_10_output_content_not_captured'),
  );
  assert.ok(lifecycle.every((row) => row.actualPlaybackStartAt === null));
  assert.equal(
    Math.max(
      ...fixture.peakQueueObservations.map(
        (row: { outstandingAudioMs: number }) => row.outstandingAudioMs,
      ),
    ),
    2800,
  );
  assert.equal(
    Math.max(
      ...fixture.peakQueueObservations.map(
        (row: { queuedBytes: number }) => row.queuedBytes,
      ),
    ),
    5760,
  );
});

test('actual remote input-counter offset differences are reproduced as arithmetic, not declared audio latency', () => {
  const remote = fixture.sourceInputOffsets.filter(
    (row: { role: string }) => row.role === 'remote',
  );
  const local = fixture.sourceInputOffsets.filter(
    (row: { role: string }) => row.role === 'local',
  );
  assert.deepEqual(
    remote.map((row: { differenceMs: number }) => row.differenceMs),
    [20460, 21380, 21060, 20020],
  );
  for (const row of fixture.sourceInputOffsets)
    assert.equal(row.inputAudioMs - row.providerAudioMs, row.differenceMs);
  assert.equal(
    Math.min(...local.map((row: { differenceMs: number }) => row.differenceMs)),
    1260,
  );
  assert.equal(
    Math.max(...local.map((row: { differenceMs: number }) => row.differenceMs)),
    1820,
  );
  assert.ok(
    fixture.unknowns.includes(
      'acoustic_order_and_input_track_echo_not_confirmed',
    ),
  );
  assert.ok(fixture.unknowns.includes('provider_frames_not_captured'));
});
