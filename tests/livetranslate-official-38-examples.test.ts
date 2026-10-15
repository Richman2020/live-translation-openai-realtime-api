import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import WebSocket from 'ws';

import { createLiveTranslateClient } from '../src/experiments/livetranslate-client';
import { describeLiveTranslateProtocolEvidence } from '../src/experiments/livetranslate-protocol-evidence';
import type {
  LiveTranslateProtocolDiagnostic, LiveTranslateProtocolEvent,
  LiveTranslateSessionConfiguration, LiveTranslateTiming,
} from '../src/experiments/livetranslate-types';

const document = JSON.parse(readFileSync(new URL(
  '../fixtures/livetranslate-protocol/official-38-document-examples.json', import.meta.url,
), 'utf8'));
const original = (type: string): any => {
  const example = document.examples.find((item: any) => item.event_type === type);
  assert.deepEqual(JSON.parse(example.raw_json), example.event);
  return structuredClone(example.event);
};

// Only the examples above are unmodified official-document excerpts. Each
// derivation below explicitly changes voice/clone or a named negative field;
// none of these objects is a captured provider frame or proof of Aiden support.
function derivedAck(confirmClone = false) {
  const event = original('session.updated');
  event.session.audio.output.voice = 'Aiden';
  if (confirmClone) event.session.enable_voice_clone = false;
  return event;
}

class OfflineSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: any[] = [];
  send(raw: string, callback?: (error?: Error) => void) {
    this.sent.push(JSON.parse(raw));
    callback?.();
  }
  terminate() { this.readyState = WebSocket.CLOSED; this.emit('close', 1006); }
  close() { this.readyState = WebSocket.CLOSED; this.emit('close', 1000); }
}
function peer() {
  const socket = new OfflineSocket();
  const events: LiveTranslateProtocolEvent[] = [];
  const diagnostics: LiveTranslateProtocolDiagnostic[] = [];
  const configurations: LiveTranslateSessionConfiguration[] = [];
  const timings: LiveTranslateTiming[] = [];
  const faults: string[] = [];
  const client = createLiveTranslateClient({
    enabled: true, role: 'local', workspaceId: 'offline-workspace',
    apiKey: 'SYNTHETIC_UNUSED_CREDENTIAL',
    createWebSocket: () => socket as unknown as WebSocket,
    onProtocolEvent: (event) => events.push(event),
    onProtocolDiagnostic: (item) => diagnostics.push(item),
    onSessionConfiguration: (item) => configurations.push(item),
    onTiming: (item) => timings.push(item),
    onError: (code) => faults.push(code),
  });
  const receive = (event: any) => socket.emit('message', Buffer.from(JSON.stringify(event)), false);
  // Synthetic predecessor: original ACK identity, distinct event id/type.
  const created = original('session.updated');
  created.event_id = 'synthetic_predecessor';
  created.type = 'session.created';
  socket.emit('open');
  receive(created);
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].type, 'session.update');
  assert.equal(socket.sent[0].session.voice, 'Aiden');
  assert.equal(socket.sent[0].session.enable_voice_clone, false);
  return { client, socket, receive, events, diagnostics, configurations, timings, faults };
}

test('complete unmodified official 3.8 ACK documents nested PCM, voice and translation paths, with no clone echo', () => {
  assert.equal(document.provenance, 'official_document_excerpt_not_provider_capture');
  assert.equal(document.new_network_requests, 0);
  const { session } = original('session.updated');
  assert.equal(session.model, 'qwen3.8-livetranslate-flash-realtime');
  assert.deepEqual(session.input_modalities, ['audio']);
  assert.deepEqual(session.output_modalities, ['text', 'audio']);
  assert.deepEqual(session.audio.input.format, { type: 'pcm', sample_rate: 16000 });
  assert.deepEqual(session.audio.output.format, { type: 'pcm', sample_rate: 24000 });
  assert.equal(session.audio.output.voice, 'Tina');
  assert.equal(session.translation.language, 'en');
  for (const key of ['voice', 'enable_voice_clone', 'input_audio_format', 'output_audio_format'])
    assert.equal(Object.hasOwn(session, key), false);
});

test('unmodified official Tina example stops at the Aiden gate, without claiming supplier rejection', async () => {
  const p = peer();
  p.receive(original('session.updated'));
  await assert.rejects(p.client.ready, /CONFIGURATION_REJECTED/);
  assert.equal(p.diagnostics[0].validationPath, 'session.audio.output.voice');
  assert.equal(p.configurations[0].voice, 'Tina');
  assert.equal(p.configurations[0].voiceCloneEnabled, null);
  assert.equal(p.configurations[0].accepted, false);
  assert.equal(p.events.some((event) => event.stage === 'provider_error'), false);
  assert.equal(p.socket.sent.some((event) => event.type === 'input_audio_buffer.append'), false);
});

