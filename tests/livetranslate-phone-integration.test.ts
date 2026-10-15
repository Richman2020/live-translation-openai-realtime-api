/* eslint-disable no-await-in-loop -- Protocol order and per-call cleanup must settle before the next synthetic turn. */
/* eslint-disable max-classes-per-file -- Keep both in-memory transport peers in the complete offline integration fixture. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import WebSocket from 'ws';

import {
  createConversationModel,
  groupConversationUtterances,
  type ConversationEvent,
} from '../public/conversation-model.js';
import { ConversationEventAdapter } from '../src/solo/conversation-events';
import { createLiveTranslatePhoneBridge } from '../src/solo/livetranslate-phone-bridge';
import type { LiveTranslatePhoneConfig } from '../src/solo/livetranslate-phone-config';
import { Pcm24kToPcmu } from '../src/solo/translation-pcm';
import type { TranscriptEvent } from '../src/solo/translation-bridge';
import {
  createLiveTranslateClient,
  LIVE_TRANSLATE_MODEL,
  type LiveTranslateClientOptions,
  type LiveTranslateRole,
  type LiveTranslateVoice,
} from '../src/experiments/livetranslate-client';

const config: LiveTranslatePhoneConfig = {
  region: 'beijing',
  workspaceId: 'offline-phone-workspace',
  apiKey: 'OFFLINE_FAKE_PHONE_KEY_NEVER_AUTHENTICATED',
  model: LIVE_TRANSLATE_MODEL,
  voice: 'Andre',
};
const ACTUAL_VOICE_CAPTURE = JSON.parse(
  readFileSync(
    new URL(
      './fixtures/livetranslate-protocol/actual-andre-session-tina-response-andre.redacted.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

/** All phone audio and ASR/translation bodies below are synthetic. The only
 * original captured frames used by this suite are explicitly selected from
 * ACTUAL_VOICE_CAPTURE. That five-frame historical record is not B28's complete
 * successful audio and does not supply a real English-input/phone test. */
class Phone extends EventEmitter {
  readyState: number = WebSocket.OPEN;

  bufferedAmount = 0;

  sent: any[] = [];

  closed = 0;

  autoAck = true;

  constructor(readonly streamSid: string) {
    super();
  }

  send(raw: string, callback?: () => void) {
    const event = JSON.parse(raw);
    this.sent.push(event);
    callback?.();
    if (this.autoAck && event.event === 'mark') this.receive(event);
  }

  receive(event: object) {
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }

  media(audio: Buffer, timestamp = 0) {
    this.receive({
      event: 'media',
      streamSid: this.streamSid,
      media: {
        track: 'inbound',
        payload: audio.toString('base64'),
        timestamp: String(timestamp),
      },
    });
  }

  acknowledge() {
    for (const event of this.sent.filter((item) => item.event === 'mark'))
      this.receive(event);
  }

