import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import WebSocket from 'ws';

import { createLiveTranslateClient } from '../src/experiments/livetranslate-client';
import type {
  LiveTranslateAudioMetadata,
  LiveTranslateProtocolDiagnostic,
  LiveTranslateProtocolEvent,
  LiveTranslateSession,
} from '../src/experiments/livetranslate-types';

const fixturePath = fileURLToPath(new URL(
  '../fixtures/livetranslate-protocol/synthetic-official-contract.json',
  import.meta.url,
));
const contract = JSON.parse(readFileSync(fixturePath, 'utf8'));
const reports: Record<string, unknown>[] = [];

/** A manually constructed peer. It cannot create a network connection. */
class ReplaySocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;

  bufferedAmount = 0;

  sent: any[] = [];

  constructor(readonly autoEmitClose: boolean) { super(); }

  send(raw: string, callback?: (error?: Error) => void) {
    this.sent.push(JSON.parse(raw));
    callback?.();
  }

  close() {
    if (this.autoEmitClose) {
      this.readyState = WebSocket.CLOSED;
      this.emit('close', 1000, Buffer.from('SYNTHETIC_PRIVATE_CLOSE_CANARY'));
    }
  }

  terminate() {
    if (this.autoEmitClose) {
      this.readyState = WebSocket.CLOSED;
      this.emit('close', 1006, Buffer.from('SYNTHETIC_PRIVATE_CLOSE_CANARY'));
    }
  }
}

