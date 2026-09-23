import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import createHttpsProxyAgent from 'https-proxy-agent';
import WebSocket from 'ws';
import {
  TranslationBridge,
  type TranslationBridgeOptions,
  type TranslationMetric,
  type TranslationRole,
  type TranscriptEvent,
} from '../src/solo/translation-bridge';

// Synthetic bytes and in-memory transports only. These tests do not establish
// actual model access, translation quality, audible playback, or end-to-end latency.
class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  closeCount = 0;
  sent: Record<string, any>[] = [];
  sendFailure?: 'throw' | 'callback';

  open() {
    this.readyState = WebSocket.OPEN;
    this.emit('open');
  }
  receive(event: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }
  send(raw: string, callback?: (error?: Error) => void) {
    assert.equal(this.readyState, WebSocket.OPEN);
    if (this.sendFailure === 'throw')
      throw new Error('private-provider-detail');
    if (this.sendFailure === 'callback') {
      callback?.(new Error('private-provider-detail'));
      return;
    }
    this.sent.push(JSON.parse(raw));
    callback?.();
  }
  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.closeCount += 1;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
  terminate() {
    this.close();
  }
  asWebSocket() {
    return this as unknown as WebSocket;
  }
}

function fixture(options: Partial<TranslationBridgeOptions> = {}) {
  const providers: FakeSocket[] = [];
  const connections: { url: string; options: Record<string, any> }[] = [];
  const failures: string[] = [];
  const transcripts: TranscriptEvent[] = [];
  const metrics: TranslationMetric[] = [];
  const phones = { local: new FakeSocket(), remote: new FakeSocket() };
  let now = 1000;
  const bridge = new TranslationBridge({
    apiKey: 'fake-key-not-a-credential',
    model: 'gpt-realtime-1.5',
    onFailure: (reason) => failures.push(reason),
    onTranscript: (event) => transcripts.push(event),
    onMetric: (metric) => metrics.push(metric),
    now: () => now,
    createWebSocket(url, socketOptions) {
      connections.push({ url, options: socketOptions });
      const socket = new FakeSocket();
      providers.push(socket);
      return socket.asWebSocket();
    },
    ...options,
  });
  const attach = (role: TranslationRole) => {
    phones[role].open();
    bridge.attach(role, phones[role].asWebSocket(), `MZ_${role}`);
  };
  const provider = (role: TranslationRole) =>
    providers[role === 'local' ? 0 : 1];
  const ready = (role: TranslationRole) => {
    const socket = provider(role);
    socket.open();
    socket.receive({
      type: 'session.updated',
      session: socket.sent[0].session,
    });
  };
  const pair = () => {
    attach('local');
    attach('remote');
    ready('local');
    ready('remote');
  };
  const media = (role: TranslationRole, payload: string) =>
    phones[role].receive({
      event: 'media',
      streamSid: `MZ_${role}`,
      media: { track: 'inbound', payload },
    });
  const commit = (role: TranslationRole, itemId = `item_${role}`) => {
    provider(role).receive({
      type: 'input_audio_buffer.speech_stopped',
      item_id: itemId,
    });
    provider(role).receive({
      type: 'input_audio_buffer.committed',
      item_id: itemId,
    });
  };
  const responding = (
    role: TranslationRole,
    responseId = `resp_${role}`,
    itemId = `item_${role}`,
  ) => {
    commit(role, itemId);
    provider(role).receive({
      type: 'response.created',
      response: { id: responseId },
    });
  };
  const audio = (
    role: TranslationRole,
    payload: string,
    responseId = `resp_${role}`,
  ) =>
    provider(role).receive({
      type: 'response.output_audio.delta',
      response_id: responseId,
      delta: payload,
    });
  const assertClosed = () => {
    for (const socket of [...Object.values(phones), ...providers]) {
      assert.equal(socket.readyState, WebSocket.CLOSED);
      assert.equal(socket.closeCount, 1);
    }
  };
  return {
    bridge,
    phones,
    providers,
    provider,
    connections,
    failures,
    transcripts,
    metrics,
    attach,
    ready,
    pair,
    media,
    commit,
    responding,
    audio,
    assertClosed,
    setNow: (value: number) => {
      now = value;
    },
  };
}

