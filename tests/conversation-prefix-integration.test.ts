import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import WebSocket from 'ws';
import { createConversationModel } from '../public/conversation-model.js';
import { ConversationEventAdapter } from '../src/solo/conversation-events';
import { createOutgoingPrefixClient, type OutgoingPrefixOptions } from '../src/solo/outgoing-prefix-client';
import { ContinuousTranslationBridge } from '../src/solo/continuous-translation-bridge';
import type { TranscriptEvent } from '../src/solo/translation-bridge';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  sent: any[] = [];
  open() { this.readyState = WebSocket.OPEN; this.emit('open'); }
  receive(event: object) { this.emit('message', Buffer.from(JSON.stringify(event))); }
  send(raw: string, callback?: () => void) { this.sent.push(JSON.parse(raw)); callback?.(); }
  terminate() { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  socket() { return this as unknown as WebSocket; }
}

test('prefix production callbacks show semantic source and English drafts, then replace them in place', async t => {
  const sockets: FakeSocket[] = [];
  const adapter = new ConversationEventAdapter('call-prefix', () => 100);
  const model = createConversationModel('call-prefix');
  const errors: string[] = [];
  const client = createOutgoingPrefixClient({
    apiKey: 'offline-fake', now: () => 100, onTranscript() {}, onCommit() {},
    onConversationTranscript(event) { const update = adapter.transcript(event); if (update) model.apply(update); },
    onError: code => errors.push(code),
    createWebSocket() { const socket = new FakeSocket(); sockets.push(socket); return socket.socket(); },
  });
  t.after(() => client.abort());
  const [asr, text] = sockets;
  asr.open(); text.open();
  asr.receive({ type: 'session.updated', session: { type: 'transcription', audio: { input: {
    format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: 'gpt-live-transcribe', languages: ['zh-cn'] }, turn_detection: null,
  } } } });
  text.receive({ type: 'session.updated', session: { type: 'realtime', model: 'gpt-realtime-1.5', output_modalities: ['text'], audio: { input: { turn_detection: null } } } });
  await client.ready;
  const source = (transcript: string) => asr.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'turn', content_index: 0, transcript });
  source('我想预约明天下午。');
  const initial = model.snapshot();
  assert.ok(initial.length >= 1);
  assert.equal(initial[0].boundary, 'semantic');
  assert.equal(initial[0].original?.final, false);
  const request = text.sent.find(event => event.type === 'response.create');
  text.receive({ type: 'response.created', response: { id: 'draft', metadata: request.response.metadata } });
  text.receive({ type: 'response.output_text.delta', response_id: 'draft', output_index: 0, content_index: 0, delta: "I'd like" });
  assert.equal(model.snapshot()[0].translation?.text, "I'd like");
  assert.equal(model.snapshot()[0].translation?.final, false);
  const id = model.snapshot()[0].id;
  text.receive({ type: 'response.done', response: { id: 'draft', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: "I'd like to book." }] }] } });
  assert.equal(model.getUtterance(id)?.original?.final, true);
  assert.equal(model.getUtterance(id)?.translation?.final, true);
  assert.equal(model.getUtterance(id)?.translation?.text, "I'd like to book.");
  assert.deepEqual(errors, []);
});

test('invalidated unspoken prefix sections are tombstoned and late response tokens cannot revive them', async t => {
  const sockets: FakeSocket[] = [];
  const adapter = new ConversationEventAdapter('call-prefix');
  const model = createConversationModel('call-prefix');
  const client = createOutgoingPrefixClient({
    apiKey: 'offline-fake', onTranscript() {}, onCommit() {}, onError() {},
    onConversationTranscript(event) { const update = adapter.transcript(event); if (update) model.apply(update); },
    createWebSocket() { const socket = new FakeSocket(); sockets.push(socket); return socket.socket(); },
  });
  t.after(() => client.abort());
  const [asr, text] = sockets;
  asr.open(); text.open();
  asr.receive({ type: 'session.updated', session: { type: 'transcription', audio: { input: {
    format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: 'gpt-live-transcribe', languages: ['zh-cn'] }, turn_detection: null,
  } } } });
  text.receive({ type: 'session.updated', session: { type: 'realtime', model: 'gpt-realtime-1.5', output_modalities: ['text'], audio: { input: { turn_detection: null } } } });
  await client.ready;
  asr.receive({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'turn', content_index: 0, delta: '我想预约明天下午' });
  const oldId = model.snapshot()[0].id;
  const request = text.sent.find(event => event.type === 'response.create');
  text.receive({ type: 'response.created', response: { id: 'old', metadata: request.response.metadata } });
  asr.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'turn', content_index: 0, transcript: '我不想预约明天下午三点。' });
  assert.equal(model.getUtterance(oldId), null);
  text.receive({ type: 'response.output_text.delta', response_id: 'old', output_index: 0, content_index: 0, delta: 'obsolete translation' });
  assert.equal(model.getUtterance(oldId), null);
  assert.ok(model.snapshot().every(row => row.translation?.text !== 'obsolete translation'));
});

