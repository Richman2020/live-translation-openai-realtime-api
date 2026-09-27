/* eslint-disable no-await-in-loop -- Each protocol fixture is deliberately settled before starting the next case. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import WebSocket from 'ws';

import {
  createContinuousTranslationClient,
  type ContinuousTranslationOptions,
} from '../src/solo/continuous-translation-client';

// Protocol fixtures only: no credentials, provider calls or proof of spoken
// translation quality, actual account access or end-to-end phone latency.
class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;

  bufferedAmount = 0;

  closeCount = 0;

  sent: Record<string, any>[] = [];

  sendFailure?: 'throw' | 'callback';

  pendingWrites: ((error?: Error) => void)[] = [];

  deferWrite = false;

  open() {
    this.readyState = WebSocket.OPEN;
    this.emit('open');
  }

  receive(event: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }

  send(raw: string, callback?: (error?: Error) => void) {
    if (this.sendFailure === 'throw') throw new Error('private-key detail');
    if (this.sendFailure === 'callback') {
      callback?.(new Error('private-key detail'));
      return;
    }
    this.sent.push(JSON.parse(raw));
    if (this.deferWrite && callback) this.pendingWrites.push(callback);
    else callback?.();
  }

  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.closeCount += 1;
    this.readyState = WebSocket.CLOSED;
    this.emit('close', 1000);
  }

  terminate() {
    this.close();
  }
}

function fixture(options: Partial<ContinuousTranslationOptions> = {}) {
  const socket = new FakeSocket();
  const audio: Buffer[] = [];
  const transcripts: string[] = [];
  const errors: string[] = [];
  let connectedUrl = '';
  let socketOptions: WebSocket.ClientOptions;
  const client = createContinuousTranslationClient({
    apiKey: 'fixture-key-not-a-credential',
    targetLanguage: 'en',
    onAudio: (pcm) => audio.push(pcm),
    onTranscript: (delta) => transcripts.push(delta),
    onError: (code) => errors.push(code),
    createWebSocket(url, settings) {
      connectedUrl = url;
      socketOptions = settings;
      return socket as unknown as WebSocket;
    },
    ...options,
  });
  const acknowledge = () => {
    socket.open();
    socket.receive({
      type: 'session.updated',
      session: {
        model: 'gpt-realtime-translate',
        audio: { output: { language: options.targetLanguage ?? 'en' } },
      },
    });
  };
  return {
    client,
    socket,
    audio,
    transcripts,
    errors,
    acknowledge,
    connection: () => ({ url: connectedUrl, options: socketOptions }),
  };
}

test('continuous protocol uses a dedicated session with no ASR or response creation', async () => {
  for (const targetLanguage of ['en', 'zh'] as const) {
    const f = fixture({ targetLanguage });
    try {
      assert.equal(
        f.connection().url,
        'wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate',
      );
      assert.equal(f.connection().options.maxPayload, 1024 * 1024);
      f.acknowledge();
      await f.client.ready;
      assert.deepEqual(f.socket.sent, [
        {
          type: 'session.update',
          session: { audio: { output: { language: targetLanguage } } },
        },
      ]);
      const pcm = Buffer.from([0, 0, 10, 0]);
      f.client.append(pcm);
      assert.deepEqual(f.socket.sent[1], {
        type: 'session.input_audio_buffer.append',
        audio: pcm.toString('base64'),
      });
    } finally {
      f.client.abort();
    }
  }
});

test('explicit proxy is passed through the existing authenticated websocket helper', () => {
  const f = fixture({ proxyUrl: 'http://127.0.0.1:9876' });
  assert.ok(f.connection().options.agent);
  f.client.abort();
});

test('invalid options fail before opening a transport', () => {
  let created = 0;
  const createWebSocket = () => {
    created += 1;
    throw new Error('must not open');
  };
  for (const invalid of [
    { targetLanguage: 'fr' },
    { apiKey: '' },
    { onAudio: undefined },
    { onTranscript: true },
    { onError: true },
    { timeoutMs: 0 },
    { timeoutMs: Infinity },
    { timeoutMs: 120001 },
  ]) {
    assert.throws(
      () =>
        fixture({
          ...invalid,
          createWebSocket,
        } as any),
      /INVALID_CONTINUOUS_TRANSLATION_OPTIONS/,
    );
  }
  assert.equal(created, 0);
});

test('ready requires the exact model and target-language acknowledgement', async () => {
  for (const session of [
    {},
    { model: 'other', audio: { output: { language: 'en' } } },
    { model: 'gpt-realtime-translate', audio: { output: { language: 'zh' } } },
  ]) {
    const f = fixture();
    f.socket.open();
    f.socket.receive({ type: 'session.updated', session });
    await assert.rejects(f.client.ready, /PROVIDER_SESSION_MISMATCH/);
    await assert.rejects(f.client.finish(), /PROVIDER_SESSION_MISMATCH/);
    assert.equal(f.socket.closeCount, 1);
  }
});

test('append rejects pre-ready input, invalid PCM and input after finish without queuing', async () => {
  const f = fixture();
  assert.throws(() => f.client.append(Buffer.alloc(960)), /CLIENT_NOT_READY/);
  assert.equal(f.socket.sent.length, 0);
  f.acknowledge();
  await f.client.ready;
  for (const pcm of [
    Buffer.alloc(0),
    Buffer.alloc(3),
    Buffer.alloc(48002),
    'not PCM',
  ])
    assert.throws(() => f.client.append(pcm as Buffer), /INVALID_PCM_INPUT/);
  assert.equal(f.socket.sent.length, 1);
  const done = f.client.finish();
  assert.throws(
    () => f.client.append(Buffer.alloc(2)),
    /CLIENT_NOT_ACCEPTING_AUDIO/,
  );
  f.socket.receive({ type: 'session.closed' });
  await done;
  assert.throws(
    () => f.client.append(Buffer.alloc(2)),
    /CLIENT_NOT_ACCEPTING_AUDIO/,
  );
});

test('audio forwards before any transcript and silence remains an input chunk', async () => {
  const f = fixture();
  try {
    f.acknowledge();
    await f.client.ready;
    f.client.append(Buffer.alloc(960));
    const pcm = Buffer.from([0, 0, 255, 127, 0, 128]);
    f.socket.receive({
      type: 'session.output_audio.delta',
      delta: pcm.toString('base64'),
    });
    assert.deepEqual(f.audio, [pcm]);
    assert.deepEqual(f.transcripts, []);
    f.socket.receive({
      type: 'session.output_transcript.delta',
      delta: 'Hello',
    });
    assert.deepEqual(f.transcripts, ['Hello']);
  } finally {
    f.client.abort();
  }
});

test('finish is idempotent and drains remaining audio until session.closed', async () => {
  const f = fixture();
  f.acknowledge();
  await f.client.ready;
  const done = f.client.finish();
  assert.equal(f.client.finish(), done);
  assert.equal(
    f.socket.sent.filter((event) => event.type === 'session.close').length,
    1,
  );
  const pcm = Buffer.from([1, 0, 2, 0]);
  f.socket.receive({
    type: 'session.output_audio.delta',
    delta: pcm.toString('base64'),
  });
  assert.deepEqual(f.audio, [pcm]);
  assert.equal(f.socket.closeCount, 0);
  f.socket.receive({ type: 'session.closed' });
  await done;
  f.socket.receive({
    type: 'session.output_audio.delta',
    delta: pcm.toString('base64'),
  });
  assert.equal(f.audio.length, 1);
  assert.equal(f.socket.closeCount, 1);
  assert.equal(f.socket.listenerCount('message'), 0);
});

test('optional audio metadata accepts documented defaults and preserves variable complete deltas', async () => {
  const f = fixture();
  try {
    f.acknowledge();
    await f.client.ready;
    const events = [
      { delta: Buffer.alloc(2, 1) },
      {
        delta: Buffer.alloc(19200, 2),
        sample_rate: 24000,
        channels: 1,
        format: 'pcm16',
      },
      { delta: Buffer.alloc(960, 3), sample_rate: 24000 },
      { delta: Buffer.alloc(6400, 4), channels: 1, format: 'pcm16' },
    ];
    for (const event of events) {
      f.socket.receive({
        ...event,
        type: 'session.output_audio.delta',
        delta: event.delta.toString('base64'),
      });
    }
    assert.deepEqual(
      f.audio,
      events.map((event) => event.delta),
    );
    assert.deepEqual(f.errors, []);
  } finally {
    f.client.abort();
  }
});

test('declared mismatched audio rate, channels or encoding fails before playback', async () => {
  for (const metadata of [
    { sample_rate: 48000 },
    { sample_rate: '24000' },
    { sample_rate: null },
    { channels: 2 },
    { channels: '1' },
    { channels: null },
    { format: 'pcm32' },
    { format: 'audio/pcm' },
    { format: null },
  ]) {
    const f = fixture();
    f.acknowledge();
    await f.client.ready;
    const done = f.client.finish();
    f.socket.receive({
      type: 'session.output_audio.delta',
      delta: 'AAAAAA==',
      ...metadata,
    });
    await assert.rejects(done, /^Error: PROVIDER_AUDIO_FORMAT_MISMATCH$/);
    assert.deepEqual(f.errors, ['PROVIDER_AUDIO_FORMAT_MISMATCH']);
    assert.deepEqual(f.audio, []);
    assert.equal(f.socket.closeCount, 1);
  }
});

test('malformed or odd-byte PCM output fails closed without leaking provider data', async () => {
  for (const delta of ['bad base64 secret', 'AA==', 'AB==', '', 1]) {
    const f = fixture();
    f.acknowledge();
    await f.client.ready;
    f.socket.receive({ type: 'session.output_audio.delta', delta });
    await assert.rejects(f.client.finish(), /^Error: INVALID_PROVIDER_AUDIO$/);
    assert.deepEqual(f.errors, ['INVALID_PROVIDER_AUDIO']);
    assert.equal(f.audio.length, 0);
  }
});

test('provider output before acknowledged configuration is not delivered', async () => {
  const f = fixture();
  f.socket.open();
  f.socket.receive({ type: 'session.output_audio.delta', delta: 'AAAAAA==' });
  await assert.rejects(f.client.ready, /PROVIDER_OUTPUT_BEFORE_READY/);
  assert.equal(f.audio.length, 0);
});

test('handshake and finish deadlines settle promises and release message listeners', async () => {
  const waiting = fixture({ timeoutMs: 8 });
  await assert.rejects(waiting.client.ready, /PROVIDER_READY_TIMEOUT/);
  assert.equal(waiting.socket.closeCount, 1);
  const draining = fixture({ timeoutMs: 8 });
  draining.acknowledge();
  await draining.client.ready;
  await assert.rejects(draining.client.finish(), /PROVIDER_FINISH_TIMEOUT/);
  assert.equal(draining.socket.closeCount, 1);
  assert.equal(draining.socket.listenerCount('message'), 0);
});

test('unexpected socket closure cannot masquerade as a successful final drain', async () => {
  const f = fixture();
  f.acknowledge();
  await f.client.ready;
  const done = f.client.finish();
  f.socket.close();
  await assert.rejects(done, /PROVIDER_CLOSED_UNEXPECTEDLY/);
  assert.deepEqual(f.errors, ['PROVIDER_CLOSED_UNEXPECTEDLY']);
});

test('provider and transport errors are redacted and emitted once', async () => {
  for (const type of ['provider', 'transport', 'malformed', 'handshake']) {
    const f = fixture({
      onError: () => {
        throw new Error('subscriber private detail');
      },
    });
    f.socket.open();
    if (type === 'provider')
      f.socket.receive({
        type: 'error',
        error: { message: 'private-key and transcript' },
      });
    else if (type === 'transport')
      f.socket.emit('error', new Error('private-key and transcript'));
    else if (type === 'malformed')
      f.socket.emit('message', '{private-key malformed');
    else
      f.socket.emit(
        'unexpected-response',
        {},
        { statusCode: 401, resume() {} },
      );
    const expected = {
      provider: 'PROVIDER_SESSION_REJECTED',
      transport: 'PROVIDER_CONNECTION_FAILED',
      malformed: 'INVALID_PROVIDER_EVENT',
      handshake: 'PROVIDER_HANDSHAKE_REJECTED',
    }[type];
    await assert.rejects(f.client.ready, new RegExp(`^Error: ${expected}$`));
    assert.equal(f.socket.closeCount, 1);
    assert.doesNotThrow(() => f.socket.emit('error', new Error('late secret')));
  }
});

test('transport creation failure resolves lifecycle rejection without leaking the original error', async () => {
  const f = fixture({
    createWebSocket() {
      throw new Error('private proxy credentials');
    },
  });
  await assert.rejects(f.client.ready, /^Error: PROVIDER_CONNECTION_FAILED$/);
  await assert.rejects(
    f.client.finish(),
    /^Error: PROVIDER_CONNECTION_FAILED$/,
  );
  assert.deepEqual(f.errors, ['PROVIDER_CONNECTION_FAILED']);
});

test('sender backpressure and failed writes fail closed instead of dropping or accumulating audio', async () => {
  for (const kind of ['buffered', 'throw', 'callback']) {
    const f = fixture();
    f.acknowledge();
    await f.client.ready;
    if (kind === 'buffered') f.socket.bufferedAmount = 256 * 1024 + 1;
    else f.socket.sendFailure = kind as 'throw' | 'callback';
    assert.throws(
      () => f.client.append(Buffer.alloc(960)),
      /PROVIDER_SEND_FAILED/,
    );
    await assert.rejects(
      f.client.finish(),
      /PROVIDER_SEND_(UNAVAILABLE|FAILED)/,
    );
    assert.equal(f.socket.closeCount, 1);
  }
});

test('audio delivery callback exceptions fail cleanly without escaping the dispatcher', async () => {
  const f = fixture({
    onAudio() {
      throw new Error('private audio consumer');
    },
  });
  f.acknowledge();
  await f.client.ready;
  assert.doesNotThrow(() =>
    f.socket.receive({
      type: 'session.output_audio.delta',
      delta: 'AAAAAA==',
    }),
  );
  await assert.rejects(f.client.finish(), /AUDIO_CALLBACK_FAILED/);
  assert.equal(f.socket.closeCount, 1);
});

test('optional transcript diagnostics cannot interrupt subsequent spoken output', async () => {
  const f = fixture({
    onTranscript() {
      throw new Error('private transcript consumer');
    },
  });
  f.acknowledge();
  await f.client.ready;
  f.socket.receive({ type: 'session.output_transcript.delta', delta: 'Hello' });
  const pcm = Buffer.from([0, 0, 1, 0]);
  f.socket.receive({
    type: 'session.output_audio.delta',
    delta: pcm.toString('base64'),
  });
  assert.deepEqual(f.audio, [pcm]);
  assert.deepEqual(f.errors, []);
  const done = f.client.finish();
  f.socket.receive({ type: 'session.closed' });
  await done;
});

test('abort is immediate and idempotent; stale transport callbacks cannot resume output', async () => {
  const f = fixture();
  f.acknowledge();
  await f.client.ready;
  f.socket.deferWrite = true;
  f.client.append(Buffer.alloc(960));
  f.client.abort();
  f.client.abort();
  f.socket.pendingWrites[0]?.(new Error('stale private send error'));
  f.socket.receive({ type: 'session.output_audio.delta', delta: 'AAAAAA==' });
  await assert.rejects(f.client.finish(), /CLIENT_ABORTED/);
  assert.equal(f.socket.closeCount, 1);
  assert.deepEqual(f.audio, []);
  assert.deepEqual(f.errors, []);
});

test('aborting before ready cancels the deadline and permits callers to await later', async () => {
  const f = fixture({ timeoutMs: 8 });
  f.client.abort();
  await delay(15);
  await assert.rejects(f.client.ready, /CLIENT_ABORTED/);
  await assert.rejects(f.client.finish(), /CLIENT_ABORTED/);
  assert.deepEqual(f.errors, []);
  assert.equal(f.socket.closeCount, 1);
});
