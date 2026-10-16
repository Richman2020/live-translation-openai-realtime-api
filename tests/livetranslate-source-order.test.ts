import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type WebSocket from 'ws';

import {
  createLiveTranslateClient,
  LIVE_TRANSLATE_MODEL,
} from '../src/experiments/livetranslate-client';
import type { LiveTranslateClientOptions } from '../src/experiments/livetranslate-types';

const repository = fileURLToPath(new URL('../', import.meta.url));
const baseline = 'e31ceb45d515c6fd93c8baff2761aec7949f18a8';

class MockSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  send(_raw: string, callback?: (error?: Error) => void) {
    callback?.();
  }
  close() {
    this.readyState = 3;
    this.emit('close', 1000);
  }
  terminate() {
    this.close();
  }
}

async function fixture(
  t: TestContext,
  role: 'local' | 'remote' = 'local',
  factory = createLiveTranslateClient,
) {
  const socket = new MockSocket();
  const audio: { source?: string; sample: number; sequence: number }[] = [];
  const text: { source?: string; text: string; final: boolean }[] = [];
  const errors: string[] = [];
  const originals: unknown[] = [];
  let event = 0;
  const client = factory({
    enabled: true,
    usage: 'phone',
    role,
    voice: role === 'local' ? 'Andre' : 'Tina',
    workspaceId: 'offline-order-workspace',
    apiKey: 'SYNTHETIC_UNUSED_ORDER_CREDENTIAL',
    createWebSocket: () => socket as unknown as WebSocket,
    onAudio: (pcm, meta) =>
      audio.push({
        source: meta.sourceId,
        sample: pcm.readInt16LE(0),
        sequence: meta.sequence,
      }),
    onTranslation: (item) =>
      text.push({ source: item.sourceId, text: item.text, final: item.final }),
    onSource: (source) => originals.push(source),
    onError: (code) => errors.push(code),
  } satisfies LiveTranslateClientOptions);
  t.after(() => client.abort());
  const receive = (value: Record<string, unknown>) =>
    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({ event_id: `synthetic_order_${++event}`, ...value }),
      ),
      false,
    );
  const session = {
    id: `synthetic_${role}`,
    model: LIVE_TRANSLATE_MODEL,
    output_modalities: role === 'local' ? ['text', 'audio'] : ['text'],
    enable_voice_clone: false,
    audio: {
      input: {
        format: { type: 'pcm', sample_rate: 16000 },
        turn_detection: { type: 'speaker_detection', threshold: 0.5 },
      },
      output: {
        format: { type: 'pcm', sample_rate: 24000 },
        voice: role === 'local' ? 'Andre' : 'Tina',
      },
    },
    translation: { language: role === 'local' ? 'en' : 'zh' },
  };
  receive({ type: 'session.created', session });
  receive({ type: 'session.updated', session });
  await client.ready;
  const vad = (id: string, start: number, stopped = true) => {
    receive({
      type: 'input_audio_buffer.speech_started',
      item_id: id,
      audio_start_ms: start,
    });
    if (stopped)
      receive({
        type: 'input_audio_buffer.speech_stopped',
        item_id: id,
        audio_end_ms: start + 100,
      });
  };
  const asr = (id: string, value = `Synthetic raw ${id}.`) =>
    receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: id,
      content_index: 0,
      transcript: value,
    });
  const source = (id: string, start: number, value?: string) => {
    vad(id, start);
    asr(id, value);
  };
  const created = (id: string) =>
    receive({
      type: 'response.created',
      response: { id, status: 'in_progress' },
    });
  const link = (id: string, sourceId: string) =>
    receive({
      type: 'conversation.item.created',
      previous_item_id: sourceId,
      item: { id, role: 'assistant', content: [] },
    });
  const delta = (
    id: string,
    item: string,
    type: string,
    value: Record<string, unknown> = {},
    eventId?: string,
  ) =>
    receive({
      type,
      response_id: id,
      item_id: item,
      content_index: 0,
      output_index: 0,
      ...value,
      ...(eventId ? { event_id: eventId } : {}),
    });
  const translated = (id: string, item: string, value: string) =>
    delta(
      id,
      item,
      role === 'local'
        ? 'response.audio_transcript.done'
        : 'response.text.done',
      role === 'local' ? { transcript: value } : { text: value },
    );
  const chunk = (
    id: string,
    item: string,
    sample: number,
    eventId?: string,
  ) => {
    const pcm = Buffer.alloc(2);
    pcm.writeInt16LE(sample);
    delta(
      id,
      item,
      'response.audio.delta',
      { delta: pcm.toString('base64') },
      eventId,
    );
  };
  const audioDone = (id: string, item: string) =>
    delta(id, item, 'response.audio.done');
  const done = (id: string, item?: string, value = '') =>
    receive({
      type: 'response.done',
      response: {
        id,
        status: 'completed',
        output: item
          ? [
              {
                id: item,
                content: value
                  ? [
                      role === 'local'
                        ? { type: 'audio', transcript: value }
                        : { type: 'text', text: value },
                    ]
                  : [],
              },
            ]
          : [],
      },
    });
  const complete = (sourceId: string, sample: number, suffix = '') => {
    const id = `response_${sourceId}${suffix}`,
      item = `output_${sourceId}${suffix}`,
      value = `Synthetic translated ${sourceId}${suffix}.`;
    created(id);
    link(item, sourceId);
    translated(id, item, value);
    if (role === 'local') {
      chunk(id, item, sample);
      audioDone(id, item);
    }
    done(id, item, value);
  };
  return {
    client,
    socket,
    receive,
    audio,
    text,
    errors,
    originals,
    vad,
    asr,
    source,
    created,
    link,
    delta,
    translated,
    chunk,
    audioDone,
    done,
    complete,
  };
}