test('real bridge correlation keeps partial marks pending until all chunks and producer seal complete', async t => {
  const local = new FakeSocket(), remote = new FakeSocket(); local.open(); remote.open();
  const adapter = new ConversationEventAdapter('call-prefix');
  const model = createConversationModel('call-prefix');
  let options!: OutgoingPrefixOptions;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const events: any[] = [];
  const transcript = (value: TranscriptEvent) => { const event = adapter.transcript(value); if (event) model.apply(event); };
  const bridge = new ContinuousTranslationBridge({
    apiKey: 'offline-fake', model: 'offline', outgoingPrefixes: true, remoteCaptions: true,
    onTranscript() {}, onFailure: code => assert.fail(code), onConversationTranscript: transcript,
    onUtterancePlayback(value) { const event = adapter.playback(value); if (event) { events.push(event); model.apply(event); } },
    onAudioDiagnostic(value) { const event = adapter.audio(value); if (event) { events.push(event); model.apply(event); } },
    createPrefixClient(value) { options = value; return { ready: Promise.resolve(), append() {}, finish: async () => {}, abort() {} }; },
    createCaptionClient() { return { ready: Promise.resolve(), append() {}, finish: async () => {}, abort() {} }; },
    localVoice: {
      diagnosticPrefix: 'pocket', ready: Promise.resolve(), synthesize: async () => { throw Error('STREAM_ONLY'); },
      async *synthesizeStream() { yield { pcm: Buffer.alloc(3840), sampleRate: 24000 }; await gate; yield { pcm: Buffer.alloc(3840), sampleRate: 24000 }; },
    },
  });
  t.after(() => { release(); bridge.close(); });
  bridge.attach('local', local.socket(), 'MZ_local'); bridge.attach('remote', remote.socket(), 'MZ_remote');
  await tick();
  const utteranceId = 'local:prefix_1:0';
  options.onConversationTranscript?.({ id: 'local:original:prefix_1:0', utteranceId, role: 'local', kind: 'original', text: '你好。', final: true, at: 100, pairing: 'explicit', boundary: 'semantic' });
  options.onConversationTranscript?.({ id: 'local:translation:prefix_1:0', utteranceId, role: 'local', kind: 'translation', text: 'Hello.', final: true, at: 100, pairing: 'explicit', boundary: 'semantic' });
  options.onCommit({ id: 'prefix_1', utteranceId, finalPart: true, text: 'Hello.', source: '你好。', firstDeltaAt: 100, committedAt: 150 });
  assert.equal(model.snapshot()[0].playback.status, 'queued');
  await tick();
  const firstMarks = remote.sent.filter(event => event.event === 'mark');
  assert.ok(firstMarks.length > 0);
  for (const mark of firstMarks) remote.receive(mark);
  assert.equal(model.snapshot()[0].playback.status, 'sent', 'a mark for the first chunk is not a full utterance seal');
  release(); await tick(); await tick();
  const seal = events.find(event => event.sealed);
  assert.ok(seal.expectedDeliveryCount >= 2);
  assert.equal(seal.expectedDeliveryCount, remote.sent.filter(event => event.event === 'mark').length);
  assert.equal(model.snapshot()[0].playback.status, 'sent');
  for (const mark of remote.sent.filter(event => event.event === 'mark')) remote.receive(mark);
  assert.equal(model.snapshot()[0].playback.status, 'played');
  assert.equal(model.snapshot()[0].playback.evidence, 'twilio_mark');
  assert.equal(model.snapshot().length, 1);
});
