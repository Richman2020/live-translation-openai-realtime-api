/* eslint-disable no-await-in-loop, max-classes-per-file -- Independent in-memory phone/model peers preserve protocol ordering and cleanup boundaries. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, type TestContext } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import WebSocket from 'ws';

import {
  createLiveTranslateClient,
  LIVE_TRANSLATE_MODEL,
  type LiveTranslateClient,
  type LiveTranslateClientOptions,
  type LiveTranslateRole,
} from '../src/experiments/livetranslate-client';
import { createLiveTranslatePhoneBridge } from '../src/solo/livetranslate-phone-bridge';
import { Pcm24kToPcmu } from '../src/solo/translation-pcm';

// All supplier events, audio and telephone peers in this suite are synthetic.
// The real client, codec and phone bridge are exercised without network I/O.
// These cases are not recovered incident frames or evidence of human audibility.
const flush = async () => {
  for (let i = 0; i < 6; i += 1) await tick();
};

class Phone extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: any[] = [];
  closed = 0;
  autoAck = false;
  constructor(readonly streamSid: string) {
    super();
  }
  receive(event: object) {
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }
  send(raw: string, callback?: (error?: Error) => void) {
    const event = JSON.parse(raw);
    this.sent.push(event);
    callback?.();
    if (this.autoAck && event.event === 'mark') this.receive(event);
  }
  acknowledge() {
    for (const event of this.sent.filter((item) => item.event === 'mark'))
      this.receive(event);
  }
  media(pcmu: Buffer) {
    this.receive({
      event: 'media',
      streamSid: this.streamSid,
      media: {
        track: 'inbound',
        timestamp: '20',
        payload: pcmu.toString('base64'),
      },
    });
  }
  audio() {
    return Buffer.concat(
      this.sent
        .filter((item) => item.event === 'media')
        .map((item) => Buffer.from(item.media.payload, 'base64')),
    );
  }
  terminate() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.closed += 1;
    this.emit('close', 1000);
  }
  socket() {
    return this as unknown as WebSocket;
  }
}

class Supplier extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: any[] = [];
  received: any[] = [];
  closed = 0;
  constructor(readonly options: LiveTranslateClientOptions) {
    super();
  }
  send(raw: string, callback?: (error?: Error) => void) {
    this.sent.push(JSON.parse(raw));
    callback?.();
  }
  receive(event: object) {
    const frame = {
      event_id: `synthetic-${this.options.role}-${this.received.length + 1}`,
      ...event,
    };
    this.received.push(frame);
    this.replay(frame);
    return frame;
  }
  replay(frame: object) {
    this.emit('message', Buffer.from(JSON.stringify(frame)), false);
  }
  start() {
    const { role, voice } = this.options;
    const session = {
      id: `capacity-${role}`,
      model: LIVE_TRANSLATE_MODEL,
      voice,
      enable_voice_clone: false,
      output_modalities: role === 'local' ? ['text', 'audio'] : ['text'],
      translation: { language: role === 'local' ? 'en' : 'zh' },
      audio: {
        input: {
          format: { type: 'pcm', sample_rate: 16000 },
          turn_detection: { type: 'speaker_detection', threshold: 0.5 },
        },
        output: { format: { type: 'pcm', sample_rate: 24000 }, voice },
      },
    };
    this.receive({ type: 'session.created', session });
    this.receive({ type: 'session.updated', session });
  }
  source(
    id: string,
    offset: number,
    final = true,
    text = `Synthetic source ${id}`,
  ) {
    this.receive({
      type: 'input_audio_buffer.speech_started',
      item_id: id,
      audio_start_ms: offset,
    });
    if (final) this.sourceFinal(id, offset + 300, text);
    else
      this.receive({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: id,
        content_index: 0,
        delta: text,
      });
  }
  sourceFinal(id: string, offset: number, text = `Synthetic source ${id}`) {
    this.receive({
      type: 'input_audio_buffer.speech_stopped',
      item_id: id,
      audio_end_ms: offset,
    });
    this.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: id,
      content_index: 0,
      transcript: text,
    });
  }
  complete(
    id: string,
    sourceId: string,
    pcm = Buffer.alloc(96, 1),
    text = `Synthetic translation ${id}`,
  ) {
    const before = this.received.length;
    this.receive({
      type: 'response.created',
      response: {
        id: `response-${id}`,
        voice: this.options.voice,
        status: 'in_progress',
      },
    });
    this.receive({
      type: 'conversation.item.created',
      previous_item_id: sourceId,
      item: { id: `output-${id}`, role: 'assistant', content: [] },
    });
    const fields = {
      response_id: `response-${id}`,
      item_id: `output-${id}`,
      output_index: 0,
      content_index: 0,
    };
    this.receive({
      type:
        this.options.role === 'local'
          ? 'response.audio_transcript.done'
          : 'response.text.done',
      ...fields,
      ...(this.options.role === 'local' ? { transcript: text } : { text }),
    });
    if (this.options.role === 'local') {
      this.receive({
        type: 'response.audio.delta',
        ...fields,
        delta: pcm.toString('base64'),
      });
      this.receive({ type: 'response.audio.done', ...fields });
    }
    this.receive({
      type: 'response.done',
      response: {
        id: `response-${id}`,
        voice: this.options.voice,
        status: 'completed',
        output: [
          {
            id: `output-${id}`,
            role: 'assistant',
            content: [
              this.options.role === 'local'
                ? { type: 'audio', transcript: text }
                : { type: 'text', text },
            ],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      },
    });
    return this.received.slice(before);
  }
  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.closed += 1;
    this.emit('close', 1000);
  }
  terminate() {
    this.close();
  }
}

async function fixture(t: TestContext) {
  const phones = {
    local: new Phone('MZ_capacity_local'),
    remote: new Phone('MZ_capacity_remote'),
  };
  const suppliers = new Map<LiveTranslateRole, Supplier>();
  const clients = new Map<LiveTranslateRole, LiveTranslateClient>();
  const diagnostics: any[] = [];
  const captions: any[] = [];
  const transcripts: any[] = [];
  const failures: string[] = [];
  const bridge = createLiveTranslatePhoneBridge(
    {
      apiKey: 'UNUSED_OPENAI_OFFLINE_KEY',
      model: 'unused-model',
      now: () => 100000,
      remoteCaptions: true,
      outgoingCaptions: false,
      onTranscript: (event) => transcripts.push(event),
      onCaptionState: (event) => captions.push(event),
      onFailure: (code) => failures.push(code),
    },
    {
      config: {
        region: 'beijing',
        workspaceId: 'offline-capacity-workspace',
        apiKey: 'SYNTHETIC_NONCREDENTIAL',
        model: LIVE_TRANSLATE_MODEL,
        voice: 'Andre',
      },
      onDiagnostic: (event) => diagnostics.push(event),
      deps: {
        createClient(options) {
          assert.equal(
            suppliers.has(options.role),
            false,
            'One model session per direction; no reconnect',
          );
          const supplier = new Supplier(options);
          suppliers.set(options.role, supplier);
          const client = createLiveTranslateClient({
            ...options,
            createWebSocket: () => supplier as unknown as WebSocket,
          });
          clients.set(options.role, client);
          return client;
        },
      },
    },
  );
  t.after(() => bridge.close());
  for (const role of ['local', 'remote'] as const) {
    bridge.attach(role, phones[role].socket(), phones[role].streamSid);
    suppliers.get(role)!.start();
    await clients.get(role)!.ready;
    await flush();
  }
  const drained = () =>
    diagnostics.filter((event) => event.stage === 'playback_drained');
  const assertHealthy = () => {
    assert.deepEqual(failures, []);
    assert.equal(
      diagnostics.some((event) => event.stage === 'failed'),
      false,
    );
    assert.equal(
      captions.some((event) => event.translationStopped === true),
      false,
    );
    assert.equal(suppliers.size, 2);
  };
  return {
    bridge,
    phones,
    suppliers,
    clients,
    diagnostics,
    transcripts,
    failures,
    drained,
    assertHealthy,
  };
}

test('synthetic compacted client responses retain unacknowledged phone deliveries; old frames do not recreate playback', async (t) => {
  const f = await fixture(t);
  const local = f.suppliers.get('local')!;
  local.source('one-source', 0);
  let firstFrames: object[] = [];
  for (let index = 0; index < 64; index += 1) {
    const frames = local.complete(`same-source-${index}`, 'one-source');
    if (index === 0) firstFrames = frames;
    await flush();
  }
  const snapshot = f.clients.get('local')!.retentionSnapshot!();
  assert.equal(snapshot.activeResponses, 32);
  assert.equal(snapshot.activeTranslations, 32);
  assert.ok((snapshot.retiredResponsesTotal ?? 0) >= 32);
  assert.equal(f.phones.remote.audio().length, 64 * 16);
  assert.equal(
    f.drained().length,
    0,
    'Client compaction is not a phone mark acknowledgement',
  );
  f.assertHealthy();
  f.phones.remote.acknowledge();
  await flush();
  assert.equal(f.drained().length, 64);
  f.phones.remote.acknowledge();
  await flush();
  const audioBeforeReplay = f.phones.remote.audio().length;
  const textBeforeReplay = f.transcripts.length;
  for (const frame of firstFrames) local.replay(frame);
  await flush();
  assert.equal(f.phones.remote.audio().length, audioBeforeReplay);
  assert.equal(f.transcripts.length, textBeforeReplay);
  assert.equal(
    f.drained().length,
    64,
    'Old supplier events cannot create a fresh phone Output',
  );
  f.assertHealthy();
  f.bridge.close();
  assert.ok(
    [...f.suppliers.values()].every((supplier) => supplier.closed === 1),
  );
  assert.ok(Object.values(f.phones).every((phone) => phone.closed === 1));
});

test('synthetic supplier-done B remains active while A is unfinished, despite compaction pressure; release stays A then B', async (t) => {
  // This case tests event ordering, not elapsed timeout behavior. Freeze timeout
  // callbacks so unrelated test-runner load cannot consume the ordering budget.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t);
  const local = f.suppliers.get('local')!;
  local.source('earlier-A', 1000, false);
  local.source('later-B', 2000);
  const bPcm = Buffer.alloc(9600, 3);
  const bFrames = local.complete('B-created-first', 'later-B', bPcm);
  await flush();
  assert.equal(f.phones.remote.audio().length, 0);
  const aPcms: Buffer[] = [];
  for (let index = 0; index < 33; index += 1) {
    const pcm = Buffer.alloc(96, 1);
    aPcms.push(pcm);
    local.complete(`A-${index}`, 'earlier-A', pcm);
    await flush();
  }
  const waiting = f.clients.get('local')!.retentionSnapshot!();
  assert.equal(
    waiting.activeResponses,
    33,
    'Keep 32 mature A responses plus the still-buffered B response',
  );
  assert.ok((waiting.retiredResponsesTotal ?? 0) >= 1);
  assert.equal(f.phones.remote.audio().length, 33 * 16);
  assert.equal(f.drained().length, 0);
  f.assertHealthy();
  local.sourceFinal('earlier-A', 1300);
  await flush();
  const converter = new Pcm24kToPcmu();
  const expected = Buffer.concat([
    ...aPcms.map((pcm) => converter.push(pcm)),
    converter.push(bPcm),
  ]);
  assert.deepEqual(
    f.phones.remote.audio(),
    expected,
    'B PCM is released only after all earlier A output',
  );
  assert.equal(
    f.clients.get('local')!.retentionSnapshot!().activeResponses,
    32,
  );
  f.phones.remote.acknowledge();
  await flush();
  assert.equal(
    f.drained().length,
    34,
    'B still owns its original phone output record after late client release',
  );
  const before = f.phones.remote.audio().length;
  for (const frame of bFrames) local.replay(frame);
  await flush();
  assert.equal(f.phones.remote.audio().length, before);
  assert.equal(f.drained().length, 34);
  f.assertHealthy();
});

test('synthetic pending-mark phone stop closes both media/model peers and fences compacted or late output', async (t) => {
  const f = await fixture(t);
  const local = f.suppliers.get('local')!;
  local.source('closing-source', 0);
  let frames: object[] = [];
  for (let index = 0; index < 40; index += 1) {
    frames = local.complete(`closing-${index}`, 'closing-source');
    await flush();
  }
  assert.ok(
    (f.clients.get('local')!.retentionSnapshot!().retiredResponsesTotal ?? 0) >
      0,
  );
  assert.equal(f.drained().length, 0);
  f.phones.remote.receive({
    event: 'stop',
    streamSid: f.phones.remote.streamSid,
  });
  await flush();
  assert.equal(f.failures.length, 1);
  assert.ok(
    [...f.suppliers.values()].every((supplier) => supplier.closed === 1),
  );
  assert.ok(Object.values(f.phones).every((phone) => phone.closed === 1));
  const before = f.phones.remote.audio().length;
  f.phones.remote.acknowledge();
  for (const frame of frames) local.replay(frame);
  await flush();
  assert.equal(f.phones.remote.audio().length, before);
  assert.equal(
    f.drained().length,
    0,
    'A late mark cannot relabel cancelled output as played',
  );
});

test('synthetic remote original remains byte-identical and text-only captions still work after local compaction', async (t) => {
  const f = await fixture(t);
  const local = f.suppliers.get('local')!;
  local.source('local-active', 0);
  for (let index = 0; index < 40; index += 1) {
    local.complete(`local-${index}`, 'local-active');
    await flush();
  }
  const remote = f.suppliers.get('remote')!;
  assert.deepEqual(remote.sent[0].session.output_modalities, ['text']);
  const original = Buffer.from([0xff, 0x91, 0x10, 0x80]);
  f.phones.remote.media(original);
  assert.deepEqual(f.phones.local.audio(), original);
  remote.source('remote-source', 0, true, 'Do not cancel.');
  const outgoingBefore = f.phones.remote.audio().length;
  remote.complete(
    'remote-caption',
    'remote-source',
    Buffer.alloc(0),
    '不要取消。',
  );
  await flush();
  assert.ok(
    f.transcripts.some(
      (event) =>
        event.role === 'remote' &&
        event.kind === 'translation' &&
        event.text === '不要取消。',
    ),
  );
  assert.equal(
    f.phones.remote.audio().length,
    outgoingBefore,
    'Remote text-only captions create no Chinese voice',
  );
  assert.deepEqual(f.phones.local.audio(), original);
  f.assertHealthy();
});
