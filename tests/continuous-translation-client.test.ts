/* eslint-disable no-await-in-loop -- Each protocol fixture is deliberately settled before starting the next case. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import WebSocket from 'ws';

import {
  createContinuousTranslationClient,
  type ContinuousTranslationAudioMetadata,
  type ContinuousTranslationSessionMetadata,
  type ContinuousTranslationOptions,
  type ContinuousTranslationTransportUsage,
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

test('session expiry diagnostics use bounded numeric metadata without exposing provider IDs', async () => {
  const metadata: ContinuousTranslationSessionMetadata[] = [];
  const f = fixture({ onSessionMetadata: (event) => metadata.push(event) });
  f.socket.open();
  const session = {
    id: 'PRIVATE_SESSION_ID',
    model: 'gpt-realtime-translate',
    expires_at: 1900000000,
    audio: { output: { language: 'en' } },
  };
  f.socket.receive({ type: 'session.created', session });
  f.socket.receive({ type: 'session.updated', session });
  await f.client.ready;
  assert.deepEqual(metadata, [
    { stage: 'session_created', expiresAtEpochSeconds: 1900000000 },
    { stage: 'session_updated', expiresAtEpochSeconds: 1900000000 },
  ]);
  for (const expiry of [-1, 0, 1.5, '1900000000', null, 4102444801]) {
    f.socket.receive({
      type: 'session.updated',
      session: { ...session, expires_at: expiry },
    });
  }
  assert.equal(metadata.length, 2);
  assert.deepEqual(f.errors, []);
  f.client.abort();
  f.socket.receive({ type: 'session.created', session });
  assert.equal(metadata.length, 2);
});

test('optional expiry callback failure does not alter handshake, silence or audio routing', async () => {
  const f = fixture({
    onSessionMetadata: () => {
      throw new Error('diagnostic only');
    },
  });
  f.acknowledge();
  await f.client.ready;
  f.socket.receive({
    type: 'session.created',
    session: {
      model: 'gpt-realtime-translate',
      expires_at: 1900000000,
    },
  });
  const pcm = Buffer.alloc(9600);
  f.client.append(pcm);
  f.socket.receive({
    type: 'session.output_audio.delta',
    delta: pcm.toString('base64'),
  });
  assert.deepEqual(f.audio, [pcm]);
  assert.equal(f.socket.sent[1].audio, pcm.toString('base64'));
  assert.deepEqual(f.errors, []);
  f.client.abort();
});

test('audio alignment is optional bounded metadata, never a deduplication or audio gate', async () => {
  const values: {
    pcm: Buffer;
    metadata: ContinuousTranslationAudioMetadata;
  }[] = [];
  const f = fixture({
    onAudio: (pcm, metadata) => values.push({ pcm, metadata }),
  });
  f.acknowledge();
  await f.client.ready;
  const pcm = Buffer.from([0, 0, 1, 0, 255, 127]);
  for (const elapsed of [0, 1200, 1200, -1, 1.5, '200', null, 604800001]) {
    f.socket.receive({
      type: 'session.output_audio.delta',
      delta: pcm.toString('base64'),
      elapsed_ms: elapsed,
    });
  }
  assert.equal(values.length, 8);
  assert.ok(values.every((value) => value.pcm.equals(pcm)));
  assert.deepEqual(
    values.map((value) => value.metadata),
    [
      { providerElapsedMs: 0 },
      { providerElapsedMs: 1200 },
      { providerElapsedMs: 1200 },
      {},
      {},
      {},
      {},
      {},
    ],
  );
  assert.deepEqual(f.errors, []);
  f.client.abort();
});

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

for (const noiseReduction of [null, 'near_field', 'far_field'] as const) {
  test(`explicit noise reduction ${noiseReduction} is sent and requires matching acknowledgement`, async () => {
    const f = fixture({ noiseReduction });
    try {
      const configured =
        noiseReduction === null ? null : { type: noiseReduction };
      f.socket.open();
      assert.deepEqual(f.socket.sent, [
        {
          type: 'session.update',
          session: {
            audio: {
              input: { noise_reduction: configured },
              output: { language: 'en' },
            },
          },
        },
      ]);
      assert.throws(
        () => f.client.append(Buffer.alloc(960)),
        /CLIENT_NOT_READY/,
      );
      f.socket.receive({
        type: 'session.updated',
        session: {
          model: 'gpt-realtime-translate',
          audio: {
            input: { noise_reduction: configured },
            output: { language: 'en' },
          },
        },
      });
      await f.client.ready;
      f.client.append(Buffer.alloc(960));
      assert.equal(f.socket.sent[1].type, 'session.input_audio_buffer.append');
      assert.deepEqual(f.errors, []);
    } finally {
      f.client.abort();
    }
  });
}

test('undefined noise reduction preserves the request and accepts provider defaults without acknowledgement', async () => {
  for (const input of [
    undefined,
    {},
    { noise_reduction: null },
    { noise_reduction: { type: 'near_field' } },
    { noise_reduction: { type: 'far_field' } },
  ]) {
    const f = fixture({ noiseReduction: undefined });
    try {
      f.socket.open();
      assert.deepEqual(f.socket.sent, [
        {
          type: 'session.update',
          session: { audio: { output: { language: 'en' } } },
        },
      ]);
      f.socket.receive({
        type: 'session.updated',
        session: {
          model: 'gpt-realtime-translate',
          audio: { input, output: { language: 'en' } },
        },
      });
      await f.client.ready;
      assert.deepEqual(f.errors, []);
    } finally {
      f.client.abort();
    }
  }
});

test('explicit noise reduction rejects missing, malformed or mismatched acknowledgements before audio delivery', async () => {
  for (const noiseReduction of [null, 'near_field', 'far_field'] as const) {
    const mismatchInputs = [
      undefined,
      null,
      {},
      { noise_reduction: {} },
      { noise_reduction: { type: null } },
      { noise_reduction: 'near_field' },
      { noise_reduction: false },
      { noise_reduction: { type: 'unsupported' } },
      ...([null, 'near_field', 'far_field'] as const)
        .filter((value) => value !== noiseReduction)
        .map((value) => ({
          noise_reduction: value === null ? null : { type: value },
        })),
    ];
    for (const input of mismatchInputs) {
      const f = fixture({ noiseReduction });
      f.socket.open();
      f.socket.receive({
        type: 'session.updated',
        session: {
          model: 'gpt-realtime-translate',
          audio: { input, output: { language: 'en' } },
        },
      });
      await assert.rejects(
        f.client.ready,
        /^Error: PROVIDER_SESSION_MISMATCH$/,
      );
      await assert.rejects(
        f.client.finish(),
        /^Error: PROVIDER_SESSION_MISMATCH$/,
      );
      f.socket.receive({
        type: 'session.output_audio.delta',
        delta: 'AAAAAA==',
      });
      assert.deepEqual(f.audio, []);
      assert.deepEqual(f.errors, ['PROVIDER_SESSION_MISMATCH']);
      assert.equal(f.socket.closeCount, 1);
      assert.equal(f.socket.listenerCount('message'), 0);
    }
  }
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
    { onTranslatedText: true },
    { onTranscript: true },
    { onError: true },
    { timeoutMs: 0 },
    { timeoutMs: Infinity },
    { timeoutMs: 120001 },
    { noiseReduction: '' },
    { noiseReduction: 'none' },
    { noiseReduction: 'near-field' },
    { noiseReduction: true },
    { noiseReduction: 0 },
    { noiseReduction: {} },
    { noiseReduction: [] },
    { noiseReduction: { type: 'near_field' } },
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

test('required translated text receives raw append-only deltas before optional diagnostics', async () => {
  const received: string[] = [];
  const f = fixture({
    onTranslatedText: (delta) => received.push(`required:${delta}`),
    onTranscript: (delta) => received.push(`display:${delta}`),
  });
  f.acknowledge();
  await f.client.ready;
  for (const delta of ['Hello', ', thank', ' you.'])
    f.socket.receive({ type: 'session.output_transcript.delta', delta });
  assert.deepEqual(received, [
    'required:Hello',
    'display:Hello',
    'required:, thank',
    'display:, thank',
    'required: you.',
    'display: you.',
  ]);
  assert.deepEqual(f.errors, []);
  f.client.abort();
});

test('required translated-text callback failure terminates the session and suppresses later output', async () => {
  const f = fixture({
    onTranslatedText: () => {
      throw new Error('private text');
    },
  });
  f.acknowledge();
  await f.client.ready;
  f.socket.receive({
    type: 'session.output_transcript.delta',
    delta: 'Hello.',
  });
  f.socket.receive({ type: 'session.output_audio.delta', delta: 'AAAAAA==' });
  assert.deepEqual(f.errors, ['TRANSLATED_TEXT_CALLBACK_FAILED']);
  assert.deepEqual(f.transcripts, []);
  assert.deepEqual(f.audio, []);
  assert.equal(f.socket.closeCount, 1);
  await assert.rejects(
    f.client.finish(),
    /^Error: TRANSLATED_TEXT_CALLBACK_FAILED$/,
  );
});

test('optional caption failure cannot disable required translated text', async () => {
  const translated: string[] = [];
  const f = fixture({
    onTranslatedText: (text) => translated.push(text),
    onTranscript: () => {
      throw new Error('display failed');
    },
  });
  f.acknowledge();
  await f.client.ready;
  f.socket.receive({
    type: 'session.output_transcript.delta',
    delta: 'Hello.',
  });
  f.socket.receive({
    type: 'session.output_transcript.delta',
    delta: ' Goodbye.',
  });
  assert.deepEqual(translated, ['Hello.', ' Goodbye.']);
  assert.deepEqual(f.errors, []);
  f.client.abort();
});

test('abort inside required translated text prevents a diagnostic callback after shutdown', async () => {
  const f = fixture({ onTranslatedText: () => f.client.abort() });
  f.acknowledge();
  await f.client.ready;
  f.socket.receive({
    type: 'session.output_transcript.delta',
    delta: 'Hello.',
  });
  assert.deepEqual(f.transcripts, []);
  assert.deepEqual(f.errors, []);
  assert.equal(f.socket.closeCount, 1);
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

test('native transport observations count complete PCM including silence without implying billing', async () => {
  const usage: ContinuousTranslationTransportUsage[] = [];
  const f = fixture({ onTransportUsage: (event) => usage.push(event) });
  f.acknowledge();
  await f.client.ready;
  f.client.append(Buffer.alloc(960));
  f.client.append(Buffer.alloc(480));
  f.socket.receive({
    type: 'session.output_audio.delta',
    delta: Buffer.alloc(1920).toString('base64'),
  });
  assert.deepEqual(
    usage.map(
      ({
        direction,
        pcmBytes,
        inputPcmBytes,
        outputPcmBytes,
        inputAudioMs,
        outputAudioMs,
        scope,
        billed,
      }) => ({
        direction,
        pcmBytes,
        inputPcmBytes,
        outputPcmBytes,
        inputAudioMs,
        outputAudioMs,
        scope,
        billed,
      }),
    ),
    [
      {
        direction: 'input',
        pcmBytes: 960,
        inputPcmBytes: 960,
        outputPcmBytes: 0,
        inputAudioMs: 20,
        outputAudioMs: 0,
        scope: 'transport_observed',
        billed: false,
      },
      {
        direction: 'input',
        pcmBytes: 480,
        inputPcmBytes: 1440,
        outputPcmBytes: 0,
        inputAudioMs: 30,
        outputAudioMs: 0,
        scope: 'transport_observed',
        billed: false,
      },
      {
        direction: 'output',
        pcmBytes: 1920,
        inputPcmBytes: 1440,
        outputPcmBytes: 1920,
        inputAudioMs: 30,
        outputAudioMs: 40,
        scope: 'transport_observed',
        billed: false,
      },
    ],
  );
  f.client.abort();
  f.socket.receive({
    type: 'session.output_audio.delta',
    delta: Buffer.alloc(960).toString('base64'),
  });
  assert.equal(usage.length, 3);
  assert.deepEqual(f.audio, [Buffer.alloc(1920)]);
});

test('native input admission denies before submission, including thrown and asynchronous answers', async () => {
  for (const admitAudio of [
    () => false,
    () => {
      throw new Error('PRIVATE_BUDGET');
    },
    (() => Promise.resolve(true)) as unknown as NonNullable<
      ContinuousTranslationOptions['admitAudio']
    >,
  ]) {
    const usage: unknown[] = [];
    const f = fixture({
      admitAudio,
      onTransportUsage: (event) => usage.push(event),
    });
    f.acknowledge();
    await f.client.ready;
    assert.throws(
      () => f.client.append(Buffer.alloc(960)),
      /PROVIDER_AUDIO_ADMISSION_DENIED/,
    );
    assert.equal(f.socket.sent.length, 1);
    assert.deepEqual(usage, []);
    assert.deepEqual(f.errors, ['PROVIDER_AUDIO_ADMISSION_DENIED']);
    assert.equal(f.socket.readyState, WebSocket.CLOSED);
  }
});

test('native denied output is observed once but never forwarded or resumed', async () => {
  const usage: ContinuousTranslationTransportUsage[] = [];
  const admissions: unknown[] = [];
  const f = fixture({
    admitAudio: (event) => {
      admissions.push(event);
      return event.direction === 'input';
    },
    onTransportUsage: (event) => usage.push(event),
  });
  f.acknowledge();
  await f.client.ready;
  f.socket.receive({
    type: 'session.output_audio.delta',
    delta: Buffer.alloc(96000).toString('base64'),
  });
  assert.deepEqual(admissions, [
    { direction: 'output', pcmBytes: 96000, audioMs: 2000 },
  ]);
  assert.equal(
    usage[0].outputPcmBytes,
    96000,
    'variable complete deltas remain counted',
  );
  assert.deepEqual(f.audio, []);
  assert.deepEqual(f.errors, ['PROVIDER_AUDIO_ADMISSION_DENIED']);
  f.socket.receive({
    type: 'session.output_audio.delta',
    delta: Buffer.alloc(960).toString('base64'),
  });
  assert.equal(usage.length, 1);
});

test('native admission cannot resurrect a reentrant abort and optional accounting exceptions cannot suppress audio', async () => {
  let stop: () => void;
  const denied = fixture({
    admitAudio: () => {
      stop();
      return true;
    },
  });
  stop = () => denied.client.abort();
  denied.acknowledge();
  await denied.client.ready;
  assert.throws(
    () => denied.client.append(Buffer.alloc(960)),
    /PROVIDER_AUDIO_ADMISSION_DENIED/,
  );
  assert.equal(denied.socket.sent.length, 1);
  const observer = fixture({
    onTransportUsage: () => {
      throw new Error('PRIVATE_OBSERVER');
    },
    admitAudio: () => true,
  });
  observer.acknowledge();
  await observer.client.ready;
  observer.client.append(Buffer.alloc(960));
  observer.socket.receive({
    type: 'session.output_audio.delta',
    delta: Buffer.alloc(960).toString('base64'),
  });
  assert.deepEqual(observer.audio, [Buffer.alloc(960)]);
  assert.deepEqual(observer.errors, []);
  observer.client.abort();
});

test('native text appends exact deltas despite missing or repeated alignment and delayed optional source', async (t) => {
  const source: { delta: string; metadata: unknown }[] = [];
  const f = fixture({
    onInputTranscript: (delta, metadata) => source.push({ delta, metadata }),
  });
  t.after(() => f.client.abort());
  f.acknowledge();
  await f.client.ready;
  const pcm = Buffer.alloc(960, 1);
  f.socket.receive({
    type: 'session.output_audio.delta',
    delta: pcm.toString('base64'),
  });
  assert.deepEqual(
    f.audio,
    [pcm],
    'native audio precedes any optional source text',
  );
  for (const event of [
    { event_id: 'target_1', delta: 'Hel' },
    { event_id: 'target_2', delta: 'lo', elapsed_ms: 1200 },
    { event_id: 'target_2', delta: 'lo', elapsed_ms: 1200 },
    { event_id: 'target_3', delta: ' world', elapsed_ms: 1200 },
    { delta: '!' },
    { delta: '!' },
  ])
    f.socket.receive({ type: 'session.output_transcript.delta', ...event });
  f.socket.receive({
    type: 'session.input_transcript.delta',
    event_id: 'source_1',
    delta: '明',
    elapsed_ms: 1200,
  });
  f.socket.receive({
    type: 'session.input_transcript.delta',
    event_id: 'source_2',
    delta: '天',
    elapsed_ms: 1200,
  });
  f.socket.receive({ type: 'session.input_transcript.delta', delta: '。' });
  assert.equal(f.transcripts.join(''), 'Hello world!!');
  assert.deepEqual(source, [
    { delta: '明', metadata: { providerElapsedMs: 1200 } },
    { delta: '天', metadata: { providerElapsedMs: 1200 } },
    { delta: '。', metadata: {} },
  ]);
  assert.equal(
    f.socket.sent[0].session.audio.input,
    undefined,
    'a source consumer never requests optional transcription',
  );
  assert.deepEqual(f.errors, []);
});

test('session event IDs prevent old duplicate audio and text beyond 512 events and remain isolated in a new client', async (t) => {
  const first = fixture();
  t.after(() => first.client.abort());
  first.acknowledge();
  await first.client.ready;
  const audioEvent = {
    type: 'session.output_audio.delta',
    event_id: 'audio_old',
    delta: Buffer.alloc(960, 1).toString('base64'),
    elapsed_ms: 0,
  };
  const textEvent = {
    type: 'session.output_transcript.delta',
    event_id: 'text_old',
    delta: 'Hello',
    elapsed_ms: 0,
  };
  first.socket.receive(audioEvent);
  first.socket.receive(textEvent);
  for (let index = 0; index < 600; index += 1)
    first.socket.receive({
      type: 'session.output_transcript.delta',
      event_id: `text_${index}`,
      delta: '.',
      elapsed_ms: 0,
    });
  first.socket.receive(audioEvent);
  first.socket.receive(textEvent);
  assert.equal(first.audio.length, 1);
  assert.equal(first.transcripts.join(''), `Hello${'.'.repeat(600)}`);
  first.client.abort();
  const second = fixture();
  t.after(() => second.client.abort());
  second.acknowledge();
  await second.client.ready;
  second.socket.receive(audioEvent);
  second.socket.receive(textEvent);
  first.socket.receive({
    ...textEvent,
    event_id: 'late_old_client',
    delta: 'STALE',
  });
  assert.deepEqual(second.transcripts, ['Hello']);
  assert.equal(second.audio.length, 1);
  assert.doesNotMatch(first.transcripts.join(''), /STALE/);
});

test('invalid provider IDs and exhausted session deduplication fail with bounded sanitized codes', async (t) => {
  for (const id of [null, '', 'bad\nID', 'x'.repeat(257), ['array']]) {
    const f = fixture();
    t.after(() => f.client.abort());
    f.acknowledge();
    await f.client.ready;
    f.socket.receive({
      type: 'session.output_transcript.delta',
      event_id: id,
      delta: 'PRIVATE_TEXT',
    });
    assert.deepEqual(f.transcripts, []);
    assert.deepEqual(f.errors, ['INVALID_PROVIDER_EVENT_ID']);
  }
  const bounded = fixture();
  t.after(() => bounded.client.abort());
  bounded.acknowledge();
  await bounded.client.ready;
  for (let index = 0; index <= 32768; index += 1)
    bounded.socket.receive({
      type: 'session.output_transcript.delta',
      event_id: `bounded_${index}`,
      delta: '',
    });
  assert.equal(bounded.transcripts.length, 32768);
  assert.deepEqual(bounded.errors, ['PROVIDER_EVENT_LIMIT']);
  assert.equal(bounded.socket.readyState, WebSocket.CLOSED);
});

test('finish drains source and translated text tails until session.closed while abort discards them immediately', async (t) => {
  const source: string[] = [];
  const drain = fixture({ onInputTranscript: (delta) => source.push(delta) });
  t.after(() => drain.client.abort());
  drain.acknowledge();
  await drain.client.ready;
  const done = drain.client.finish();
  drain.socket.receive({
    type: 'session.output_transcript.delta',
    event_id: 'target_tail',
    delta: 'Tail.',
  });
  drain.socket.receive({
    type: 'session.input_transcript.delta',
    event_id: 'source_tail',
    delta: '尾句。',
  });
  assert.deepEqual(drain.transcripts, ['Tail.']);
  assert.deepEqual(source, ['尾句。']);
  drain.socket.receive({ type: 'session.closed' });
  await done;
  drain.socket.receive({
    type: 'session.output_transcript.delta',
    delta: 'Late.',
  });
  assert.deepEqual(drain.transcripts, ['Tail.']);
  const abort = fixture();
  abort.acknowledge();
  await abort.client.ready;
  const interrupted = abort.client.finish();
  abort.client.abort();
  await assert.rejects(interrupted, /CLIENT_ABORTED/);
  abort.socket.receive({
    type: 'session.output_transcript.delta',
    delta: 'Late.',
  });
  assert.deepEqual(abort.transcripts, []);
  assert.equal(abort.socket.listenerCount('message'), 0);
});