for (const scenario of contract.scenarios) {
  test(`synthetic official-contract replay: ${scenario.id}`, async () => {
    const socket = new ReplaySocket(scenario.autoEmitClose !== false);
    const events: LiveTranslateProtocolEvent[] = [];
    const diagnostics: LiveTranslateProtocolDiagnostic[] = [];
    const faults: string[] = [];
    const audio: LiveTranslateAudioMetadata[] = [];
    let fakeClockMs = 0;
    let constructions = 0;
    let ready: LiveTranslateSession | undefined;
    let finishResolved = false;
    let beforeReadyProbes = 0;
    const client = createLiveTranslateClient({
      enabled: true,
      role: 'local',
      workspaceId: 'offline-workspace',
      apiKey: 'SYNTHETIC_UNUSED_CREDENTIAL',
      now: () => fakeClockMs,
      createWebSocket(url) {
        constructions += 1;
        assert.equal(url,
          'wss://offline-workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime');
        return socket as unknown as WebSocket;
      },
      onProtocolEvent: (event) => events.push(event),
      onProtocolDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      onError: (code) => faults.push(code),
      onAudio: (_pcm, metadata) => audio.push(metadata),
    });
    client.ready.then((session) => { ready = session; }, () => {});
    for (const action of scenario.actions) {
      fakeClockMs += 10;
      if (action.kind === 'open') socket.emit('open');
      else if (action.kind === 'receive')
        socket.emit('message', Buffer.from(JSON.stringify(action.event)), false);
      else if (action.kind === 'raw')
        socket.emit('message', Buffer.from(action.raw), false);
      else if (action.kind === 'binary')
        socket.emit('message', Buffer.from('{}'), true);
      else if (action.kind === 'oversize')
        socket.emit('message', Buffer.alloc(1024 * 1024 + 1, 32), false);
      else if (action.kind === 'invalidUtf8')
        socket.emit('message', Buffer.from([0xc3, 0x28]), false);
      else if (action.kind === 'append') client.append(Buffer.alloc(640));
      else if (action.kind === 'finish')
        client.finish().then(() => { finishResolved = true; }, () => {});
      else if (action.kind === 'probeBeforeReady') {
        assert.throws(() => client.append(Buffer.alloc(640)), /NOT_READY/);
        beforeReadyProbes += 1;
      } else if (action.kind === 'close') {
        socket.readyState = WebSocket.CLOSED;
        socket.emit('close', action.code);
      } else assert.fail('Unknown synthetic replay action');
      // eslint-disable-next-line no-await-in-loop -- Flush this fake frame before delivering the next one.
      await Promise.resolve();
      if (faults.length) break;
    }
    const appendCount = socket.sent.filter((event) =>
      event.type === 'input_audio_buffer.append').length;
    const close = events.find((event) => event.stage === 'transport_close');
    const summary: Record<string, unknown> = {
      scenario: scenario.id,
      source: scenario.source,
      evidenceBasis: scenario.evidenceBasis,
      mutation: scenario.mutation,
      timingBasis: 'simulation_fake_clock_ms_not_model_latency',
      constructions,
      ready: Boolean(ready),
      appendCount,
      beforeReadyProbes,
      finishResolved,
      closeRequested: events.some((event) => event.stage === 'transport_close_requested'),
      closeObserved: Boolean(close),
      closeCode: close?.closeCode ?? null,
      fatalCode: faults[0] ?? null,
      fatalPath: diagnostics[0]?.validationPath ?? null,
      expected: scenario.expected,
      serverFrameOrder: events.filter((event) => event.stage === 'server_frame')
        .map((event) => event.eventType),
      eventTimeline: events.map(({ at, ...event }) => ({ fakeClockMs: at, ...event })),
      diagnostics: diagnostics.map(({ at, ...diagnostic }) => ({ fakeClockMs: at, ...diagnostic })),
      audioEventIdBases: [...new Set(audio.map((item) => item.eventIdBasis))],
      pairedAudioObservations: audio.filter((item) => item.pairing === 'explicit').length,
      unpairedAudioObservations: audio.filter((item) => item.pairing === 'unpaired').length,
      assertionsPassed: false,
    };
    reports.push(summary);
    assert.equal(constructions, 1);
    assert.equal(Boolean(ready), scenario.expected.ready);
    assert.equal(appendCount, scenario.expected.appendCount);
    assert.equal(finishResolved, scenario.expected.finishResolved);
    assert.equal(faults[0] ?? null, scenario.expected.fatalCode);
    assert.equal(diagnostics[0]?.validationPath ?? null, scenario.expected.fatalPath);
    if (scenario.expected.actualType)
      assert.equal(diagnostics[0]?.actualType, scenario.expected.actualType);
    assert.equal(close?.closeCode ?? null, scenario.expected.closeCode);
    assert.equal(Boolean(close), scenario.expected.closeCode !== null);
    if (close) assert.equal((await client.transportClosed!).observed, true);
    const firstAppend = events.findIndex((event) =>
      event.stage === 'client_event_sent' && event.eventType === 'input_audio_buffer.append');
    const accepted = events.findIndex((event) => event.stage === 'configuration_accepted');
    assert(firstAppend === -1 || (accepted >= 0 && accepted < firstAppend));
    const safeEvidence = JSON.stringify({ events, diagnostics });
    for (const forbidden of [
      'SYNTHETIC_PRIVATE_CANARY', 'SYNTHETIC_NESTED_CANARY',
      'SYNTHETIC_PRIVATE_ERROR_CANARY', 'SYNTHETIC_PRIVATE_REQUEST',
      'SYNTHETIC_PRIVATE_CLOSE_CANARY', 'SYNTHETIC_UNUSED_CREDENTIAL',
      'SYNTHETIC_UNLISTED_CODE', 'private_extension', 'private_key',
      'Synthetic sample.', '人工样例。', 'AQACAAMA',
    ]) assert.equal(safeEvidence.includes(forbidden), false);
    if (scenario.id === 'nested-error-before-event-id-validation')
      assert.deepEqual(events.find((event) => event.stage === 'provider_error')?.providerError, {
        shape: 'nested_error', code: 'invalid_value', type: 'invalid_request_error', parameter: 'session.voice',
      });
    if (scenario.id === 'gateway-code-without-type')
      assert.equal(events.find((event) => event.stage === 'provider_error')?.providerError?.code, 'other');
    if (scenario.id === 'optional-event-id-receive-sequence') {
      assert.equal(ready?.configurationAcknowledgement.eventId, null);
      assert.equal(ready?.configurationAcknowledgement.receiveSequence, 2);
      assert.deepEqual(summary.audioEventIdBases, ['local_receive_sequence']);
    }
    summary.assertionsPassed = true;
    client.abort();
  });
}

