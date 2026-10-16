/* eslint-disable no-await-in-loop -- Each mocked phone session is checked serially. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, type TestContext } from 'node:test';
import WebSocket from 'ws';

import {
  createLiveTranslateClient,
  LIVE_TRANSLATE_MODEL,
} from '../src/experiments/livetranslate-client';

/**
 * Evidence boundary: the successful B28 capture contains an assistant/message /
 * in_progress source item with content:[{type:'input_audio'}], and an assistant
 * output item with empty content and previous_item_id pointing to that source.
 * Those two shapes are represented below without copying audio, transcript or
 * supplier identifiers. Every later turn, previous-item edge, reordering and
 * conflict in this file is synthetic. The failing real phone call's raw supplier
 * frames were not retained; these tests are not a replay of that missing frame.
 */
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

function fixture(t: TestContext, role: 'local' | 'remote' = 'local') {
  const wire = new Wire();
  const errors: string[] = [];
  const sources: any[] = [];
  const translations: any[] = [];
  const associations: any[] = [];
  const audio: any[] = [];
  const diagnostics: any[] = [];
  let serial = 0;
  let connects = 0;
  const voice = role === 'local' ? 'Andre' : 'Tina';
  const client = createLiveTranslateClient({
    enabled: true,
    usage: 'phone',
    role,
    voice,
    workspaceId: 'offline-classification',
    apiKey: 'SYNTHETIC_OFFLINE_NEVER_SENT',
    onSource: (event) => sources.push(event),
    onTranslation: (event) => translations.push(event),
    onAssociation: (event) => associations.push(event),
    onAudio: (pcm, metadata) => audio.push({ pcm, metadata }),
    onError: (code) => errors.push(code),
    onProtocolDiagnostic: (event) => diagnostics.push(event),
    createWebSocket() {
      connects += 1;
      return wire as unknown as WebSocket;
    },
  });
  t.after(() => client.abort());
  function receive(frame: any) {
    serial += 1;
    const event = { event_id: `mock_event_${serial}`, ...frame };
    wire.emit('message', Buffer.from(JSON.stringify(event)), false);
    return event;
  }
  async function start() {
    const session = {
      id: `mock_session_${role}`,
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
          voice,
        },
      },
      translation: { language: role === 'local' ? 'en' : 'zh' },
    };
    receive({ type: 'session.created', session });
    receive({ type: 'session.updated', session });
    await client.ready;
  }
  function createdItem(id: string, previous?: string, input = false) {
    return receive({
      type: 'conversation.item.created',
      ...(previous ? { previous_item_id: previous } : {}),
      item: {
        id,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: input ? [{ type: 'input_audio' }] : [],
      },
    });
  }
  function vad(id: string, offset: number) {
    receive({
      type: 'input_audio_buffer.speech_started',
      item_id: id,
      audio_start_ms: offset,
      speaker_id: 0,
    });
    receive({
      type: 'input_audio_buffer.speech_stopped',
      item_id: id,
      audio_end_ms: offset + 300,
    });
  }
  function asr(id: string, text = '离线合成原文。') {
    receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: id,
      content_index: 0,
      transcript: text,
    });
  }
  function response(id: string) {
    receive({
      type: 'response.created',
      response: { id, voice, status: 'in_progress' },
    });
  }
  function output(
    id: string,
    responseId: string,
    type: string,
    patch: any = {},
  ) {
    return receive({
      type,
      item_id: id,
      response_id: responseId,
      output_index: 0,
      content_index: 0,
      ...patch,
    });
  }
  function complete(
    id: string,
    responseId: string,
    text = 'Synthetic translation.',
  ) {
    output(
      id,
      responseId,
      role === 'local'
        ? 'response.audio_transcript.done'
        : 'response.text.done',
      role === 'local' ? { transcript: text } : { text },
    );
    if (role === 'local') {
      output(id, responseId, 'response.audio.delta', {
        delta: Buffer.from([1, 0, 2, 0]).toString('base64'),
      });
      output(id, responseId, 'response.audio.done');
    }
    receive({
      type: 'response.done',
      response: {
        id: responseId,
        status: 'completed',
        voice,
        output: [
          {
            id,
            content: [
              role === 'local'
                ? { type: 'audio', transcript: text }
                : { type: 'text', text },
            ],
          },
        ],
      },
    });
  }
  return {
    client,
    wire,
    receive,
    start,
    createdItem,
    vad,
    asr,
    response,
    output,
    complete,
    errors,
    sources,
    translations,
    associations,
    audio,
    diagnostics,
    connects: () => connects,
  };
}