test('synthetic source inversion runs the exact immutable e31 implementation; it is not captured incident replay', async (t) => {
  const directory = mkdtempSync(join(repository, '.offline-order-e31-'));
  try {
    const oldSource = execFileSync(
      'git',
      ['show', `${baseline}:src/experiments/livetranslate-client.ts`],
      { cwd: repository, encoding: 'utf8' },
    );
    const oldTypes = execFileSync(
      'git',
      ['show', `${baseline}:src/experiments/livetranslate-types.ts`],
      { cwd: repository, encoding: 'utf8' },
    );
    const helper = pathToFileURL(
      join(repository, 'src/solo/openai-websocket.ts'),
    ).href;
    writeFileSync(
      join(directory, 'livetranslate-client.ts'),
      oldSource
        .replace("'../solo/openai-websocket'", `'${helper}'`)
        .replaceAll("'./livetranslate-types'", "'./livetranslate-types.ts'"),
    );
    writeFileSync(join(directory, 'livetranslate-types.ts'), oldTypes);
    const legacy = await import(
      pathToFileURL(join(directory, 'livetranslate-client.ts')).href
    );
    const f = await fixture(t, 'local', legacy.createLiveTranslateClient);
    f.source('A', 100);
    f.source('B', 800);
    f.complete('B', 222);
    f.complete('A', 111);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(
      f.audio.map((item) => item.source),
      ['B', 'A'],
    );
    assert.deepEqual(
      [
        ...new Set(
          f.text.filter((item) => item.text).map((item) => item.source),
        ),
      ],
      ['B', 'A'],
    );
    f.client.abort();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const role of ['local', 'remote'] as const) {
  test(`${role}: known A then B survives reversed responses with source-ordered text and audio`, async (t) => {
    const f = await fixture(t, role);
    f.source('A', 100);
    f.source('B', 800);
    f.complete('B', 222);
    assert.equal(
      f.text.some((item) => item.text),
      false,
    );
    assert.equal(f.audio.length, 0);
    f.complete('A', 111);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(
      [
        ...new Set(
          f.text.filter((item) => item.text).map((item) => item.source),
        ),
      ],
      ['A', 'B'],
    );
    assert.deepEqual(
      f.audio.map((item) => item.source),
      role === 'local' ? ['A', 'B'] : [],
    );
    assert.deepEqual(
      f.audio.map((item) => item.sequence),
      role === 'local' ? [1, 2] : [],
    );
  });
}

test('current source audio streams before ASR final/VAD stop and supports multiple responses', async (t) => {
  const f = await fixture(t);
  f.vad('A', 100, false);
  f.created('r1');
  f.link('t1', 'A');
  f.translated('r1', 't1', 'First.');
  f.chunk('r1', 't1', 111);
  assert.equal(
    f.audio.length,
    1,
    'first chunk must not wait for long-source ASR final',
  );
  f.audioDone('r1', 't1');
  f.done('r1', 't1', 'First.');
  f.complete('A', 112, '_second');
  assert.deepEqual(
    f.audio.map((item) => item.sample),
    [111, 112],
  );
  assert.deepEqual(f.errors, []);
});

test('same-source earlier unknown response cannot be bypassed by a later bound response', async (t) => {
  const f = await fixture(t);
  f.source('A', 100);
  f.created('r_unknown');
  f.complete('A', 222, '_later');
  assert.equal(f.audio.length, 0);
  assert.equal(
    f.text.some((item) => item.text),
    false,
  );
  f.link('t_unknown', 'A');
  f.translated('r_unknown', 't_unknown', 'Earlier.');
  f.chunk('r_unknown', 't_unknown', 111);
  f.audioDone('r_unknown', 't_unknown');
  f.done('r_unknown', 't_unknown', 'Earlier.');
  assert.deepEqual(
    f.audio.map((item) => item.sample),
    [111, 222],
  );
  assert.deepEqual(f.errors, []);
});

test('earlier legal empty response releases a held response without guessing source identity', async (t) => {
  const f = await fixture(t);
  f.source('A', 100);
  f.created('empty');
  f.complete('A', 111);
  assert.equal(f.audio.length, 0);
  f.done('empty');
  assert.deepEqual(
    f.audio.map((item) => item.sample),
    [111],
  );
  assert.deepEqual(f.errors, []);
});

test('empty response cannot stand in for missing A translation or excuse nonempty local text without audio', async (t) => {
  const f = await fixture(t);
  f.source('A', 100);
  f.source('B', 800);
  f.created('empty');
  f.done('empty');
  f.complete('B', 222);
  assert.equal(f.audio.length, 0);
  assert.equal(
    f.text.some((item) => item.text),
    false,
  );
  const g = await fixture(t);
  g.source('A', 100);
  g.created('r');
  g.link('t', 'A');
  g.translated('r', 't', 'Missing audio.');
  g.done('r', 't', 'Missing audio.');
  assert.deepEqual(g.errors, ['LIVETRANSLATE_RESPONSE_AUDIO_MISSING']);
});

test('an explicitly final empty raw source advances without fabricated speech', async (t) => {
  const f = await fixture(t);
  f.source('empty_source', 100, '');
  f.source('B', 800);
  f.complete('B', 222);
  assert.deepEqual(
    f.audio.map((item) => item.source),
    ['B'],
  );
  assert.deepEqual(f.errors, []);
});

test('source ordering deadline starts only when arrived output is blocked and is cleared by progress', async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.source('A', 100);
  t.mock.timers.tick(20000);
  assert.deepEqual(f.errors, []);
  f.source('B', 800);
  f.complete('B', 222);
  t.mock.timers.tick(4999);
  assert.deepEqual(f.errors, []);
  f.complete('A', 111);
  t.mock.timers.tick(6000);
  assert.deepEqual(
    f.audio.map((item) => item.source),
    ['A', 'B'],
  );
  assert.deepEqual(f.errors, []);
});

test('sustained blocked output fails once at 5 seconds and abort clears held audio/timer', async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.source('A', 100);
  f.source('B', 800);
  f.complete('B', 222);
  t.mock.timers.tick(5000);
  assert.deepEqual(f.errors, ['LIVETRANSLATE_SOURCE_ORDER_TIMEOUT']);
  assert.equal(f.audio.length, 0);
  t.mock.timers.tick(20000);
  assert.equal(f.errors.length, 1);
  const g = await fixture(t);
  g.source('A', 100);
  g.source('B', 800);
  g.complete('B', 222);
  g.client.abort();
  t.mock.timers.tick(5000);
  g.complete('A', 111);
  assert.deepEqual(g.errors, []);
  assert.equal(g.audio.length, 0);
});