  terminate() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.closed += 1;
    this.emit('close', 1000, Buffer.from('SYNTHETIC_PRIVATE_PHONE_CLOSE'));
  }

  audio() {
    return Buffer.concat(
      this.sent
        .filter((event) => event.event === 'media')
        .map((event) => Buffer.from(event.media.payload, 'base64')),
    );
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

  sequence = 0;

  sessionId: string;

  constructor(
    readonly role: LiveTranslateRole,
    readonly voice: LiveTranslateVoice,
  ) {
    super();
    this.sessionId = `offline-session-${role}`;
  }

  session(nestedVoice: LiveTranslateVoice = this.voice) {
    return {
      id: this.sessionId,
      model: LIVE_TRANSLATE_MODEL,
      input_modalities: ['audio'],
      output_modalities: this.role === 'local' ? ['text', 'audio'] : ['text'],
      voice: this.voice,
      enable_voice_clone: false,
      audio: {
        input: {
          format: { type: 'pcm', sample_rate: 16000 },
          turn_detection: { type: 'speaker_detection', threshold: 0.5 },
        },
        output: {
          format: { type: 'pcm', sample_rate: 24000 },
          voice: nestedVoice,
        },
      },
      translation: { language: this.role === 'local' ? 'en' : 'zh' },
    };
  }

  send(raw: string, callback?: () => void) {
    this.sent.push(JSON.parse(raw));
    callback?.();
  }

  receive(event: any) {
    this.sequence += 1;
    const value = {
      event_id: `synthetic-${this.role}-${this.sequence}`,
      ...event,
    };
    this.received.push(value);
    this.emit('message', Buffer.from(JSON.stringify(value)), false);
    return value;
  }

  start(nestedVoice?: LiveTranslateVoice) {
    this.receive({
      type: 'session.created',
      session: this.session(nestedVoice),
    });
    this.receive({
      type: 'session.updated',
      session: this.session(nestedVoice),
    });
  }

  sourceStarted(id: string, offset: number) {
    this.receive({
      type: 'input_audio_buffer.speech_started',
      item_id: id,
      audio_start_ms: offset,
      speaker_id: 1,
    });
  }

  partial(id: string, text: string) {
    return this.receive({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: id,
      content_index: 0,
      delta: text,
    });
  }

  final(id: string, text: string, endOffset: number) {
    this.receive({
      type: 'input_audio_buffer.speech_stopped',
      item_id: id,
      audio_end_ms: endOffset,
    });
    return this.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: id,
      content_index: 0,
      transcript: text,
    });
  }

  response(
    responseId: string,
    outputId: string,
    sourceId: string,
    voice: LiveTranslateVoice = this.voice,
  ) {
    this.receive({
      type: 'response.created',
      response: { id: responseId, status: 'in_progress', output: [], voice },
    });
    this.receive({
      type: 'conversation.item.created',
      previous_item_id: sourceId,
      item: { id: outputId, role: 'assistant', content: [] },
    });
  }

  output(
    type: string,
    responseId: string,
    outputId: string,
    fields: object = {},
  ) {
    return this.receive({
      type,
      response_id: responseId,
      item_id: outputId,
      output_index: 0,
      content_index: 0,
      ...fields,
    });
  }

  text(responseId: string, outputId: string, text: string, final = false) {
    const kind = this.role === 'local' ? 'audio_transcript' : 'text';
    return this.output(
      `response.${kind}.${final ? 'done' : 'delta'}`,
      responseId,
      outputId,
      final
        ? { [this.role === 'local' ? 'transcript' : 'text']: text }
        : { delta: text },
    );
  }

  audio(responseId: string, outputId: string, pcm: Buffer) {
    return this.output('response.audio.delta', responseId, outputId, {
      delta: pcm.toString('base64'),
    });
  }

  complete(
    responseId: string,
    outputId: string,
    text: string,
    voice: LiveTranslateVoice = this.voice,
  ) {
    this.text(responseId, outputId, text, true);
    if (this.role === 'local')
      this.output('response.audio.done', responseId, outputId);
    return this.receive({
      type: 'response.done',
      response: {
        id: responseId,
        status: 'completed',
        voice,
        output: [
          {
            id: outputId,
            role: 'assistant',
            content: [
              this.role === 'local'
                ? { type: 'audio', transcript: text }
                : { type: 'text', text },
            ],
          },
        ],
        usage: {
          input_tokens: 9,
          output_tokens: this.role === 'local' ? 12 : 4,
          total_tokens: this.role === 'local' ? 21 : 13,
        },
      },
    });
  }

  close() {
    if (this.readyState !== WebSocket.CLOSED) {
      this.readyState = WebSocket.CLOSED;
      this.closed += 1;
      this.emit('close', 1000);
    }
  }

  terminate() {
    this.close();
  }

  inputs() {
    return this.sent
      .filter((event) => event.type === 'input_audio_buffer.append')
      .map((event) => Buffer.from(event.audio, 'base64'));
  }
}

function signal(bytes = 4800, phase = 0) {
  const value = Buffer.alloc(bytes);
  for (let index = 0; index < bytes / 2; index += 1)
    value.writeInt16LE(
      Math.round(Math.sin((index + phase) * 0.09) * 9000),
      index * 2,
    );
  return value;
}

