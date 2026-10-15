/* eslint-disable no-await-in-loop -- Offline session isolation is asserted serially. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import WebSocket from 'ws';

import {
  createLiveTranslateClient,
  LIVE_TRANSLATE_MODEL,
} from '../src/experiments/livetranslate-client';
import type { LiveTranslateClientOptions } from '../src/experiments/livetranslate-types';

class Wire extends EventEmitter {
  readyState: number = WebSocket.OPEN;

  bufferedAmount = 0;

  sent: any[] = [];

  closes = 0;

  send(raw: string, callback?: (error?: Error) => void) {
    this.sent.push(JSON.parse(raw));
    callback?.();
  }

  terminate() {
    this.closes += 1;
    this.readyState = WebSocket.CLOSED;
    this.emit('close', 1006);
  }

  close() {
    this.closes += 1;
    this.readyState = WebSocket.CLOSED;
    this.emit('close', 1000);
  }
}
function fixture(
  t: TestContext,
  extras: Partial<LiveTranslateClientOptions> = {},
) {
  const wire = new Wire();
  const sources: any[] = [];
  const translations: any[] = [];
  const audio: any[] = [];
  const usage: any[] = [];
  const errors: any[] = [];
  const timing: any[] = [];
  const frames: any[] = [];
  let event = 0;
  let connects = 0;
  const role = extras.role ?? 'local';
  const voice = role === 'local' ? 'Andre' : 'Aiden';
  const client = createLiveTranslateClient({
    enabled: true,
    usage: 'phone',
    role,
    voice,
    allowAndreTopLevelWithTinaOutput: role === 'local',
    workspaceId: 'offline-phone',
    apiKey: 'SYNTHETIC_NEVER_USED_KEY',
    onSource: (item) => sources.push(item),
    onTranslation: (item) => translations.push(item),
    onAudio: (pcm, meta) => audio.push({ pcm, meta }),
    onUsage: (item) => usage.push(item),
    onTiming: (item) => timing.push(item),
    onError: (code) => errors.push(code),
    createWebSocket() {
      connects += 1;
      return wire as unknown as WebSocket;
    },
    ...extras,
  });
  t.after(() => client.abort());
  function receive(frame: any) {
    event += 1;
    const item = { event_id: `ev_${event}`, ...frame };
    frames.push(item);
    wire.emit('message', Buffer.from(JSON.stringify(item)), false);
  }
  const session = {
    id: 'phone_session',
    model: LIVE_TRANSLATE_MODEL,
    voice,
    output_modalities: role === 'local' ? ['text', 'audio'] : ['text'],
    enable_voice_clone: false,
    audio: {
      input: {
        format: { type: 'pcm', sample_rate: 16000 },
        turn_detection: { type: 'speaker_detection', threshold: 0.5 },
      },
      output: {
        format: { type: 'pcm', sample_rate: 24000 },
        voice: role === 'local' ? 'Tina' : voice,
      },
    },
    translation: { language: role === 'local' ? 'en' : 'zh' },
  };
  const start = async () => {
    receive({ type: 'session.created', session });
    receive({ type: 'session.updated', session });
    await client.ready;
  };
  const source = (index: number, anchored = true, final = true) => {
    if (anchored) {
      receive({
        type: 'input_audio_buffer.speech_started',
        item_id: `s_${index}`,
        audio_start_ms: index * 1000,
      });
      receive({
        type: 'input_audio_buffer.speech_stopped',
        item_id: `s_${index}`,
        audio_end_ms: index * 1000 + 300,
      });
    }
    receive({
      type: `conversation.item.input_audio_transcription.${final ? 'completed' : 'delta'}`,
      item_id: `s_${index}`,
      content_index: 0,
      ...(final
        ? { transcript: `synthetic source ${index}` }
        : { delta: `synthetic source ${index}` }),
    });
  };
  const created = (index: number) =>
    receive({
      type: 'response.created',
      response: { id: `r_${index}`, voice, status: 'in_progress' },
    });
  const link = (index: number, sourceIndex = index) =>
    receive({
      type: 'conversation.item.created',
      previous_item_id: `s_${sourceIndex}`,
      item: { id: `t_${index}`, role: 'assistant' },
    });
  const output = (index: number, type: string, patch: any = {}) =>
    receive({
      type,
      response_id: `r_${index}`,
      item_id: `t_${index}`,
      output_index: 0,
      content_index: 0,
      ...patch,
    });
  const done = (index: number) =>
    receive({
      type: 'response.done',
      response: {
        id: `r_${index}`,
        voice: role === 'local' ? 'Andre' : 'Aiden',
        status: 'completed',
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          input_tokens_details: { audio_tokens: 1, text_tokens: 0 },
          output_tokens_details: {
            audio_tokens: role === 'local' ? 1 : 0,
            text_tokens: 1,
          },
        },
        output: [
          {
            id: `t_${index}`,
            content: [
              role === 'local'
                ? { type: 'audio', transcript: `translation ${index}` }
                : { type: 'text', text: `translation ${index}` },
            ],
          },
        ],
      },
    });
  const complete = (index: number) => {
    source(index);
    created(index);
    link(index);
    output(
      index,
      role === 'local'
        ? 'response.audio_transcript.done'
        : 'response.text.done',
      role === 'local'
        ? { transcript: `translation ${index}` }
        : { text: `translation ${index}` },
    );
    if (role === 'local') {
      output(index, 'response.audio.delta', {
        delta: Buffer.from([index % 256, 0]).toString('base64'),
      });
      output(index, 'response.audio.done');
    }
    done(index);
  };
  return {
    client,
    wire,
    frames,
    receive,
    start,
    source,
    created,
    link,
    output,
    done,
    complete,
    sources,
    translations,
    audio,
    usage,
    errors,
    timing,
    connects: () => connects,
  };
}

test('phone streams over 4096 wire events and 256 final items with bounded live and terminal retention', async (t) => {
  const f = fixture(t);
  await f.start();
  for (let index = 0; index < 600; index += 1) f.complete(index);
  assert.ok(f.frames.length > 4096);
  assert.deepEqual(f.errors, []);
  assert.equal(f.audio.length, 600);
  assert.equal(f.sources.length, 600);
  assert.equal(f.usage.length, 600);
  const snapshot = f.client.retentionSnapshot!();
  assert.equal(snapshot.usage, 'phone');
  assert.equal(snapshot.activeSources, 32);
  assert.equal(snapshot.activeTranslations, 32);
  assert.equal(snapshot.activeResponses, 32);
  assert.ok(snapshot.retainedEventIds < 32);
  assert.equal(snapshot.terminalIdentifiers, 1024);
  assert.ok(snapshot.sourceOffsetFloorMs > 500000);
  assert.equal(f.connects(), 1);
});

test('audition keeps the previous cumulative event and item limits unless phone is explicitly selected', async (t) => {
  const f = fixture(t, { usage: 'audition' });
  await f.start();
  for (let index = 0; index < 257; index += 1) f.source(index);
  assert.deepEqual(f.errors, ['LIVETRANSLATE_ITEM_CAPACITY']);
  const g = fixture(t, { usage: 'audition' });
  await g.start();
  for (let index = 0; index < 4096; index += 1)
    g.receive({ type: 'synthetic.extension' });
  assert.deepEqual(g.errors, ['LIVETRANSLATE_EVENT_CAPACITY']);
});

test('recent and tombstone-expired old UUID events cannot replay text, usage or audio', async (t) => {
  const f = fixture(t);
  await f.start();
  f.complete(0);
  const old = f.frames.slice(2).map((frame) => ({ ...frame }));
  for (let index = 1; index < 600; index += 1) f.complete(index);
  const before = [
    f.sources.length,
    f.translations.length,
    f.audio.length,
    f.usage.length,
  ];
  // No offsets: old UUIDs are unknown after bounded tombstones expire, not new speech.
  for (const frame of old.filter(
    (item) => !item.type.startsWith('input_audio_buffer.'),
  ))
    f.receive(frame);
  assert.deepEqual(
    [f.sources.length, f.translations.length, f.audio.length, f.usage.length],
    before,
  );
  for (const frame of old.filter((item) =>
    item.type.startsWith('input_audio_buffer.'),
  ))
    f.receive(frame);
  assert.deepEqual(
    [f.sources.length, f.translations.length, f.audio.length, f.usage.length],
    before,
  );
  f.complete(600);
  assert.equal(f.audio.length, before[2] + 1);
  assert.deepEqual(f.errors, []);
  assert.equal(f.connects(), 1);
});

test('early ASR/output waits for VAD start and a reliable edge, then streams before source final and response done', async (t) => {
  const f = fixture(t);
  await f.start();
  f.source(0, false, false);
  f.created(0);
  f.link(0);
  f.output(0, 'response.audio_transcript.delta', { delta: 'translation 0' });
  f.output(0, 'response.audio.delta', { delta: 'AQA=' });
  assert.equal(f.sources.length, 0);
  assert.equal(f.translations.length, 0);
  assert.equal(f.audio.length, 0);
  f.receive({
    type: 'input_audio_buffer.speech_started',
    item_id: 's_0',
    audio_start_ms: 0,
  });
  assert.equal(f.sources.length, 1);
  assert.equal(f.sources[0].final, false);
  assert.equal(f.translations.length, 1);
  assert.equal(f.audio.length, 1);
  assert.equal(f.client.retentionSnapshot!().activeResponses, 1);
  assert.equal(
    f.timing.some((item) => item.stage === 'response_completed'),
    false,
  );
  f.receive({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 's_0',
    content_index: 0,
    transcript: 'synthetic final',
  });
  f.receive({
    type: 'input_audio_buffer.speech_stopped',
    item_id: 's_0',
    audio_end_ms: 300,
  });
  f.output(0, 'response.audio_transcript.done', {
    transcript: 'translation 0',
  });
  f.output(0, 'response.audio.done');
  f.done(0);
  assert.deepEqual(f.errors, []);
});

test('multi-response source and FIFO-blocked terminal audio remain protected until delivered', async (t) => {
  const f = fixture(t);
  await f.start();
  f.source(0);
  f.created(0);
  f.link(0);
  f.created(1);
  f.link(1, 0);
  f.output(1, 'response.audio_transcript.done', {
    transcript: 'translation 1',
  });
  f.output(1, 'response.audio.delta', { delta: 'AgA=' });
  f.output(1, 'response.audio.done');
  f.done(1);
  f.source(2);
  assert.equal(f.audio.length, 0);
  assert.equal(f.client.retentionSnapshot!().activeSources, 2);
  assert.equal(f.client.retentionSnapshot!().activeResponses, 2);
  f.output(0, 'response.audio_transcript.done', {
    transcript: 'translation 0',
  });
  f.output(0, 'response.audio.delta', { delta: 'AQA=' });
  assert.equal(f.audio.length, 1);
  f.output(0, 'response.audio.done');
  f.done(0);
  assert.deepEqual(
    f.audio.map((item) => item.meta.responseId),
    ['r_0', 'r_1'],
  );
  assert.equal(f.client.retentionSnapshot!().activeSources, 2);
  assert.equal(f.client.retentionSnapshot!().activeResponses, 2);
  assert.deepEqual(f.errors, []);
});

test('active source overload stops once without deleting unresolved source protection', async (t) => {
  const f = fixture(t);
  await f.start();
  for (let index = 0; index < 257; index += 1)
    f.receive({
      type: 'input_audio_buffer.speech_started',
      item_id: `active_${index}`,
      audio_start_ms: index * 1000,
    });
  assert.deepEqual(f.errors, ['LIVETRANSLATE_ITEM_CAPACITY']);
  assert.equal(f.connects(), 1);
  assert.equal(f.wire.closes, 1);
  assert.throws(() => f.client.append(Buffer.alloc(640)), /ITEM_CAPACITY/u);
});

test('active event overload fails closed instead of evicting an old audio event and playing it twice', async (t) => {
  const f = fixture(t);
  await f.start();
  f.source(0);
  f.created(0);
  f.link(0);
  for (let index = 0; index < 4100; index += 1)
    f.output(0, 'response.audio.delta', { delta: 'AQA=' });
  assert.deepEqual(f.errors, ['LIVETRANSLATE_EVENT_CAPACITY']);
  const count = f.audio.length;
  f.receive(f.frames.find((item) => item.type === 'response.audio.delta'));
  assert.equal(f.audio.length, count);
  assert.equal(f.connects(), 1);
});

test('missing source anchor reports a fixed unsupported binding diagnosis and closes; quiet ready phone has no total timer', async (t) => {
  const f = fixture(t, { timeoutMs: 10 });
  await f.start();
  await delay(25);
  assert.deepEqual(f.errors, []);
  assert.equal(f.wire.closes, 0);
  f.source(0, false);
  await delay(25);
  assert.deepEqual(f.errors, ['LIVETRANSLATE_SOURCE_ANCHOR_MISSING']);
  assert.equal(f.sources.length, 0);
  assert.equal(f.audio.length, 0);
  assert.equal(f.wire.closes, 1);
  assert.equal(f.connects(), 1);
});

test('abort immediately fences pending and future supplier frames without reconnect or extra input', async (t) => {
  const f = fixture(t, { timeoutMs: 10 });
  await f.start();
  f.source(0, false);
  f.client.abort();
  const sends = f.wire.sent.length;
  f.receive({
    type: 'input_audio_buffer.speech_started',
    item_id: 's_0',
    audio_start_ms: 0,
  });
  await delay(25);
  assert.equal(f.sources.length, 0);
  assert.equal(f.audio.length, 0);
  assert.deepEqual(f.errors, []);
  assert.equal(f.wire.sent.length, sends);
  assert.equal(f.wire.closes, 1);
  assert.equal(f.connects(), 1);
});

test('phone local Andre/Tina metadata policy remains narrow and remote cannot inherit it', async (t) => {
  const f = fixture(t);
  await f.start();
  f.complete(0);
  assert.equal(f.audio[0].meta.voiceContext.requestedVoice, 'Andre');
  assert.equal(
    f.audio[0].meta.voiceContext.policyMode,
    'approved_andre_tina_metadata_conflict',
  );
  assert.throws(
    () =>
      fixture(t, {
        role: 'remote',
        voice: 'Andre',
        allowAndreTopLevelWithTinaOutput: true,
      }),
    /CONFIG_INVALID/u,
  );
  const remote = fixture(t, {
    role: 'remote',
    allowAndreTopLevelWithTinaOutput: false,
  });
  await remote.start();
  remote.source(0);
  remote.receive({
    type: 'response.created',
    response: { id: 'remote_r', voice: 'Tina', status: 'in_progress' },
  });
  assert.deepEqual(remote.errors, ['LIVETRANSLATE_CONFIGURATION_REJECTED']);
});

test('remote text-only phone also retains a bounded long session without generating Chinese audio', async (t) => {
  const f = fixture(t, {
    role: 'remote',
    allowAndreTopLevelWithTinaOutput: false,
  });
  await f.start();
  for (let index = 0; index < 600; index += 1) f.complete(index);
  assert.ok(f.frames.length > 4096);
  assert.deepEqual(f.errors, []);
  assert.equal(f.sources.length, 600);
  assert.equal(f.usage.length, 600);
  assert.equal(f.audio.length, 0);
  const snapshot = f.client.retentionSnapshot!();
  assert.equal(snapshot.activeSources, 32);
  assert.equal(snapshot.activeResponses, 32);
  assert.ok(
    snapshot.retainedEventIds < 32 && snapshot.terminalIdentifiers <= 1024,
  );
});
test('finish cannot convert fully received output with a missing source offset into silent success', async (t) => {
  const f = fixture(t);
  await f.start();
  f.source(0, false);
  f.created(0);
  f.link(0);
  f.output(0, 'response.audio_transcript.done', {
    transcript: 'translation 0',
  });
  f.output(0, 'response.audio.delta', { delta: 'AQA=' });
  f.output(0, 'response.audio.done');
  f.done(0);
  const finished = f.client.finish();
  f.receive({ type: 'session.finished' });
  await assert.rejects(finished, /SOURCE_ANCHOR_MISSING/u);
  assert.deepEqual(f.errors, ['LIVETRANSLATE_SOURCE_ANCHOR_MISSING']);
  assert.equal(f.audio.length, 0);
});

test('completed unpaired empty noise does not accumulate a hidden item or event call limit', async (t) => {
  const f = fixture(t);
  await f.start();
  for (let index = 0; index < 600; index += 1) {
    f.created(index);
    f.output(index, 'response.audio_transcript.done', { transcript: '' });
    f.receive({
      type: 'response.done',
      response: {
        id: `r_${index}`,
        voice: 'Andre',
        status: 'completed',
        output: [{ id: `t_${index}`, content: [] }],
      },
    });
  }
  assert.deepEqual(f.errors, []);
  assert.equal(f.audio.length, 0);
  const snapshot = f.client.retentionSnapshot!();
  assert.equal(snapshot.activeResponses, 0);
  assert.equal(snapshot.activeTranslations, 0);
  assert.ok(snapshot.retainedEventIds < 5);
  assert.equal(snapshot.terminalIdentifiers, 1024);
});

test('32 completed-source grace accepts a reliable late second response without replay or overwrite, then rejects new edges after retirement', async (t) => {
  const f = fixture(t);
  await f.start();
  f.complete(0);
  const oldAudio = f.frames.find(
    (event) => event.type === 'response.audio.delta',
  );
  f.source(1);
  f.created(100);
  f.link(100, 0);
  f.output(100, 'response.audio_transcript.done', {
    transcript: 'translation 100',
  });
  f.output(100, 'response.audio.delta', { delta: 'ZAA=' });
  f.output(100, 'response.audio.done');
  f.done(100);
  assert.deepEqual(
    f.audio.map((item) => item.meta.responseId),
    ['r_0', 'r_100'],
  );
  assert.equal(
    f.sources.filter((source) => source.sourceId === 's_0').length,
    1,
  );
  assert.equal(
    f.translations.findLast((item) => item.translationId === 't_0').text,
    'translation 0',
  );
  assert.equal(
    f.translations.findLast((item) => item.translationId === 't_100').text,
    'translation 100',
  );
  f.receive(oldAudio);
  assert.equal(f.audio.length, 2);
  // Complete enough distinct sources to exceed the32-group terminal grace.
  for (let index = 1; index <= 32; index += 1) f.complete(index);
  assert.equal(f.client.retentionSnapshot!().activeSources, 32);
  assert.equal(f.client.retentionSnapshot!().sourceOffsetFloorMs, 300);
  const before = f.audio.length;
  f.receive({
    type: 'conversation.item.created',
    previous_item_id: 's_0',
    item: { id: 'late_user_bookkeeping', role: 'user' },
  });
  assert.deepEqual(f.errors, []);
  f.link(101, 0);
  assert.deepEqual(f.errors, ['LIVETRANSLATE_SOURCE_RETIRED']);
  f.created(101);
  f.output(101, 'response.audio.delta', { delta: 'AQA=' });
  assert.equal(f.audio.length, before);
  assert.equal(f.connects(), 1);
});