test('B28 source structure plus synthetic second-turn predecessor never classifies input_audio as output', async (t) => {
  const f = fixture(t);
  await f.start();
  f.createdItem('s1', undefined, true);
  f.vad('s1', 0);
  f.asr('s1');
  f.response('r1');
  f.createdItem('t1', 's1');
  f.complete('t1', 'r1');
  assert.deepEqual(f.errors, []);
  f.vad('s3', 1000);
  // B28 has no second turn: this predecessor is explicitly synthetic.
  f.createdItem('s3', 't1', true);
  f.asr('s3', '不是十五号，是十六号。');
  f.response('r3');
  f.createdItem('t3', 's3');
  f.complete('t3', 'r3', 'Not the fifteenth; the sixteenth.');
  assert.deepEqual(f.errors, []);
  assert.deepEqual(
    f.audio.map((event) => event.metadata.sourceId),
    ['s1', 's3'],
  );
  assert.equal(f.translations.filter((event) => event.final).length, 2);
});

for (const order of [
  'created-vad-asr',
  'vad-created-asr',
  'asr-created-vad',
  'created-asr-vad',
]) {
  test(`synthetic input item with predecessor supports ${order}`, async (t) => {
    const f = fixture(t, 'remote');
    await f.start();
    for (const event of order.split('-')) {
      if (event === 'created')
        f.createdItem('source', 'previous_translation', true);
      if (event === 'vad') f.vad('source', 1000);
      if (event === 'asr') f.asr('source', 'Synthetic source.');
    }
    f.response('response');
    f.createdItem('translation', 'source');
    f.complete('translation', 'response', '合成译文。');
    assert.deepEqual(f.errors, []);
    assert.equal(f.associations.at(-1).sourceId, 'source');
    assert.equal(f.translations.at(-1).sourceId, 'source');
    assert.equal(f.translations.at(-1).final, true);
  });
}

test('unknown empty created item defers binding until positive output identity arrives', async (t) => {
  const f = fixture(t, 'remote');
  await f.start();
  f.vad('source', 1000);
  f.asr('source', 'Synthetic source.');
  f.createdItem('unknown', 'source');
  assert.equal(f.associations.length, 0);
  assert.equal(f.translations.length, 0);
  f.response('response');
  f.complete('unknown', 'response', '明确的合成译文。');
  assert.deepEqual(f.errors, []);
  assert.equal(f.associations.at(-1).sourceId, 'source');
  assert.equal(f.translations.at(-1).final, true);
});

test('unknown empty item can later become a VAD/ASR source without inheriting its predecessor as translation', async (t) => {
  const f = fixture(t, 'remote');
  await f.start();
  f.createdItem('source', 'previous_translation');
  f.vad('source', 1000);
  f.asr('source', 'This is a source, not its predecessor translation.');
  f.response('response');
  f.createdItem('translation', 'source');
  f.complete('translation', 'response', '这是原文。');
  assert.deepEqual(f.errors, []);
  assert.equal(f.associations.length, 1);
  assert.equal(f.associations[0].translationId, 'translation');
});

test('same-party continuation and alternating parties keep independent source/response ownership', async (t) => {
  const local = fixture(t, 'local');
  const remote = fixture(t, 'remote');
  await local.start();
  await remote.start();
  for (const [index, f] of [local, remote, local, local, remote].entries()) {
    const source = `source_${index}`;
    const output = `output_${index}`;
    const response = `response_${index}`;
    // A predecessor across the mock's global dialogue is not a source edge.
    f.createdItem(source, index ? `output_${index - 1}` : undefined, true);
    f.vad(source, index * 1000);
    f.asr(source, `Synthetic source ${index}.`);
    f.response(response);
    f.createdItem(output, source);
    f.complete(output, response, `Synthetic translation ${index}.`);
  }
  assert.deepEqual(local.errors, []);
  assert.deepEqual(remote.errors, []);
  assert.deepEqual(
    local.audio.map((event) => event.metadata.sourceId),
    ['source_0', 'source_2', 'source_3'],
  );
  assert.equal(remote.audio.length, 0);
  assert.equal(local.connects(), 1);
  assert.equal(remote.connects(), 1);
  assert(local.translations.every((event) => event.role === 'local'));
  assert(remote.translations.every((event) => event.role === 'remote'));
});