function harness() {
  const local = new Phone('MZofflineLocal');
  const remote = new Phone('MZofflineRemote');
  const suppliers = new Map<LiveTranslateRole, Supplier>();
  const configurations = new Map<
    LiveTranslateRole,
    LiveTranslateClientOptions
  >();
  const diagnostics: any[] = [];
  const audioDiagnostics: any[] = [];
  const failures: string[] = [];
  const transcripts: TranscriptEvent[] = [];
  const events: ConversationEvent[] = [];
  const readyRoles: string[] = [];
  let now = 100000;
  const adapter = new ConversationEventAdapter(
    'offline-livetranslate-phone',
    () => now,
  );
  const model = createConversationModel('offline-livetranslate-phone');
  const apply = (event: ConversationEvent | null) => {
    if (!event) return;
    assert.equal(model.apply(event), true);
    events.push(event);
  };
  const bridge = createLiveTranslatePhoneBridge(
    {
      apiKey: 'UNUSED_OPENAI_FAKE_KEY',
      model: 'gpt-realtime-1.5',
      now: () => now,
      remoteCaptions: true,
      outgoingCaptions: false,
      onTranscript(event) {
        transcripts.push(event);
        apply(adapter.transcript(event));
        for (const update of adapter.takeTurnUpdates()) apply(update);
      },
      onFailure(code) {
        failures.push(code);
      },
      onConnection(event) {
        if (event.state === 'ready') readyRoles.push(event.role);
      },
      onAudioDiagnostic(event) {
        audioDiagnostics.push(event);
        apply(adapter.audio(event));
      },
      onUtterancePlayback(event) {
        apply(adapter.playback(event));
      },
      createWebSocket() {
        throw new Error('Original OpenAI transport must not be created');
      },
    },
    {
      config,
      onDiagnostic(event) {
        diagnostics.push(event);
      },
      deps: {
        createClient(options) {
          configurations.set(options.role, options);
          assert.equal(
            suppliers.has(options.role),
            false,
            'one session per role, zero retry/reconnect',
          );
          const supplier = new Supplier(options.role, options.voice!);
          suppliers.set(options.role, supplier);
          return createLiveTranslateClient({
            ...options,
            createWebSocket(address) {
              assert.equal(
                address,
                'wss://offline-phone-workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime',
              );
              return supplier as unknown as WebSocket;
            },
          });
        },
      },
    },
  );
  const start = async (capturedLocal?: any[]) => {
    bridge.attach('local', local.socket(), local.streamSid);
    const sender = suppliers.get('local')!;
    assert.ok(sender);
    if (capturedLocal) {
      for (const frame of capturedLocal) {
        sender.receive(frame.event);
        await tick();
      }
    } else sender.start();
    await tick();
    bridge.attach('remote', remote.socket(), remote.streamSid);
    assert.ok(suppliers.get('remote'));
    suppliers.get('remote')!.start();
    await tick();
  };
  const blocks = () => groupConversationUtterances(model.snapshot());
  return {
    bridge,
    local,
    remote,
    suppliers,
    configurations,
    diagnostics,
    audioDiagnostics,
    failures,
    transcripts,
    events,
    model,
    blocks,
    readyRoles,
    start,
    advance(ms: number) {
      now += ms;
    },
  };
}

