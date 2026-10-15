/* eslint-disable no-await-in-loop -- Segments must be tested in playback order. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import WebSocket from 'ws';

import { createAliyunPlanBTts } from '../src/solo/aliyun-planb-tts';
import type {
  AliyunPlanBConfig,
  PlanBEvidence,
  PlanBUsage,
} from '../src/solo/aliyun-planb-types';

const config: AliyunPlanBConfig = {
  region: 'beijing',
  apiKey: 'test-only-not-a-real-key',
  asrModel: 'fun-asr-realtime',
  textModel: 'qwen-mt-flash',
  ttsModel: 'cosyvoice-v3-flash',
  voice: 'loongandy_v3',
  sampleRate: 24000,
  webSocketUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
  translationUrl:
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
};

class Socket extends EventEmitter {
  readyState = WebSocket.CONNECTING as number;

  sent: any[] = [];

  closeCount = 0;

  terminateCount = 0;

  send(raw: string, callback?: (error?: Error) => void) {
    this.sent.push(JSON.parse(raw));
    callback?.();
  }

  open() {
    this.readyState = WebSocket.OPEN;
    this.emit('open');
  }

  close(code: unknown = 1000, reason = Buffer.alloc(0)) {
    this.closeCount += 1;
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code, reason);
  }

  terminate() {
    this.terminateCount += 1;
    this.close();
  }

  message(event: string, payload: any = {}, id?: string, taskId?: string) {
    this.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          header: {
            event,
            task_id: taskId ?? this.sent[0]?.header.task_id,
            ...(id ? { event_id: id } : {}),
          },
          payload,
        }),
      ),
      false,
    );
  }

  audio(pcm = Buffer.from([1, 0, 2, 0])) {
    this.emit('message', pcm, true);
  }

  marker(index = 0, id?: string) {
    this.message(
      'result-generated',
      {
        output: { type: 'sentence-synthesis', sentence: { index, words: [] } },
      },
      id,
    );
  }
}

function fixture(region: 'beijing' | 'singapore' = 'beijing') {
  const sockets: Socket[] = [];
  const usages: PlanBUsage[] = [];
  const evidence: PlanBEvidence[] = [];
  const client = createAliyunPlanBTts({
    config: {
      ...config,
      region,
      webSocketUrl:
        region === 'beijing'
          ? config.webSocketUrl
          : 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference',
      translationUrl:
        region === 'beijing'
          ? config.translationUrl
          : 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
    },
    createWebSocket() {
      const socket = new Socket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    timeoutMs: 1000,
    onUsage: (usage) => usages.push(usage),
    onEvidence: (event) => evidence.push(event),
  });
  return { client, sockets, usages, evidence };
}

test('CosyVoice run/continue/finish share one UUID and explicitly fix English PCM voice', async () => {
  const { client, sockets, usages } = fixture();
  const stream = client.synthesize('It is 25 yuan, not 250 yuan.', 1);
  const first = stream[Symbol.asyncIterator]();
  const pending = first.next();
  const socket = sockets[0];
  socket.open();
  socket.message('task-started');
  socket.message('task-started');
  assert.equal(socket.sent.length, 3);
  const run = socket.sent[0];
  assert.equal(run.header.action, 'run-task');
  assert.match(run.header.task_id, /^[\da-f-]{36}$/);
  assert.equal(run.payload.model, 'cosyvoice-v3-flash');
  assert.equal(run.payload.function, 'SpeechSynthesizer');
  assert.deepEqual(run.payload.parameters, {
    text_type: 'PlainText',
    voice: 'loongandy_v3',
    format: 'pcm',
    sample_rate: 24000,
    language_hints: ['en'],
  });
  assert.equal(
    socket.sent[1].payload.input.text,
    'It is 25 yuan, not 250 yuan.',
  );
  assert.equal(socket.sent[1].header.task_id, run.header.task_id);
  assert.equal(socket.sent[2].header.task_id, run.header.task_id);
  assert.deepEqual(socket.sent[2].payload.input, {});
  socket.marker();
  socket.audio();
  socket.message('result-generated', {
    output: { type: 'sentence-end', sentence: { index: 0 } },
    usage: { characters: 27 },
  });
  socket.message('task-finished', { usage: { characters: 27 } });
  assert.deepEqual((await pending).value, Buffer.from([1, 0, 2, 0]));
  assert.equal((await first.next()).done, true);
  assert.equal(usages.length, 1);
  assert.equal(usages[0].characters, 27);
  assert.equal(socket.closeCount, 1);
  assert.equal(sockets.length, 1);
});

test('sequential segments create distinct tasks with the same voice; stale old binary cannot mix', async () => {
  const { client, sockets } = fixture();
  for (const sequence of [1, 2]) {
    const iterator = client
      .synthesize(`Sentence ${sequence}.`, sequence)
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    const socket = sockets.at(-1)!;
    socket.open();
    socket.message('task-started');
    if (sequence === 2) {
      sockets[0].audio(Buffer.from([9, 0]));
      socket.message(
        'task-started',
        {},
        undefined,
        sockets[0].sent[0].header.task_id,
      );
    }
    socket.marker();
    socket.audio(Buffer.from([sequence, 0]));
    socket.message('task-finished');
    assert.deepEqual((await pending).value, Buffer.from([sequence, 0]));
    assert.equal((await iterator.next()).done, true);
  }
  assert.notEqual(
    sockets[0].sent[0].header.task_id,
    sockets[1].sent[0].header.task_id,
  );
  assert.equal(sockets[1].sent[0].payload.parameters.voice, 'loongandy_v3');
});

test('duplicate tagged event is ignored; unbound binary fails rather than plays twice', async () => {
  const { client, sockets } = fixture();
  const iterator = client.synthesize('Hello.', 1)[Symbol.asyncIterator]();
  const pending = iterator.next();
  const socket = sockets[0];
  socket.open();
  socket.message('task-started');
  socket.marker(0, 'synthesis-1');
  socket.marker(0, 'synthesis-1');
  socket.audio();
  assert.equal((await pending).done, false);
  const next = iterator.next();
  socket.audio();
  await assert.rejects(next, /PLANB_TTS_AUDIO_UNBOUND/);
  assert.equal(sockets.length, 1);
});

for (const region of ['beijing', 'singapore'] as const) {
  test(`${region} cancellation fences audio and uses only officially supported cancel`, async () => {
    const { client, sockets, usages } = fixture(region);
    const controller = new AbortController();
    const iterator = client
      .synthesize('Hello.', 1, controller.signal)
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    const socket = sockets[0];
    socket.open();
    socket.message('task-started');
    controller.abort();
    const sends = socket.sent.length;
    socket.marker();
    socket.audio();
    socket.message('task-started');
    socket.message('task-finished', { usage: { characters: 100 } });
    await assert.rejects(pending, /PLANB_TTS_CANCELLED/);
    assert.equal(socket.sent.length, sends);
    const cancellations = socket.sent.filter(
      (sent) => sent.payload.input.directive === 'cancel',
    );
    assert.equal(cancellations.length, region === 'beijing' ? 1 : 0);
    assert.equal(socket.closeCount, 1);
    assert.equal(usages.length, 1);
    assert.equal(usages[0].basis, 'unknown');
  });
}

test('abort shuts down active client and forbids another task', async () => {
  const { client, sockets } = fixture();
  const iterator = client.synthesize('Hello.', 1)[Symbol.asyncIterator]();
  const pending = iterator.next();
  sockets[0].open();
  sockets[0].message('task-started');
  client.abort();
  await assert.rejects(pending, /PLANB_TTS_CANCELLED/);
  await assert.rejects(
    client.synthesize('Another.', 2)[Symbol.asyncIterator]().next(),
    /PLANB_TTS_CANCELLED/,
  );
  assert.equal(sockets.length, 1);
});

test('English-only TTS and missing key fail before any socket is opened', async () => {
  const { client, sockets } = fixture();
  await assert.rejects(
    client.synthesize('中文不能合成。', 1)[Symbol.asyncIterator]().next(),
    /PLANB_TTS_INPUT_INVALID/,
  );
  assert.equal(sockets.length, 0);
  let calls = 0;
  const noKey = createAliyunPlanBTts({
    config: { ...config, apiKey: '' },
    createWebSocket() {
      calls += 1;
      throw new Error('must not connect');
    },
  });
  await assert.rejects(
    noKey.synthesize('Hello.', 1)[Symbol.asyncIterator]().next(),
    /PLANB_KEY_REQUIRED/,
  );
  assert.equal(calls, 0);
});

test('duplicate sequence and concurrent synthesis do not open or submit a second task', async () => {
  const { client, sockets } = fixture();
  const iterator = client.synthesize('Hello.', 1)[Symbol.asyncIterator]();
  const pending = iterator.next();
  await assert.rejects(
    client.synthesize('Other.', 2)[Symbol.asyncIterator]().next(),
    /PLANB_TTS_ALREADY_ACTIVE/,
  );
  sockets[0].open();
  sockets[0].message('task-started');
  sockets[0].marker();
  sockets[0].audio();
  sockets[0].message('task-finished');
  await pending;
  await iterator.next();
  await assert.rejects(
    client.synthesize('Duplicate.', 1)[Symbol.asyncIterator]().next(),
    /PLANB_TTS_INPUT_INVALID/,
  );
  assert.equal(sockets.length, 1);
});

test('provider error text is never exposed and no reconnect is attempted', async () => {
  const { client, sockets } = fixture();
  const iterator = client.synthesize('Hello.', 1)[Symbol.asyncIterator]();
  const pending = iterator.next();
  sockets[0].open();
  sockets[0].message('task-failed', {
    error_message: 'secret key and private spoken text',
  });
  await assert.rejects(pending, /^Error: PLANB_TTS_PROVIDER_FAILED$/);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].closeCount, 1);
});

test('task-finished without audio is not a successful synthesis', async () => {
  const { client, sockets } = fixture();
  const iterator = client.synthesize('Hello.', 1)[Symbol.asyncIterator]();
  const pending = iterator.next();
  sockets[0].open();
  sockets[0].message('task-started');
  sockets[0].message('task-finished');
  await assert.rejects(pending, /PLANB_TTS_EMPTY_AUDIO/);
});

test('sentence regression rejects late audio instead of reordering spoken content', async () => {
  const { client, sockets } = fixture();
  const iterator = client
    .synthesize('First. Second.', 1)
    [Symbol.asyncIterator]();
  const pending = iterator.next();
  sockets[0].open();
  sockets[0].message('task-started');
  sockets[0].marker(1);
  sockets[0].audio();
  await pending;
  const next = iterator.next();
  sockets[0].marker(0);
  await assert.rejects(next, /PLANB_TTS_SENTENCE_ORDER/);
});

test('inactivity timeout ends the task with no retry and ignores later results', async () => {
  const socket = new Socket();
  let calls = 0;
  const client = createAliyunPlanBTts({
    config,
    createWebSocket() {
      calls += 1;
      return socket as unknown as WebSocket;
    },
    timeoutMs: 10,
  });
  const pending = client.synthesize('Hello.', 1)[Symbol.asyncIterator]().next();
  await assert.rejects(pending, /PLANB_TTS_TIMEOUT/);
  socket.open();
  socket.message('task-started');
  socket.marker();
  socket.audio();
  assert.equal(calls, 1);
  assert.equal(socket.sent.length, 0);
});

test('constructing or preparing a TTS iterable does not connect before consumption', async () => {
  const { client, sockets } = fixture();
  const iterable = client.synthesize('Hello.', 1);
  assert.ok(iterable);
  assert.equal(sockets.length, 0);
  client.abort();
  await assert.rejects(
    iterable[Symbol.asyncIterator]().next(),
    /PLANB_TTS_CANCELLED/,
  );
  assert.equal(sockets.length, 0);
});

test('consumer stopping early cancels its task and later binary is discarded', async () => {
  const { client, sockets } = fixture();
  const iterator = client.synthesize('Hello.', 1)[Symbol.asyncIterator]();
  const pending = iterator.next();
  sockets[0].open();
  sockets[0].message('task-started');
  sockets[0].marker();
  sockets[0].audio();
  await pending;
  await iterator.return?.();
  sockets[0].marker();
  sockets[0].audio();
  assert.equal(sockets[0].closeCount, 1);
  assert.equal(sockets.length, 1);
  assert.equal(
    sockets[0].sent.filter(
      (value) => value.payload.input.directive === 'cancel',
    ).length,
    1,
  );
});

test('a real socket close is an error and cannot reconnect itself', async () => {
  const { client, sockets, evidence } = fixture();
  const pending = client.synthesize('Hello.', 1)[Symbol.asyncIterator]().next();
  sockets[0].open();
  sockets[0].message('task-started');
  sockets[0].close(
    1011,
    Buffer.from('private close reason transcript and key'),
  );
  await assert.rejects(pending, /PLANB_TTS_CONNECTION_CLOSED/);
  assert.equal(sockets.length, 1);
  const failures = evidence.filter((event) => event.event === 'failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 'PLANB_TTS_CONNECTION_CLOSED');
  assert.equal(failures[0].closeCode, 1011);
  assert(!JSON.stringify(evidence).includes('private'));
});

test('TTS close metadata rejects invalid codes and cancellation-induced close is not another failure', async () => {
  for (const code of [999, 5000, NaN, '1011', undefined]) {
    const { client, sockets, evidence } = fixture();
    const pending = client
      .synthesize('Hello.', 1)
      [Symbol.asyncIterator]()
      .next();
    sockets[0].open();
    sockets[0].message('task-started');
    sockets[0].emit('close', code, Buffer.from('private close payload'));
    await assert.rejects(pending, /PLANB_TTS_CONNECTION_CLOSED/);
    assert.equal(
      evidence.find((event) => event.event === 'failed')?.closeCode,
      undefined,
    );
    client.abort();
    assert.equal(
      evidence.filter((event) => event.event === 'failed').length,
      1,
    );
  }
  const { client, sockets, evidence } = fixture();
  const pending = client.synthesize('Hello.', 1)[Symbol.asyncIterator]().next();
  sockets[0].open();
  sockets[0].message('task-started');
  client.abort();
  await assert.rejects(pending, /PLANB_TTS_CANCELLED/);
  sockets[0].emit('close', 1011, Buffer.from('private late close reason'));
  assert.equal(evidence.filter((event) => event.event === 'failed').length, 0);
});

test('binary before task acknowledgement is refused', async () => {
  const { client, sockets } = fixture();
  const pending = client.synthesize('Hello.', 1)[Symbol.asyncIterator]().next();
  sockets[0].open();
  sockets[0].audio();
  await assert.rejects(pending, /PLANB_TTS_AUDIO_UNBOUND/);
  assert.equal(sockets[0].sent.length, 1);
});

test('observer exceptions cannot leave a failed synthesis connected', async () => {
  const socket = new Socket();
  const client = createAliyunPlanBTts({
    config,
    createWebSocket: () => socket as unknown as WebSocket,
    timeoutMs: 1000,
    onUsage() {
      throw new Error('observer-secret');
    },
    onEvidence() {
      throw new Error('observer-secret');
    },
  });
  const pending = client.synthesize('Hello.', 1)[Symbol.asyncIterator]().next();
  socket.open();
  socket.message('task-started');
  socket.message('task-failed');
  await assert.rejects(pending, /^Error: PLANB_TTS_PROVIDER_FAILED$/);
  assert.equal(socket.closeCount, 1);
});

for (const method of ['signal', 'client'] as const) {
  test(`${method} abort after task-finished discards buffered PCM without another cancel or usage report`, async () => {
    const { client, sockets, usages } = fixture();
    const controller = new AbortController();
    const iterator = client
      .synthesize('First. Second.', 1, controller.signal)
      [Symbol.asyncIterator]();
    const first = iterator.next();
    const socket = sockets[0];
    socket.open();
    socket.message('task-started');
    socket.marker(0);
    socket.audio(Buffer.from([1, 0]));
    socket.marker(1);
    socket.audio(Buffer.from([2, 0]));
    socket.message('task-finished', { usage: { characters: 14 } });
    assert.deepEqual((await first).value, Buffer.from([1, 0]));
    const sent = socket.sent.length;
    if (method === 'signal') controller.abort();
    else client.abort();
    await assert.rejects(iterator.next(), /PLANB_TTS_CANCELLED/);
    assert.equal(socket.sent.length, sent);
    assert.equal(
      socket.sent.filter((value) => value.payload.input.directive === 'cancel')
        .length,
      0,
    );
    assert.equal(usages.length, 1);
    assert.equal(usages[0].characters, 14);
    assert.equal(socket.closeCount, 1);
  });
}

test('late socket error after task-finished cannot erase valid buffered PCM', async () => {
  const { client, sockets, usages } = fixture();
  const iterator = client
    .synthesize('First. Second.', 1)
    [Symbol.asyncIterator]();
  const first = iterator.next();
  const socket = sockets[0];
  socket.open();
  socket.message('task-started');
  socket.marker(0);
  socket.audio(Buffer.from([1, 0]));
  socket.marker(1);
  socket.audio(Buffer.from([2, 0]));
  socket.message('task-finished', { usage: { characters: 14 } });
  assert.deepEqual((await first).value, Buffer.from([1, 0]));
  socket.emit('error', new Error('late private supplier error'));
  assert.deepEqual((await iterator.next()).value, Buffer.from([2, 0]));
  assert.equal((await iterator.next()).done, true);
  assert.equal(usages.length, 1);
});

test('one sentence can stream multiple marked binary chunks in their original order', async () => {
  const { client, sockets } = fixture();
  const iterator = client
    .synthesize('A continuous sentence.', 1)
    [Symbol.asyncIterator]();
  const first = iterator.next();
  const socket = sockets[0];
  socket.open();
  socket.message('task-started');
  socket.marker(0, 'frame-1');
  socket.audio(Buffer.from([1, 0]));
  socket.marker(0, 'frame-2');
  socket.audio(Buffer.from([2, 0]));
  socket.message('task-finished');
  assert.deepEqual((await first).value, Buffer.from([1, 0]));
  assert.deepEqual((await iterator.next()).value, Buffer.from([2, 0]));
  assert.equal((await iterator.next()).done, true);
});