test('proven output cannot reuse an admitted source identity despite ambiguous created metadata', async (t) => {
  const f = fixture(t, 'remote');
  await f.start();
  f.vad('shared', 0);
  f.asr('shared', 'Synthetic source.');
  f.createdItem('shared', 'predecessor');
  assert.deepEqual(f.errors, []);
  f.response('r1');
  f.output('shared', 'r1', 'response.text.delta', { delta: '不应显示' });
  assert.equal(f.errors[0], 'LIVETRANSLATE_ITEM_CONFLICT');
  assert.equal(f.diagnostics[0].conflictKind, 'output_after_source');
  assert.equal(f.diagnostics[0].eventType, 'response.text.delta');
  assert(f.diagnostics[0].receiveSequence > 0);
  assert.equal(f.translations.length, 0);
});

test('proven output later claimed as input_audio or VAD remains a fatal identity conflict', async (t) => {
  for (const branch of ['input_audio', 'vad', 'asr']) {
    const f = fixture(t, 'remote');
    await f.start();
    f.response('r1');
    f.output('shared', 'r1', 'response.text.delta', { delta: '合成译文' });
    if (branch === 'input_audio') f.createdItem('shared', 'previous', true);
    if (branch === 'vad') f.vad('shared', 0);
    if (branch === 'asr') f.asr('shared', 'Synthetic source.');
    assert.equal(f.errors[0], 'LIVETRANSLATE_ITEM_CONFLICT', branch);
    assert.equal(
      f.diagnostics[0].conflictKind,
      {
        input_audio: 'created_input_after_output',
        vad: 'vad_after_output',
        asr: 'source_after_output',
      }[branch],
    );
    assert.equal(f.wire.closes, 1, branch);
  }
});

test('same response output slot cannot change item identity', async (t) => {
  const f = fixture(t, 'remote');
  await f.start();
  f.response('r1');
  f.output('t1', 'r1', 'response.text.delta', { delta: '一' });
  f.output('t2', 'r1', 'response.text.delta', { delta: '二' });
  assert.equal(f.errors[0], 'LIVETRANSLATE_ITEM_CONFLICT');
  assert.equal(f.diagnostics[0].conflictKind, 'response_slot_rebound');
});

test('an output item cannot move to another response', async (t) => {
  const f = fixture(t, 'remote');
  await f.start();
  f.response('r1');
  f.output('translation', 'r1', 'response.text.delta', { delta: '一' });
  f.response('r2');
  f.output('translation', 'r2', 'response.text.delta', { delta: '二' });
  assert.equal(f.errors[0], 'LIVETRANSLATE_ITEM_CONFLICT');
  assert.equal(f.diagnostics[0].conflictKind, 'output_response_rebound');
});

test('a completed summary cannot silently withdraw an observed output slot', async (t) => {
  const f = fixture(t, 'remote');
  await f.start();
  f.response('r1');
  f.output('output', 'r1', 'response.text.delta', { delta: '合成译文' });
  f.receive({
    type: 'response.done',
    response: { id: 'r1', status: 'completed', output: [] },
  });
  assert.equal(f.errors[0], 'LIVETRANSLATE_ITEM_CONFLICT');
  assert.equal(f.diagnostics[0].conflictKind, 'completed_output_missing');
  assert.equal(f.diagnostics[0].eventType, 'response.done');
  assert.equal(f.diagnostics[0].validationPath, 'response.output');
});

test('an output source cannot change after positive response output establishes the edge', async (t) => {
  const f = fixture(t, 'remote');
  await f.start();
  f.vad('s1', 0);
  f.asr('s1');
  f.vad('s2', 1000);
  f.asr('s2');
  f.response('r1');
  f.createdItem('translation', 's1');
  f.output('translation', 'r1', 'response.text.delta', { delta: '译文' });
  f.createdItem('translation', 's2');
  assert.equal(f.errors[0], 'LIVETRANSLATE_SOURCE_CONFLICT');
});