test('actual client, phone codec and bridge stream local English before final text while remote original passes unchanged with captions only', async (t) => {
  const h = harness();
  t.after(() => h.bridge.close());
  await h.start();
  assert.deepEqual(
    h.readyRoles,
    ['local'],
    'remote caption readiness uses its separate caption port',
  );
  assert.deepEqual(
    h.diagnostics
      .filter((event) => event.stage === 'configuration')
      .map((event) => event.role),
    ['local', 'remote'],
  );
  assert.equal(h.configurations.get('local')!.voice, 'Andre');
  assert.equal(
    h.configurations.get('local')!.allowAndreTopLevelWithTinaOutput,
    true,
  );
  assert.equal(h.configurations.get('remote')!.voice, 'Tina');
  assert.equal(
    h.configurations.get('remote')!.allowAndreTopLevelWithTinaOutput,
    false,
  );
  assert.equal(
    h.configurations.get('remote')!.allowMissingVoiceCloneEcho,
    false,
  );
  assert.ok(
    [...h.configurations.values()].every(
      (options) => options.usage === 'phone',
    ),
  );
  const local = h.suppliers.get('local')!;
  const remote = h.suppliers.get('remote')!;
  h.local.media(Buffer.alloc(160, 0xff));
  assert.equal(
    local.inputs()[0].length,
    640,
    '20 ms 8k PCMU becomes 20 ms 16k PCM16',
  );
  assert.ok(local.inputs()[0].every((byte) => byte === 0));
  const original = Buffer.from([0xff, 0x7f, 0x10, 0x80, 0x90, 0x20]);
  h.remote.media(original);
  assert.deepEqual(
    h.local.audio(),
    original,
    'original English never waits for the model',
  );
  assert.equal(remote.inputs()[0].length, original.length * 4);
  const appendsBeforeAudio = [local.inputs().length, remote.inputs().length];
  local.sourceStarted('source-a', 0);
  local.partial('source-a', '我想预约');
  local.response('response-a', 'output-a', 'source-a');
  local.text('response-a', 'output-a', 'I would like');
  const generated = signal();
  local.audio('response-a', 'output-a', generated);
  await tick();
  assert.ok(
    h.remote.audio().length > 0,
    'first translated audio does not await ASR/text final',
  );
  assert.deepEqual(h.remote.audio(), new Pcm24kToPcmu().push(generated));
  const row = h.model
    .snapshot()
    .find((item) => item.original?.text === '我想预约')!;
  assert.equal(row.original?.final, false);
  local.final('source-a', '我想预约水管工。', 400);
  local.complete('response-a', 'output-a', 'I would like to book a plumber.');
  remote.sourceStarted('remote-source-a', 0);
  remote.partial('remote-source-a', 'I am');
  remote.response('remote-response-a', 'remote-output-a', 'remote-source-a');
  remote.final('remote-source-a', 'I am a plumber.', 300);
  remote.complete('remote-response-a', 'remote-output-a', '我是一名水管工。');
  await tick();
  assert.deepEqual(
    [local.inputs().length, remote.inputs().length],
    appendsBeforeAudio,
    'generated PCM is never fed back into either model',
  );
  assert.deepEqual(remote.sent[0].session.output_modalities, ['text']);
  assert.equal(
    remote.received.some((event) => event.type === 'response.audio.delta'),
    false,
  );
  assert.deepEqual(
    h.local.audio(),
    original,
    'no Chinese dubbing replaces or mixes with remote English',
  );
  assert.equal(
    h.model.getUtterance(row.id)?.original?.text,
    '我想预约水管工。',
  );
  assert.deepEqual(
    h
      .blocks()
      .filter((block) => !block.sourceUnassigned)
      .map((block) => block.role),
    ['local', 'remote'],
  );
  assert.ok(
    h.diagnostics
      .filter((event) => event.stage.startsWith('playback_'))
      .every((event) => event.actualPlaybackStartAt === null),
  );
  assert.deepEqual(h.failures, []);
});