test('providers start only after both authenticated legs attach and identical attach is idempotent', () => {
  const f = fixture();
  f.attach('local');
  assert.equal(f.providers.length, 0);
  f.bridge.attach('local', f.phones.local.asWebSocket(), 'MZ_local');
  f.attach('remote');
  f.bridge.attach('remote', f.phones.remote.asWebSocket(), 'MZ_remote');
  assert.equal(f.providers.length, 2);
  for (const role of ['local', 'remote'] as const) {
    f.ready(role);
    const update = f.provider(role).sent[0];
    assert.deepEqual(update.session.output_modalities, ['audio']);
    assert.equal(update.session.type, 'realtime');
    assert.equal(update.session.audio.input.format.type, 'audio/pcmu');
    assert.equal(update.session.audio.output.format.type, 'audio/pcmu');
    assert.equal(
      update.session.audio.input.transcription.language,
      role === 'local' ? 'zh' : 'en',
    );
    assert.equal(
      update.session.audio.input.turn_detection.create_response,
      false,
    );
    assert.equal(
      update.session.audio.input.turn_detection.interrupt_response,
      false,
    );
    assert.match(
      update.session.instructions,
      role === 'local'
        ? /Mandarin Chinese into English/
        : /English into Mandarin Chinese/,
    );
  }
  for (const connection of f.connections) {
    assert.equal(
      new URL(connection.url).searchParams.get('model'),
      'gpt-realtime-1.5',
    );
    assert.deepEqual(Object.keys(connection.options.headers), [
      'Authorization',
    ]);
    assert.equal(connection.options.handshakeTimeout, 10000);
    assert.equal(connection.options.agent, undefined);
  }
  f.bridge.close();
});

test('both translation directions use the configured explicit OpenAI proxy', () => {
  const f = fixture({ proxyUrl: 'http://127.0.0.1:8080' });
  try {
    f.pair();
    assert.equal(f.connections.length, 2);
    for (const connection of f.connections) {
      assert.ok(
        connection.options.agent instanceof
          createHttpsProxyAgent.HttpsProxyAgent,
      );
      assert.equal(connection.options.handshakeTimeout, 10000);
      assert.equal(connection.options.maxPayload, 1024 * 1024);
    }
    assert.deepEqual(f.failures, []);
  } finally {
    f.bridge.close();
  }
});

test('pre-pair and pre-ack PCMU input is capped at two seconds and never crosses sessions', () => {
  const f = fixture();
  f.attach('local');
  for (let i = 0; i < 150; i += 1)
    f.media('local', Buffer.alloc(160, i).toString('base64'));
  assert.equal(f.phones.remote.sent.length, 0);
  f.attach('remote');
  f.ready('remote');
  assert.equal(f.provider('local').sent.length, 0);
  f.provider('local').open();
  assert.equal(f.provider('local').sent.length, 1);
  f.provider('local').receive({
    type: 'session.updated',
    session: f.provider('local').sent[0].session,
  });
  const appended = f
    .provider('local')
    .sent.filter((event) => event.type === 'input_audio_buffer.append');
  assert.equal(appended.length, 100);
  assert.equal(Buffer.from(appended[0].audio, 'base64')[0], 50);
  assert.equal(Buffer.from(appended[99].audio, 'base64')[0], 149);
  assert.equal(f.provider('remote').sent.length, 1);
  assert.deepEqual(f.failures, []);
  f.bridge.close();
});

test('both speech directions translate to the opposite leg with no original-audio passthrough', () => {
  const f = fixture();
  f.pair();
  const original = Buffer.alloc(160, 255).toString('base64');
  for (const role of ['local', 'remote'] as const) f.media(role, original);
  assert.deepEqual(f.phones.local.sent, []);
  assert.deepEqual(f.phones.remote.sent, []);
  assert.equal(f.provider('local').sent[1].audio, original);
  assert.equal(f.provider('remote').sent[1].audio, original);
  f.responding('local');
  f.responding('remote');
  const english = Buffer.alloc(160, 10).toString('base64');
  const chinese = Buffer.alloc(160, 20).toString('base64');
  f.setNow(1350);
  f.audio('local', english);
  f.audio('remote', chinese);
  f.audio('local', english);
  assert.deepEqual(f.phones.remote.sent[0], {
    event: 'media',
    streamSid: 'MZ_remote',
    media: { payload: english },
  });
  assert.deepEqual(f.phones.local.sent[0], {
    event: 'media',
    streamSid: 'MZ_local',
    media: { payload: chinese },
  });
  assert.equal(f.metrics.length, 2);
  assert.deepEqual(f.metrics[0], {
    role: 'local',
    name: 'speech_stop_to_first_audio_ms',
    value: 350,
    at: 1350,
    scope: 'provider_generation',
  });
  f.bridge.close();
});