test('different output identities can legitimately share one admitted source', async (t) => {
  const f = fixture(t, 'remote');
  await f.start();
  f.vad('source', 0);
  f.asr('source');
  for (const index of [1, 2]) {
    f.response(`r${index}`);
    f.createdItem(`t${index}`, 'source');
    f.complete(`t${index}`, `r${index}`, `分段${index}`);
  }
  assert.deepEqual(f.errors, []);
  assert.equal(f.translations.filter((event) => event.final).length, 2);
  assert(f.associations.every((event) => event.sourceId === 'source'));
});

test('duplicate event envelopes never duplicate playback; silence and later input do not close the session', async (t) => {
  const f = fixture(t);
  await f.start();
  f.vad('s1', 0);
  f.asr('s1');
  f.response('r1');
  const created = f.createdItem('t1', 's1');
  f.receive(created);
  f.output('t1', 'r1', 'response.audio_transcript.done', {
    transcript: 'First.',
  });
  const chunk = f.output('t1', 'r1', 'response.audio.delta', {
    delta: Buffer.from([1, 0]).toString('base64'),
  });
  f.receive(chunk);
  f.output('t1', 'r1', 'response.audio.done');
  f.receive({
    type: 'response.done',
    response: {
      id: 'r1',
      status: 'completed',
      output: [
        { id: 't1', content: [{ type: 'audio', transcript: 'First.' }] },
      ],
    },
  });
  // A later VAD offset represents silence followed by renewed speech; no wall-clock delay is invented.
  f.createdItem('s2', 't1', true);
  f.vad('s2', 120000);
  f.asr('s2', '静音后继续。');
  f.response('r2');
  f.createdItem('t2', 's2');
  f.complete('t2', 'r2', 'Continuing after silence.');
  f.receive(chunk);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(
    f.audio.map((event) => event.metadata.sourceId),
    ['s1', 's2'],
  );
  assert.equal(f.connects(), 1);
  assert.equal(f.wire.closes, 0);
});

test('out-of-order created metadata resolves only its own source and abort fences every late event', async (t) => {
  const f = fixture(t);
  await f.start();
  f.response('r1');
  f.output('t1', 'r1', 'response.audio_transcript.done', {
    transcript: 'First.',
  });
  f.output('t1', 'r1', 'response.audio.delta', {
    delta: Buffer.from([1, 0]).toString('base64'),
  });
  assert.equal(f.audio.length, 0);
  f.createdItem('t1', 's1');
  f.createdItem('s1', 'earlier_output', true);
  f.asr('s1');
  assert.equal(f.audio.length, 0);
  f.vad('s1', 0);
  assert.deepEqual(f.errors, []);
  assert.equal(f.audio.length, 1);
  f.createdItem('pending', 'unseen_source');
  f.client.abort();
  const counts = [
    f.audio.length,
    f.translations.length,
    f.sources.length,
    f.associations.length,
  ];
  f.createdItem('unseen_source', 't1', true);
  f.vad('unseen_source', 1000);
  f.asr('unseen_source');
  f.response('late_response');
  f.output('pending', 'late_response', 'response.audio.delta', {
    delta: Buffer.from([3, 0]).toString('base64'),
  });
  assert.deepEqual(
    [
      f.audio.length,
      f.translations.length,
      f.sources.length,
      f.associations.length,
    ],
    counts,
  );
  assert.equal(f.connects(), 1);
  assert.equal(f.wire.closes, 1);
});

test('conflicting unknown predecessors do not taint an item later positively classified as input', async (t) => {
  const f = fixture(t, 'remote');
  await f.start();
  f.createdItem('source', 'old_predecessor');
  f.createdItem('source', 'different_predecessor');
  assert.deepEqual(f.errors, []);
  assert.equal(f.associations.length, 0);
  f.createdItem('source', 'third_predecessor', true);
  f.vad('source', 0);
  f.asr('source');
  f.response('r1');
  f.createdItem('translation', 'source');
  f.complete('translation', 'r1');
  assert.deepEqual(f.errors, []);
  assert.equal(f.associations.at(-1).sourceId, 'source');
});