test('ASR revisions and done snapshots keep one source row, genuine repetitions and later corrections remain distinct within the same speaker block', async (t) => {
  const h = harness();
  t.after(() => h.bridge.close());
  await h.start();
  const wire = h.suppliers.get('local')!;
  wire.sourceStarted('first', 0);
  wire.partial('first', '不是十五');
  const draft = h.model
    .snapshot()
    .find((row) => row.original?.text === '不是十五')!;
  wire.partial('first', '美元，是五十美元。');
  wire.final('first', '不是十五美元，是五十美元。', 500);
  wire.response('r1', 't1', 'first');
  wire.text('r1', 't1', 'Not fifteen dollars;');
  wire.audio('r1', 't1', signal());
  const final = wire.complete(
    'r1',
    't1',
    'Not fifteen dollars; fifty dollars.',
  );
  wire.receive(final);
  wire.sourceStarted('repeat', 600);
  wire.partial('repeat', '不是十五美元，是五十美元。');
  wire.final('repeat', '不是十五美元，是五十美元。', 1000);
  wire.response('r2', 't2', 'repeat');
  wire.audio('r2', 't2', signal());
  wire.complete('r2', 't2', 'Not fifteen dollars; fifty dollars.');
  wire.sourceStarted('correction', 1100);
  wire.partial('correction', '抱歉，更正为二十五美元。');
  wire.final('correction', '抱歉，更正为二十五美元。', 1500);
  wire.response('r3', 't3', 'correction');
  wire.audio('r3', 't3', signal());
  wire.complete('r3', 't3', 'Sorry, correction: twenty-five dollars.');
  await tick();
  assert.equal(
    draft.original?.text,
    '不是十五',
    'immutable historical raw snapshot is not overwritten',
  );
  assert.equal(
    h.model.getUtterance(draft.id)?.original?.text,
    '不是十五美元，是五十美元。',
  );
  const blocks = h.blocks().filter((block) => !block.sourceUnassigned);
  assert.equal(blocks.length, 1);
  assert.deepEqual(
    blocks[0].utterances.map((row) => row.original?.text),
    [
      '不是十五美元，是五十美元。',
      '不是十五美元，是五十美元。',
      '抱歉，更正为二十五美元。',
    ],
  );
  assert.deepEqual(
    blocks[0].utterances.map((row) => row.translation?.text),
    [
      'Not fifteen dollars; fifty dollars.',
      'Not fifteen dollars; fifty dollars.',
      'Sorry, correction: twenty-five dollars.',
    ],
  );
  assert.equal(new Set(blocks[0].utterances.map((row) => row.id)).size, 3);
  assert.deepEqual(h.failures, []);
});

test('interleaved response audio preserves response tails and exact duplicate frames never replay audio', async (t) => {
  const h = harness();
  t.after(() => h.bridge.close());
  await h.start();
  const wire = h.suppliers.get('local')!;
  wire.sourceStarted('s1', 0);
  wire.final('s1', '第一句。', 200);
  wire.sourceStarted('s2', 250);
  wire.final('s2', '第二句。', 450);
  wire.response('r1', 't1', 's1');
  wire.response('r2', 't2', 's2');
  const first = signal(4802, 0);
  const tail = signal(4804, 100);
  const next = signal(4800, 300);
  const event = wire.audio('r1', 't1', first);
  wire.receive(event);
  wire.audio('r2', 't2', next);
  wire.audio('r1', 't1', tail);
  await tick();
  const codec = new Pcm24kToPcmu();
  assert.deepEqual(
    h.remote.audio(),
    Buffer.concat([codec.push(first), codec.push(tail)]),
  );
  wire.complete('r1', 't1', 'First sentence.');
  await tick();
  assert.deepEqual(
    h.remote.audio(),
    Buffer.concat([
      new Pcm24kToPcmu().push(Buffer.concat([first, tail, next])),
    ]),
  );
  wire.complete('r2', 't2', 'Second sentence.');
  await tick();
  assert.equal(
    h.remote.audio().length,
    Math.floor((first.length + tail.length + next.length) / 6),
  );
  assert.equal(h.suppliers.size, 2);
  assert.deepEqual(h.failures, []);
});

test('different recognized languages never reassign authenticated media roles and a late earlier source translation stays in its A-B-A block', async (t) => {
  const h = harness();
  t.after(() => h.bridge.close());
  await h.start();
  const local = h.suppliers.get('local')!;
  const remote = h.suppliers.get('remote')!;
  local.sourceStarted('a1', 0);
  local.final('a1', 'This is on the local track.', 100);
  h.advance(100);
  remote.sourceStarted('b1', 0);
  remote.final('b1', '刚开', 100);
  remote.response('rb', 'tb', 'b1');
  remote.complete('rb', 'tb', '刚开');
  h.advance(100);
  local.sourceStarted('a2', 200);
  local.final('a2', '请保留本次更正。', 300);
  local.response('ra1', 'ta1', 'a1');
  local.audio('ra1', 'ta1', signal());
  local.complete('ra1', 'ta1', 'This is on the local track.');
  await tick();
  const blocks = h.blocks().filter((block) => !block.sourceUnassigned);
  assert.deepEqual(
    blocks.map((block) => block.role),
    ['local', 'remote', 'local'],
  );
  assert.equal(
    blocks[0].utterances[0].original?.text,
    'This is on the local track.',
  );
  assert.equal(blocks[1].utterances[0].original?.text, '刚开');
  assert.equal(
    blocks[0].utterances[0].translation?.text,
    'This is on the local track.',
  );
  assert.equal(blocks[2].utterances[0].translation, null);
  assert.deepEqual(h.failures, []);
});

