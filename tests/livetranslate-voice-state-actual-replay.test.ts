import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type WebSocket from 'ws';

import { createLiveTranslateClient } from '../src/experiments/livetranslate-client';
import type {
  LiveTranslateClientOptions,
  LiveTranslateProtocolDiagnostic,
  LiveTranslateProtocolEvent,
} from '../src/experiments/livetranslate-types';

const repository = fileURLToPath(new URL('../', import.meta.url));
const fixture = JSON.parse(readFileSync(new URL(
  './fixtures/livetranslate-protocol/actual-andre-session-tina-response-andre.redacted.json',
  import.meta.url,
), 'utf8'));
const base = '4c1ad02234481ee14c1e3a4093f3c09e51e4ebfb';
const reports: Record<string, unknown>[] = [];

/** In-memory transport only. No real WebSocket constructor or audio sender. */
class CapturedFrameTransport extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  send(raw: string, callback?: (error?: Error) => void) {
    this.sent.push(raw);
    callback?.();
  }
  close() { this.readyState = 3; this.emit('close', 1000); }
  terminate() { this.close(); }
}

async function replay(factory: typeof createLiveTranslateClient, version: string) {
  const socket = new CapturedFrameTransport();
  const events: LiveTranslateProtocolEvent[] = [];
  const diagnostics: LiveTranslateProtocolDiagnostic[] = [];
  const faults: string[] = [];
  const voiceEvidence: unknown[] = [];
  let responseCreatedTimingSeen = false;
  let replayFrameClock = 0;
  let ready: unknown;
  const options: LiveTranslateClientOptions = {
    enabled: true, role: 'local', voice: 'Andre', workspaceId: 'offline-workspace',
    apiKey: 'SYNTHETIC_UNUSED_CREDENTIAL', allowMissingVoiceCloneEcho: true,
    allowAndreTopLevelWithTinaOutput: true,
    now: () => replayFrameClock,
    createWebSocket: () => socket as unknown as WebSocket,
    onProtocolEvent: (event) => events.push(event),
    onProtocolDiagnostic: (event) => diagnostics.push(event),
    onError: (code) => faults.push(code),
    onVoiceEvidence: (event) => voiceEvidence.push(event),
    onTiming: (event) => { if (event.stage === 'response_created') responseCreatedTimingSeen = true; },
  };
  const client = factory(options);
  client.ready.then((value) => { ready = value; }, () => {});
  for (const frame of fixture.providerFrames) {
    replayFrameClock += 1;
    socket.emit('message', Buffer.from(JSON.stringify(frame.event)), frame.binary);
    // eslint-disable-next-line no-await-in-loop -- Preserve captured frame order.
    await Promise.resolve();
  }
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0], fixture.outboundSerializedUtf8);
  const snapshot = {
    version,
    provenance: fixture.provenance,
    sourceCandidate: fixture.sourceCandidate,
    sourceJournalSha256: fixture.sourceJournalSha256,
    originalInboundFrameCount: fixture.providerFrames.length,
    actualOutboundCaptured: true,
    replayOutboundIsNewFakeEffect: true,
    serializedUpdateMatchesHistoricalCapture: true,
    realModelConnections: 0,
    recordingAppendsDuringReplay: 0,
    historicalRecordingBytesSent: fixture.historicalApplicationPcmBytesSent,
    firstFatal: diagnostics.find((item) => item.fatal) ?? null,
    ready,
    responseCreatedAccepted: responseCreatedTimingSeen && faults.length === 0,
    responseCreatedTimingObserved: responseCreatedTimingSeen,
    faults: [...faults],
    voiceEvidence,
    completeAudioProven: false,
    acousticMaleVoice: 'unknown_no_audio_captured',
    usage: 'not_captured_unknown',
    timingBasis: 'offline_frame_order_not_real_model_latency',
    replayClock: 'frame_index_not_elapsed_duration',
  };
  reports.push(snapshot);
  client.abort();
  return snapshot;
}

test('actual five-frame capture reproduces the precise 4c1ad02 stop without creating a connection', async () => {
  assert.equal(fixture.sourceCandidate, base);
  assert.equal(fixture.providerFrames.length, 5);
  // Extract the exact old commit, retaining its runtime body. Only module paths
  // are rebased so the old module can run with the already present dependencies.
  const temporary = mkdtempSync(join(repository, '.offline-voice-legacy-'));
  try {
    const oldSource = execFileSync('git', ['show', `${base}:src/experiments/livetranslate-client.ts`],
      { cwd: repository, encoding: 'utf8' });
    const oldTypes = execFileSync('git', ['show', `${base}:src/experiments/livetranslate-types.ts`],
      { cwd: repository, encoding: 'utf8' });
    const helper = pathToFileURL(join(repository, 'src/solo/openai-websocket.ts')).href;
    const rebased = oldSource.replace("'../solo/openai-websocket'", `'${helper}'`)
      .replaceAll("'./livetranslate-types'", "'./livetranslate-types.ts'");
    writeFileSync(join(temporary, 'livetranslate-client.ts'), rebased);
    writeFileSync(join(temporary, 'livetranslate-types.ts'), oldTypes);
    const legacy = await import(pathToFileURL(join(temporary, 'livetranslate-client.ts')).href);
    const actual = await replay(legacy.createLiveTranslateClient, base);
    assert.equal(actual.firstFatal?.validationPath, 'response.voice');
    assert.equal(actual.firstFatal?.expected, 'Tina');
    assert.equal(actual.firstFatal?.code, 'LIVETRANSLATE_CONFIGURATION_REJECTED');
    assert.equal(actual.responseCreatedAccepted, false);
    Object.assign(actual, {
      legacyClientOriginalSha256: createHash('sha256').update(oldSource).digest('hex'),
      legacyClientModulePathsRebasedOnly: true,
    });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('actual same five-frame capture crosses the original stopping point after repair', async () => {
  const actual = await replay(createLiveTranslateClient, 'current_offline_candidate');
  assert.equal(actual.firstFatal, null);
  assert.equal(actual.responseCreatedAccepted, true);
  assert.equal(actual.completeAudioProven, false);
  const observed = actual.voiceEvidence as any[];
  assert.equal(observed.find((item) => item.eventType === 'session.created')?.sessionNestedEcho.value, 'Tina');
  const updated = observed.find((item) => item.eventType === 'session.updated');
  assert.equal(updated?.requestedVoice, 'Andre');
  assert.equal(updated?.sessionTopLevelEcho.value, 'Andre');
  assert.equal(updated?.sessionNestedEcho.value, 'Tina');
  const response = observed.find((item) => item.eventType === 'response.created');
  assert.equal(response?.responseEcho.value, 'Andre');
  assert.equal(response?.acceptedByVoicePolicy, true);
  assert.equal(response?.acousticVoice, 'unknown_not_measured');
});

after(() => {
  const output = process.env.LIVETRANSLATE_VOICE_ACTUAL_REPLAY_REPORT;
  if (output) writeFileSync(output, `${JSON.stringify({
    provenance: 'real_captured_events_replayed_offline_with_versions_separated',
    modelConnections: 0, completeAudioClaim: false, reports,
  }, null, 2)}\n`);
});