test('conflicting unknown predecessors remain a source conflict when output identity is proved', async (t) => {
  const f = fixture(t);
  await f.start();
  f.vad('s1', 0);
  f.asr('s1');
  f.vad('s2', 1000);
  f.asr('s2');
  f.createdItem('output', 's1');
  f.createdItem('output', 's2');
  assert.deepEqual(f.errors, []);
  f.response('r1');
  f.output('output', 'r1', 'response.audio.delta', {
    delta: Buffer.from([1, 0]).toString('base64'),
  });
  assert.equal(f.errors[0], 'LIVETRANSLATE_SOURCE_CONFLICT');
  assert.equal(f.audio.length, 0);
  assert.equal(f.associations.length, 0);
  assert.equal(f.wire.closes, 1);
});

test('unknown metadata is bounded and positive input classification releases its slot', async (t) => {
  const f = fixture(t, 'remote');
  await f.start();
  for (let index = 0; index < 256; index += 1) {
    f.createdItem(`unknown_${index}`, 'unseen_source');
  }
  // Duplicate envelopes with new event IDs must update one metadata entry only.
  f.createdItem('unknown_1', 'unseen_source');
  assert.deepEqual(f.errors, []);
  f.createdItem('unknown_0', 'previous_output', true);
  f.createdItem('replacement_unknown', 'unseen_source');
  assert.deepEqual(f.errors, []);
  f.createdItem('overflow_unknown', 'unseen_source');
  assert.equal(f.errors[0], 'LIVETRANSLATE_ITEM_CAPACITY');
  assert.equal(f.associations.length, 0);
  assert.equal(f.audio.length, 0);
  assert.equal(f.wire.closes, 1);
  f.client.abort();
  f.createdItem('post_cleanup', 'unseen_source');
  f.response('post_cleanup_response');
  assert.equal(f.errors.length, 1);
  assert.equal(f.connects(), 1);
});

test('retired late created metadata cannot resurrect source or output ownership', async (t) => {
  const f = fixture(t, 'remote');
  await f.start();
  for (let index = 0; index < 40; index += 1) {
    f.createdItem(
      `source_${index}`,
      index ? `output_${index - 1}` : undefined,
      true,
    );
    f.vad(`source_${index}`, index * 1000);
    f.asr(`source_${index}`);
    f.response(`response_${index}`);
    f.createdItem(`output_${index}`, `source_${index}`);
    f.complete(`output_${index}`, `response_${index}`);
  }
  assert.deepEqual(f.errors, []);
  const counts = [
    f.sources.length,
    f.translations.length,
    f.associations.length,
  ];
  f.createdItem('source_0', 'late_different_predecessor', true);
  f.createdItem('output_0', 'source_39');
  f.asr('source_0', 'Late synthetic source.');
  f.output('output_0', 'response_0', 'response.text.delta', {
    delta: '迟到内容',
  });
  assert.deepEqual(
    [f.sources.length, f.translations.length, f.associations.length],
    counts,
  );
  assert.deepEqual(f.errors, []);
  f.createdItem('source_40', 'output_39', true);
  f.vad('source_40', 40000);
  f.asr('source_40');
  f.response('response_40');
  f.createdItem('output_40', 'source_40');
  f.complete('output_40', 'response_40');
  assert.deepEqual(f.errors, []);
  assert.equal(f.translations.filter((event) => event.final).length, 41);
});

test('first audio releases on proved binding before ASR final or full translation completes', async (t) => {
  const f = fixture(t);
  await f.start();
  f.createdItem('source', undefined, true);
  f.vad('source', 0);
  f.response('response');
  f.createdItem('output', 'source');
  assert.equal(f.audio.length, 0);
  assert.equal(f.sources.length, 0);
  f.output('output', 'response', 'response.audio.delta', {
    delta: Buffer.from([1, 0]).toString('base64'),
  });
  assert.deepEqual(f.errors, []);
  assert.equal(f.audio.length, 1);
  assert.equal(f.audio[0].metadata.sourceId, 'source');
  assert.equal(f.sources.length, 0);
  assert.equal(
    f.translations.some((event) => event.final),
    false,
  );
  f.asr('source', '较迟到达的原始识别。');
  assert.equal(f.sources.at(-1).final, true);
  assert.equal(f.audio.length, 1);
});
