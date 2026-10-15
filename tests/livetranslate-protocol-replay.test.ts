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

after(() => {
  const outputPath = process.env.LIVETRANSLATE_PROTOCOL_REPLAY_REPORT;
  if (outputPath) writeFileSync(outputPath, `${JSON.stringify({
    schemaVersion: 1,
    provenance: contract.provenance,
    capturedProviderPayload: false,
    timingBasis: contract.timingBasis,
    fixturePath,
    scenarioCount: reports.length,
    scenarios: reports,
  }, null, 2)}\n`, { flag: 'wx' });
});