for (const scenario of [
  { file: 'actual-aiden-top-level-nested-tina.redacted.json', voice: 'Aiden' as const,
    provenance: 'actual_provider_redacted_inbound', captured: true },
  { file: 'synthetic-andre-top-level-nested-tina.json', voice: 'Andre' as const,
    provenance: 'synthetic_mutation_of_actual_redacted_structure', captured: false },
]) {
  test(`voice gate replay (${scenario.provenance}): top-level ${scenario.voice} cannot override nested Tina`, async () => {
    const path = fileURLToPath(new URL(`./fixtures/livetranslate-protocol/${scenario.file}`, import.meta.url));
    const captured = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(captured.provenance, scenario.provenance);
    assert.equal(captured.capturedProviderPayload, scenario.captured);
    assert.equal(captured.originalOutboundCaptured, false);
    assert.equal(captured.providerFrames.length, 2);
    const socket = new ReplaySocket(true);
    const diagnostics: LiveTranslateProtocolDiagnostic[] = [];
    const events: LiveTranslateProtocolEvent[] = [];
    const configurations: any[] = [];
    const faults: string[] = [];
    let ready = false;
    let constructions = 0;
    const client = createLiveTranslateClient({
      enabled: true, role: 'local', voice: scenario.voice,
      workspaceId: 'offline-workspace', apiKey: 'SYNTHETIC_UNUSED_CREDENTIAL',
      allowMissingVoiceCloneEcho: true,
      createWebSocket() { constructions += 1; return socket as unknown as WebSocket; },
      onProtocolEvent: (event) => events.push(event),
      onProtocolDiagnostic: (event) => diagnostics.push(event),
      onSessionConfiguration: (event) => configurations.push(event),
      onError: (code) => faults.push(code),
    });
    client.ready.then(() => { ready = true; }, () => {});
    for (const frame of captured.providerFrames) {
      // These are replayed inbound messages. Any socket.send here is a new fake
      // application effect, never evidence of an uncaptured historical request.
      socket.emit('message', Buffer.from(JSON.stringify(frame.event)), frame.binary);
    }
    await assert.rejects(client.ready, /CONFIGURATION_REJECTED/);
    assert.equal(ready, false);
    assert.equal(constructions, 1);
    assert.equal(socket.sent.length, 1);
    assert.equal(socket.sent[0].type, 'session.update');
    assert.equal(socket.sent[0].session.voice, scenario.voice);
    assert.equal(socket.sent[0].session.enable_voice_clone, false);
    assert.equal(socket.sent.filter((event) => event.type === 'input_audio_buffer.append').length, 0);
    assert.equal(faults[0], 'LIVETRANSLATE_CONFIGURATION_REJECTED');
    assert.equal(diagnostics[0].validationPath, 'session.audio.output.voice');
    assert.equal(diagnostics[0].expected, scenario.voice);
    assert.equal(diagnostics[0].actualType, 'string');
    assert.equal(configurations[0].accepted, false);
    assert.equal(configurations[0].voice, 'Tina');
    reports.push({
      scenario: `top-${scenario.voice}-nested-Tina`, source: captured.provenance,
      fixturePath: path, capturedProviderPayload: captured.capturedProviderPayload,
      originalOutboundCaptured: false, replayOutboundEvidence: captured.replayOutboundEvidence,
      sourceFileSha256: captured.sourceFileSha256 ?? null,
      timingBasis: 'replay_order_only_not_new_model_measurement',
      ready, constructions, appendCount: 0,
      fatalCode: faults[0], fatalPath: diagnostics[0].validationPath,
      nestedVoiceObserved: configurations[0].voice,
      serverFrameOrder: events.filter((event) => event.stage === 'server_frame').map((event) => event.eventType),
      assertionsPassed: true,
    });
  });
}

after(() => {
  const outputPath = process.env.LIVETRANSLATE_PROTOCOL_REPLAY_REPORT;
  if (outputPath) writeFileSync(outputPath, `${JSON.stringify({
    schemaVersion: 1,
    provenance: 'offline_replay_mixed_sources',
    reportContainsProviderPayload: false,
    fixtureCaptureStatus: 'per_scenario_fixture_provenance',
    timingBasis: 'per_scenario_simulation_or_replay_order_not_new_model_latency',
    fixturePath,
    scenarioCount: reports.length,
    scenarios: reports,
  }, null, 2)}\n`, { flag: 'wx' });
});