test('derived Aiden ACK without clone echo stops as missing confirmation, never as enabled clone or supplier refusal', async () => {
  const p = peer();
  p.receive(derivedAck());
  await assert.rejects(p.client.ready, /LIVETRANSLATE_CLONE_CONFIRMATION_MISSING/);
  assert.throws(() => p.client.append(Buffer.alloc(640)), /CLONE_CONFIRMATION_MISSING/);
  assert.equal(p.diagnostics[0].stage, 'configuring');
  assert.equal(p.diagnostics[0].validationPath, 'session.enable_voice_clone');
  assert.equal(p.diagnostics[0].expected, 'false');
  assert.equal(p.diagnostics[0].actualType, 'missing');
  assert.equal(p.configurations[0].voiceCloneEnabled, null);
  assert.equal(p.configurations[0].accepted, false);
  assert.equal(p.events.some((event) => ['provider_error', 'configuration_accepted'].includes(event.stage)), false);
  assert.equal(p.socket.sent.some((event) => event.type === 'input_audio_buffer.append'), false);
  const evidence = describeLiveTranslateProtocolEvidence({
    errorCode: p.faults[0], protocolEvents: p.events, protocolDiagnostics: p.diagnostics,
    confirmedSessions: [], counters: { inputBytesSent: 0 },
  });
  assert.equal(evidence.classification, 'voice_clone_disabled_confirmation_missing');
  assert.equal(evidence.configurationStopReason, '缺少复刻关闭确认');
  assert.equal(evidence.voiceCloneDisabledConfirmation, 'unknown_missing_echo');
  assert.equal(evidence.actualModelAndVoice, 'unknown');
  assert.equal(evidence.remoteAuthentication, 'not_established');
});

test('derived Aiden plus explicit clone=false confirms nested paths; no legacy ACK voice is required', async () => {
  const p = peer();
  p.receive(derivedAck(true));
  const session = await p.client.ready;
  assert.equal(session.model, 'qwen3.8-livetranslate-flash-realtime');
  assert.equal(session.voice, 'Aiden');
  assert.equal(session.voiceCloneEnabled, false);
  assert.equal(session.targetLanguage, 'en');
  assert.equal(session.inputSampleRate, 16000);
  assert.equal(session.outputSampleRate, 24000);
  assert.equal(p.configurations[0].accepted, true);
  p.client.abort();
});

const negativePaths: [string, (event: any) => void][] = [
  ['session.model', (event) => { event.session.model = 'qwen3.5-livetranslate-flash-realtime'; }],
  ['session.audio.input.format.type', (event) => { event.session.audio.input.format.type = 'pcm16'; }],
  ['session.audio.input.format.sample_rate', (event) => { event.session.audio.input.format.sample_rate = 24000; }],
  ['session.audio.output.format.type', (event) => { event.session.audio.output.format.type = 'pcm16'; }],
  ['session.audio.output.format.sample_rate', (event) => { event.session.audio.output.format.sample_rate = 16000; }],
  ['session.audio.output.voice', (event) => { delete event.session.audio.output.voice; event.session.voice = 'Aiden'; }],
  ['session.translation.language', (event) => { delete event.session.translation.language; event.session.target_language = 'en'; }],
];
for (const [path, mutate] of negativePaths) {
  test(`derived official ACK negative case stops at actual path ${path}`, async () => {
    const p = peer();
    const ack = derivedAck(true);
    mutate(ack);
    p.receive(ack);
    await assert.rejects(p.client.ready, /CONFIGURATION_REJECTED/);
    assert.equal(p.diagnostics[0].validationPath, path);
    assert.equal(p.socket.sent.some((event) => event.type === 'input_audio_buffer.append'), false);
  });
}

test('explicit clone=true remains a contradictory configuration, distinct from missing confirmation', async () => {
  const p = peer();
  const ack = derivedAck(true);
  ack.session.enable_voice_clone = true;
  p.receive(ack);
  await assert.rejects(p.client.ready, /CONFIGURATION_REJECTED/);
  assert.equal(p.configurations[0].voiceCloneEnabled, true);
  assert.equal(p.diagnostics[0].actualType, 'boolean');
  assert.equal(p.socket.sent.some((event) => event.type === 'input_audio_buffer.append'), false);
});

test('derived common response.created with Aiden accepts output=[] without claiming response completion', async () => {
  const p = peer();
  p.receive(derivedAck(true));
  await p.client.ready;
  const created = original('response.created');
  assert.deepEqual(created.response.output, []);
  assert.equal(created.response.voice, 'Cherry');
  created.response.voice = 'Aiden'; // Explicit synthetic derivation, not an official Aiden example.
  p.receive(created);
  assert.deepEqual(p.faults, []);
  assert.equal(p.timings.filter((item) => item.stage === 'response_created').length, 1);
  let finished = false;
  p.client.finish().then(() => { finished = true; }, () => {});
  await Promise.resolve();
  assert.equal(finished, false);
  p.receive({ event_id: 'synthetic_session_finished', type: 'session.finished' });
  assert.equal(p.faults[0], 'LIVETRANSLATE_FINISH_INCOMPLETE');
  assert.equal(p.diagnostics[0].validationPath, 'response.status');
});

test('unmodified common response.created Cherry is rejected for voice, not its empty output', async () => {
  const p = peer();
  p.receive(derivedAck(true));
  await p.client.ready;
  p.receive(original('response.created'));
  assert.equal(p.faults[0], 'LIVETRANSLATE_CONFIGURATION_REJECTED');
  assert.equal(p.diagnostics[0].validationPath, 'response.voice');
});