test('captured Andre metadata frames cross the historical stopping point without treating nested Tina as a new request or acoustic fact', async (t) => {
  assert.equal(ACTUAL_VOICE_CAPTURE.providerFrames.length, 5);
  assert.equal(
    ACTUAL_VOICE_CAPTURE.sourceCandidate,
    '4c1ad02234481ee14c1e3a4093f3c09e51e4ebfb',
  );
  const h = harness();
  t.after(() => h.bridge.close());
  await h.start(ACTUAL_VOICE_CAPTURE.providerFrames);
  const local = h.suppliers.get('local')!;
  assert.equal(local.sent.length, 1);
  assert.equal(local.sent[0].session.voice, 'Andre');
  assert.equal(local.sent[0].session.enable_voice_clone, false);
  assert.equal(
    h.diagnostics.some((event) => event.stage === 'failed'),
    false,
  );
  assert.equal(
    h.diagnostics.some(
      (event) => event.code === 'LIVETRANSLATE_APPROVED_ANDRE_TINA_CONFLICT',
    ),
    true,
  );
  const layers = h.diagnostics.filter(
    (event) => event.stage === 'voice_evidence' && event.role === 'local',
  );
  assert.equal(
    layers.find((event) => event.voiceEvent === 'session.created')?.nestedVoice,
    'Tina',
  );
  assert.equal(
    layers.find((event) => event.voiceEvent === 'session.updated')
      ?.topLevelVoice,
    'Andre',
  );
  assert.equal(
    layers.find((event) => event.voiceEvent === 'session.updated')?.nestedVoice,
    'Tina',
  );
  assert.equal(
    layers.find((event) => event.voiceEvent === 'response.created')
      ?.responseVoice,
    'Andre',
  );
  assert.equal(
    h.remote.audio().length,
    0,
    'captured five frames contain no audio; none is invented',
  );
  assert.deepEqual(h.failures, []);
});