test('unknown earlier response has a bounded ordering wait rather than indefinite suspension', async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.source('A', 100);
  f.created('unknown');
  f.complete('A', 111);
  t.mock.timers.tick(5000);
  assert.deepEqual(f.errors, ['LIVETRANSLATE_SOURCE_ORDER_TIMEOUT']);
  assert.equal(f.audio.length, 0);
});

test('a newly blocked item does not inherit an older resolved item deadline', async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.source('A', 100);
  f.source('B', 800);
  f.complete('B', 222);
  t.mock.timers.tick(4990);
  f.complete('A', 111);
  f.source('C', 1600);
  f.created('unknown');
  f.complete('C', 333);
  t.mock.timers.tick(20);
  assert.deepEqual(f.errors, []);
  f.done('unknown');
  assert.deepEqual(
    f.audio.map((item) => item.source),
    ['A', 'B', 'C'],
  );
  t.mock.timers.tick(6000);
  assert.deepEqual(f.errors, []);
});

test('new old-source response fails visibly after frontier advance but completed duplicates never replay', async (t) => {
  const f = await fixture(t);
  f.source('A', 100);
  f.source('B', 800);
  f.complete('A', 111);
  f.complete('B', 222);
  f.delta('response_A', 'output_A', 'response.audio.delta', {
    delta: Buffer.from([111, 0]).toString('base64'),
  });
  assert.deepEqual(f.errors, []);
  assert.equal(f.audio.length, 2);
  f.complete('A', 113, '_late');
  assert.deepEqual(f.errors, ['LIVETRANSLATE_SOURCE_ORDER_STALE']);
  assert.deepEqual(
    f.audio.map((item) => item.sample),
    [111, 222],
  );
});

test('silence, genuine repeated sentences, revisions and late completion keep source identity over multiple rounds', async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (let round = 0; round < 3; round += 1) {
    const a = `A${round}`,
      b = `B${round}`;
    f.source(a, round * 2000 + 100, 'I really repeat this.');
    f.source(b, round * 2000 + 800, 'I really repeat this.');
    f.complete(b, 220 + round);
    f.complete(a, 110 + round);
    t.mock.timers.tick(8000);
  }
  assert.deepEqual(f.errors, []);
  assert.deepEqual(
    f.audio.map((item) => item.source),
    ['A0', 'B0', 'A1', 'B1', 'A2', 'B2'],
  );
  assert.equal(f.originals.length, 6);
});