test('new speech turns queue while a translation runs, avoiding cancellation, loss, and duplicate generation', () => {
  const f = fixture();
  f.pair();
  f.responding('local', 'response_1', 'input_1');
  f.commit('local', 'input_2');
  f.commit('local', 'input_2');
  const requests = () =>
    f
      .provider('local')
      .sent.filter((event) => event.type === 'response.create');
  assert.equal(requests().length, 1);
  assert.deepEqual(requests()[0].response.input, [
    { type: 'item_reference', id: 'input_1' },
  ]);
  assert.equal(requests()[0].response.conversation, 'none');
  f.provider('local').receive({
    type: 'response.done',
    response: { id: 'response_1', status: 'completed' },
  });
  assert.equal(requests().length, 2);
  assert.deepEqual(requests()[1].response.input, [
    { type: 'item_reference', id: 'input_2' },
  ]);
  f.provider('local').receive({
    type: 'response.created',
    response: { id: 'response_2' },
  });
  f.audio('local', 'AQID', 'response_1');
  assert.equal(f.phones.remote.sent.length, 0);
  f.audio('local', 'AQID', 'response_2');
  assert.equal(f.phones.remote.sent.length, 1);
  f.bridge.close();
});

test('subtitle deltas and final replacement share stable IDs, including out-of-order source transcription', () => {
  const f = fixture();
  f.pair();
  f.responding('local');
  const socket = f.provider('local');
  socket.receive({
    type: 'response.output_audio_transcript.delta',
    response_id: 'resp_local',
    item_id: 'output_local',
    content_index: 0,
    delta: 'Hel',
  });
  f.setNow(1200);
  socket.receive({
    type: 'response.output_audio_transcript.delta',
    response_id: 'resp_local',
    item_id: 'output_local',
    content_index: 0,
    delta: 'lo!',
  });
  socket.receive({
    type: 'response.output_audio_transcript.done',
    response_id: 'resp_local',
    item_id: 'output_local',
    content_index: 0,
    transcript: 'Hello.',
  });
  socket.receive({
    type: 'response.output_audio_transcript.delta',
    response_id: 'resp_local',
    item_id: 'output_local',
    content_index: 0,
    delta: 'late',
  });
  assert.equal(f.transcripts.length, 3);
  assert.equal(new Set(f.transcripts.map((event) => event.id)).size, 1);
  assert.deepEqual(
    f.transcripts.map((event) => event.text),
    ['Hel', 'Hello!', 'Hello.'],
  );
  assert.deepEqual(
    f.transcripts.map((event) => event.final),
    [false, false, true],
  );
  assert.ok(
    f.transcripts.every(
      (event) =>
        event.at === 1000 &&
        event.role === 'local' &&
        event.kind === 'translation',
    ),
  );
  socket.receive({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'input_2',
    content_index: 0,
    transcript: '第二句',
  });
  socket.receive({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item_local',
    content_index: 0,
    transcript: '你好',
  });
  socket.receive({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item_local',
    content_index: 0,
    transcript: '你好',
  });
  assert.equal(f.transcripts.length, 5);
  assert.equal(f.transcripts[3].id, 'local:original:input_2:0');
  assert.equal(f.transcripts[4].id, 'local:original:item_local:0');
  f.bridge.close();
});

test('session ack timeout closes both phone legs and both providers exactly once', async () => {
  const f = fixture({ sessionTimeoutMs: 10 });
  f.attach('local');
  f.attach('remote');
  f.ready('local');
  await delay(25);
  assert.deepEqual(f.failures, ['openai_session_timeout:remote']);
  f.assertClosed();
  f.bridge.close();
  f.provider('local').emit('error', new Error('late-error-with-private-data'));
  assert.equal(f.failures.length, 1);
});

test('a stalled response fails the session instead of leaving a connected silent call', async () => {
  const f = fixture({ responseTimeoutMs: 10 });
  f.pair();
  f.commit('remote');
  await delay(25);
  assert.deepEqual(f.failures, ['openai_response_timeout:remote']);
  f.assertClosed();
});