test('a real supplier close only stops translation, preserves a fixed first cause and remote original, and a later real media disconnect cleans both phone legs', async (t) => {
  const h = harness();
  t.after(() => h.bridge.close());
  await h.start();
  const local = h.suppliers.get('local')!;
  local.emit('close', 1006, Buffer.from('SYNTHETIC_PRIVATE_PROVIDER_REASON'));
  await tick();
  const failed = h.diagnostics.filter((event) => event.stage === 'failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].code, 'LIVETRANSLATE_CONNECTION_CLOSED');
  assert.equal(failed[0].closeCode, 1006);
  assert.deepEqual(h.failures, []);
  assert.equal(h.local.readyState, WebSocket.OPEN);
  assert.equal(h.remote.readyState, WebSocket.OPEN);
  const original = Buffer.from([0x80, 0x7f, 0xff, 0x01]);
  h.remote.media(original);
  assert.deepEqual(h.local.audio(), original);
  const prior = h.remote.audio().length;
  local.audio('late-response', 'late-item', signal());
  h.remote.terminate();
  await tick();
  assert.equal(h.local.readyState, WebSocket.CLOSED);
  assert.equal(h.remote.audio().length, prior);
  assert.equal(h.failures.length, 1);
  const diagnosticText = JSON.stringify(h.diagnostics);
  assert.equal(diagnosticText.includes(config.apiKey), false);
  assert.equal(
    diagnosticText.includes('SYNTHETIC_PRIVATE_PROVIDER_REASON'),
    false,
  );
  assert.equal(
    h.diagnostics.filter((event) => event.stage === 'failed').length,
    1,
  );
});

test('manual end drops pending untranslated or unplayed work and late source, output and original packets cannot revive a call', async () => {
  const h = harness();
  await h.start();
  const local = h.suppliers.get('local')!;
  local.sourceStarted('unfinished', 0);
  local.partial('unfinished', '尚未说完');
  local.response('unfinished-response', 'unfinished-output', 'unfinished');
  local.audio('unfinished-response', 'unfinished-output', signal());
  await tick();
  const before = h.remote.audio().length;
  const textBefore = h.model.snapshot().map((row) => row.original?.text);
  h.bridge.close();
  local.audio('unfinished-response', 'unfinished-output', signal());
  local.final('unfinished', '迟到结果不可恢复', 200);
  h.remote.media(Buffer.from([0x80, 0x10]));
  await tick();
  assert.equal(h.remote.audio().length, before);
  assert.deepEqual(
    h.model.snapshot().map((row) => row.original?.text),
    textBefore,
  );
  assert.ok(
    [...h.suppliers.values()].every((supplier) => supplier.closed === 1),
  );
  assert.equal(h.local.closed, 1);
  assert.equal(h.remote.closed, 1);
  assert.deepEqual(h.failures, []);
});

test('phone profile survives silence, over 4096 total events and hundreds of completed turns without audition deadlines, fallback or provider reconnection', async (t) => {
  const h = harness();
  t.after(() => h.bridge.close());
  await h.start();
  const local = h.suppliers.get('local')!;
  h.advance(20 * 60 * 1000);
  h.local.media(Buffer.alloc(160, 0xff));
  for (let index = 0; index < 420; index += 1) {
    const sourceId = `long-source-${index}`;
    const responseId = `long-response-${index}`;
    const outputId = `long-output-${index}`;
    local.sourceStarted(sourceId, index * 2000);
    local.partial(sourceId, '合成正常发言。');
    local.final(sourceId, '合成正常发言。', index * 2000 + 1000);
    local.response(responseId, outputId, sourceId);
    local.text(responseId, outputId, 'Synthetic speech.');
    local.audio(responseId, outputId, signal(480));
    local.complete(responseId, outputId, 'Synthetic speech.');
    await tick();
  }
  assert.ok(local.received.length > 4096);
  assert.equal(
    h.model.snapshot().filter((row) => row.original?.text === '合成正常发言。')
      .length,
    420,
    'genuine repeated sources are retained',
  );
  assert.equal(h.blocks().filter((block) => !block.sourceUnassigned).length, 1);
  assert.equal(h.local.readyState, WebSocket.OPEN);
  assert.equal(h.remote.readyState, WebSocket.OPEN);
  assert.equal(h.suppliers.size, 2);
  assert.equal(
    h.diagnostics.some((event) => event.stage === 'failed'),
    false,
  );
  assert.deepEqual(h.failures, []);
});

test('unsupported remote audio or an unapproved local response voice stops only translation without widening the ACK exception or retrying', async (t) => {
  const expected = {
    'remote-audio': 'LIVETRANSLATE_UNEXPECTED_AUDIO',
    'strict-local-voice': 'LIVETRANSLATE_CONFIGURATION_REJECTED',
    'unsupported-content-index': 'LIVETRANSLATE_UNSUPPORTED_SCHEMA',
  };
  for (const scenario of [
    'remote-audio',
    'strict-local-voice',
    'unsupported-content-index',
  ] as const) {
    const h = harness();
    t.after(() => h.bridge.close());
    await h.start();
    const role = scenario === 'remote-audio' ? 'remote' : 'local';
    const wire = h.suppliers.get(role)!;
    wire.sourceStarted('source', 0);
    wire.final(
      'source',
      role === 'local' ? '不要取消。' : 'Do not cancel.',
      100,
    );
    if (scenario === 'strict-local-voice') {
      // An exact Andre ACK did not negotiate the real Andre/Tina conflict.
      wire.response('response', 'output', 'source', 'Tina');
    } else {
      wire.response('response', 'output', 'source');
      if (scenario === 'remote-audio')
        wire.audio('response', 'output', signal());
      else
        wire.output('response.audio_transcript.delta', 'response', 'output', {
          content_index: 1,
          delta: 'Unsupported second content.',
        });
    }
    await tick();
    const failed = h.diagnostics.filter((event) => event.stage === 'failed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].code, expected[scenario]);
    const original = Buffer.from([0xff, 0x10, 0x80, 0x7f]);
    h.remote.media(original);
    assert.deepEqual(h.local.audio(), original);
    assert.equal(h.remote.audio().length, 0);
    assert.equal(h.local.readyState, WebSocket.OPEN);
    assert.equal(h.remote.readyState, WebSocket.OPEN);
    assert.equal(h.suppliers.size, 2);
    assert.ok(
      [...h.suppliers.values()].every(
        (supplier) =>
          supplier.sent.filter((event) => event.type === 'session.update')
            .length === 1,
      ),
    );
    assert.deepEqual(h.failures, []);
  }
});

test('unbound late output is never guessed from same-role text and a documented direct edge returns it to its earlier A-B-A source without a duplicate row', async (t) => {
  const h = harness();
  t.after(() => h.bridge.close());
  await h.start();
  const local = h.suppliers.get('local')!;
  const remote = h.suppliers.get('remote')!;
  local.sourceStarted('earlier-local', 0);
  local.final('earlier-local', '第一次发言。', 100);
  local.receive({
    type: 'response.created',
    response: {
      id: 'unbound-response',
      status: 'in_progress',
      output: [],
      voice: 'Andre',
    },
  });
  local.text('unbound-response', 'unbound-output', 'The earlier statement.');
  local.audio('unbound-response', 'unbound-output', signal());
  await tick();
  assert.equal(
    h.model
      .snapshot()
      .some((row) => row.translation?.text === 'The earlier statement.'),
    false,
    'phone profile has no source anchor for the output yet',
  );
  assert.equal(
    h.remote.audio().length,
    0,
    'unbound audio waits for the genuine edge rather than borrowing latest same-role source',
  );
  h.advance(100);
  remote.sourceStarted('interruption', 0);
  remote.final('interruption', 'Please wait.', 100);
  h.advance(100);
  local.sourceStarted('later-local', 200);
  local.final('later-local', '第二次发言。', 300);
  const link = local.receive({
    type: 'conversation.item.created',
    previous_item_id: 'earlier-local',
    item: { id: 'unbound-output', role: 'assistant', content: [] },
  });
  local.receive(link);
  await tick();
  local.complete(
    'unbound-response',
    'unbound-output',
    'The earlier statement.',
  );
  await tick();
  const blocks = h.blocks().filter((block) => !block.sourceUnassigned);
  assert.deepEqual(
    blocks.map((block) => block.role),
    ['local', 'remote', 'local'],
  );
  assert.equal(
    blocks[0].utterances[0].translation?.text,
    'The earlier statement.',
  );
  assert.equal(blocks[2].utterances[0].translation, null);
  assert.equal(
    h.model
      .snapshot()
      .filter((row) => row.translation?.text === 'The earlier statement.')
      .length,
    1,
  );
  assert.ok(h.remote.audio().length > 0);
  assert.deepEqual(h.failures, []);
});

test('two supplier sessions may reuse source, output and response IDs without crossing authenticated roles or dubbing the remote direction', async (t) => {
  const h = harness();
  t.after(() => h.bridge.close());
  await h.start();
  const local = h.suppliers.get('local')!;
  const remote = h.suppliers.get('remote')!;
  local.sourceStarted('shared-source', 0);
  local.final('shared-source', '我方不是取消，是更改日期。', 300);
  remote.sourceStarted('shared-source', 0);
  remote.final('shared-source', 'I will keep the amount unchanged.', 300);
  local.response('shared-response', 'shared-output', 'shared-source');
  remote.response('shared-response', 'shared-output', 'shared-source');
  local.audio('shared-response', 'shared-output', signal());
  local.complete(
    'shared-response',
    'shared-output',
    'I am changing the date, not cancelling.',
  );
  remote.complete('shared-response', 'shared-output', '我会保持金额不变。');
  await tick();
  const rows = h.model.snapshot().filter((row) => row.original);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].id, rows[1].id);
  assert.deepEqual(
    rows.map((row) => [row.role, row.original?.text, row.translation?.text]),
    [
      [
        'local',
        '我方不是取消，是更改日期。',
        'I am changing the date, not cancelling.',
      ],
      ['remote', 'I will keep the amount unchanged.', '我会保持金额不变。'],
    ],
  );
  assert.equal(h.local.audio().length, 0, 'remote generated no Chinese audio');
  assert.ok(h.remote.audio().length > 0);
  assert.deepEqual(h.failures, []);
});