test('provider errors, malformed events, rejected configuration and abrupt disconnects fail closed', async (t) => {
  const cases: [string, (f: ReturnType<typeof fixture>) => void, string][] = [
    [
      'API error',
      (f) =>
        f
          .provider('local')
          .receive({
            type: 'error',
            error: { message: 'fake-key-not-a-credential private-transcript' },
          }),
      'openai_event_error:local',
    ],
    [
      'socket error',
      (f) => f.provider('remote').emit('error', new Error('sensitive-detail')),
      'openai_connection_error:remote',
    ],
    [
      'socket close',
      (f) => f.provider('local').close(),
      'openai_connection_closed:local',
    ],
    [
      'bad JSON',
      (f) => f.provider('local').emit('message', Buffer.from('{')),
      'invalid_openai_event:local',
    ],
    [
      'null event',
      (f) => f.provider('local').receive(null),
      'invalid_openai_event:local',
    ],
    [
      'transcription error',
      (f) =>
        f
          .provider('local')
          .receive({
            type: 'conversation.item.input_audio_transcription.failed',
            error: { message: 'private' },
          }),
      'openai_event_error:local',
    ],
  ];
  for (const [name, trigger, reason] of cases)
    await t.test(name, () => {
      const f = fixture();
      f.pair();
      assert.doesNotThrow(() => trigger(f));
      assert.deepEqual(f.failures, [reason]);
      f.assertClosed();
    });
  await t.test('wrong acknowledged codec', () => {
    const f = fixture();
    f.attach('local');
    f.attach('remote');
    f.provider('local').open();
    f.provider('local').receive({
      type: 'session.updated',
      session: {
        type: 'realtime',
        audio: { input: { format: { type: 'audio/pcm' } } },
      },
    });
    assert.deepEqual(f.failures, ['openai_session_mismatch:local']);
    f.assertClosed();
  });
});

test('unexpected Twilio transport close cleans every connection without relying on stop', () => {
  const f = fixture();
  f.pair();
  f.phones.local.close();
  assert.deepEqual(f.failures, ['phone_stream_closed:local']);
  f.assertClosed();
});

test('duplicate replacement streams and wrong stream IDs never take over a call', () => {
  const f = fixture();
  f.pair();
  const replacement = new FakeSocket();
  replacement.open();
  f.bridge.attach('local', replacement.asWebSocket(), 'MZ_replacement');
  assert.deepEqual(f.failures, ['invalid_or_duplicate_phone_stream']);
  f.assertClosed();
  assert.equal(replacement.readyState, WebSocket.CLOSED);
  const g = fixture();
  g.pair();
  g.phones.local.receive({
    event: 'media',
    streamSid: 'MZ_intruder',
    media: { track: 'inbound', payload: 'AQID' },
  });
  assert.deepEqual(g.failures, ['phone_stream_mismatch:local']);
  g.assertClosed();
});

test('explicit hangup is idempotent and late input, output, errors and attach cannot restart translation', () => {
  const f = fixture();
  f.pair();
  f.responding('local');
  f.bridge.close();
  f.bridge.close();
  f.audio('local', 'AQID');
  f.media('remote', 'AQID');
  f.provider('remote').emit('error', new Error('late'));
  const late = new FakeSocket();
  late.open();
  f.bridge.attach('local', late.asWebSocket(), 'MZ_late');
  assert.equal(late.readyState, WebSocket.CLOSED);
  assert.equal(f.providers.length, 2);
  assert.deepEqual(f.failures, []);
  assert.deepEqual(f.phones.remote.sent, []);
  f.assertClosed();
});

test('failed or incomplete generation, malformed audio and socket send failures cannot silently continue', async (t) => {
  for (const status of ['failed', 'cancelled', 'incomplete'])
    await t.test(status, () => {
      const f = fixture();
      f.pair();
      f.responding('local');
      f.provider('local').receive({
        type: 'response.done',
        response: { id: 'resp_local', status },
      });
      assert.deepEqual(f.failures, ['openai_response_failed:local']);
      f.assertClosed();
    });
  await t.test('malformed provider audio', () => {
    const f = fixture();
    f.pair();
    f.responding('local');
    f.provider('local').receive({
      type: 'response.output_audio.delta',
      response_id: 'resp_local',
      delta: 123,
    });
    assert.deepEqual(f.failures, ['invalid_openai_event:local']);
    f.assertClosed();
  });
  for (const mode of ['throw', 'callback'] as const)
    await t.test(`send ${mode}`, () => {
      const f = fixture();
      f.pair();
      f.responding('local');
      f.phones.remote.sendFailure = mode;
      f.audio('local', 'AQID');
      assert.deepEqual(f.failures, ['phone_send_failed:remote']);
      f.assertClosed();
    });
});

test('a partial provider creation failure closes the already-created connection and both legs', () => {
  const first = new FakeSocket();
  let attempts = 0;
  const f = fixture({
    createWebSocket: () => {
      attempts += 1;
      if (attempts === 2) throw new Error('private-key-in-error');
      return first.asWebSocket();
    },
  });
  f.attach('local');
  f.attach('remote');
  assert.deepEqual(f.failures, ['openai_connect_failed:remote']);
  assert.equal(first.readyState, WebSocket.CLOSED);
  assert.equal(f.phones.local.readyState, WebSocket.CLOSED);
  assert.equal(f.phones.remote.readyState, WebSocket.CLOSED);
});
