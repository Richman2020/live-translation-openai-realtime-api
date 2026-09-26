import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import createHttpsProxyAgent from 'https-proxy-agent';
import WebSocket from 'ws';
import {
  TranslationBridge,
  type TranslationAudioDiagnostic,
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
  pendingWrite?: (error?: Error) => void;
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
    assert.equal(this.readyState, WebSocket.OPEN);
    if (this.sendFailure === 'throw')
      throw new Error('private-provider-detail');
    if (this.sendFailure === 'callback') {
      callback?.(new Error('private-provider-detail'));
      return;
    }
    this.sent.push(JSON.parse(raw));
    if (this.deferWrite) {
      this.pendingWrite = callback;
      if (callback) this.pendingWrites.push(callback);
      return;
    }
    callback?.();
  }
  close(code?: number) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.closeCount += 1;
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code);
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
  const audioDiagnostics: TranslationAudioDiagnostic[] = [];
  const phones = { local: new FakeSocket(), remote: new FakeSocket() };
  let now = 1000;
  const bridge = new TranslationBridge({
    apiKey: 'fake-key-not-a-credential',
    model: 'gpt-realtime-1.5',
    onFailure: (reason) => failures.push(reason),
    onTranscript: (event) => transcripts.push(event),
    onMetric: (metric) => metrics.push(metric),
    onAudioDiagnostic: (event) => audioDiagnostics.push(event),
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
  const transcribe = (
    role: TranslationRole,
    itemId = `item_${role}`,
    text = role === 'local' ? '你好' : 'We need help.',
  ) =>
    provider(role).receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: itemId,
      content_index: 0,
      transcript: text,
    });
  const responding = (
    role: TranslationRole,
    responseId = `resp_${role}`,
    itemId = `item_${role}`,
  ) => {
    commit(role, itemId);
    transcribe(role, itemId);
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
  const done = (role: TranslationRole, responseId = `resp_${role}`) =>
    provider(role).receive({
      type: 'response.done',
      response: { id: responseId, status: 'completed' },
    });
  const mark = (role: TranslationRole, name: string) =>
    phones[role].receive({
      event: 'mark',
      streamSid: `MZ_${role}`,
      mark: { name },
    });
  return {
    bridge,
    phones,
    providers,
    provider,
    connections,
    failures,
    transcripts,
    metrics,
    audioDiagnostics,
    attach,
    ready,
    pair,
    media,
    commit,
    transcribe,
    responding,
    audio,
    done,
    mark,
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
      update.session.audio.input.transcription.model,
      'whisper-1',
    );
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

test('bridge uses the configured transcription model for both directions and rejects invalid selections', () => {
  for (const transcriptionModel of [
    'gpt-4o-transcribe',
    'gpt-4o-mini-transcribe',
    'whisper-1',
  ]) {
    const f = fixture({ transcriptionModel });
    f.pair();
    for (const role of ['local', 'remote'] as const)
      assert.equal(
        f.provider(role).sent[0].session.audio.input.transcription.model,
        transcriptionModel,
      );
    assert.deepEqual(f.failures, []);
    f.bridge.close();
  }
  for (const transcriptionModel of ['', 'unsupported-model'])
    assert.throws(
      () => fixture({ transcriptionModel }),
      /INVALID_OPENAI_TRANSCRIPTION_MODEL/,
    );
});

test('bridge does not accept an acknowledgement with missing or different transcription model', () => {
  for (const model of [undefined, 'gpt-4o-transcribe']) {
    const f = fixture();
    f.attach('local');
    f.attach('remote');
    const provider = f.provider('local');
    provider.open();
    const session = structuredClone(provider.sent[0].session);
    session.audio.input.transcription.model = model;
    provider.receive({ type: 'session.updated', session });
    assert.deepEqual(f.failures, ['openai_session_mismatch:local']);
    f.assertClosed();
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

test('per-response audio diagnostics distinguish generation, socket writes and matching opposite-leg playback marks', () => {
  const f = fixture();
  f.pair();
  for (const role of ['local', 'remote'] as const) {
    const recipientRole = role === 'local' ? 'remote' : 'local';
    f.responding(role);
    f.audio(role, 'AQID');
    f.audio(role, 'BAUG');
    assert.equal(f.audioDiagnostics.length, role === 'local' ? 0 : 3);
    f.done(role);
    const outgoing = f.phones[recipientRole].sent;
    assert.deepEqual(
      outgoing.map((event) => event.event),
      ['media', 'media', 'mark'],
    );
    assert.equal(outgoing[2].streamSid, `MZ_${recipientRole}`);
    f.mark(role, outgoing[2].mark.name); // The source leg cannot confirm it.
    f.mark(recipientRole, 'unknown-mark');
    assert.equal(f.audioDiagnostics.at(-1).stage, 'sent');
    f.mark(recipientRole, outgoing[2].mark.name);
    f.mark(recipientRole, outgoing[2].mark.name); // Duplicate ack is ignored.
    assert.deepEqual(f.audioDiagnostics.slice(-3), [
      {
        role,
        recipientRole,
        stage: 'generated',
        generatedBytes: 6,
        sentBytes: 6,
      },
      { role, recipientRole, stage: 'sent', generatedBytes: 6, sentBytes: 6 },
      {
        role,
        recipientRole,
        stage: 'playback_confirmed',
        generatedBytes: 6,
        sentBytes: 6,
      },
    ]);
  }
  assert.ok(f.phones.local.sent.every((event) => event.event !== 'clear'));
  assert.ok(f.phones.remote.sent.every((event) => event.event !== 'clear'));
  f.bridge.close();
  assert.equal(f.audioDiagnostics.length, 6);
});

test('an early mark cannot claim sent or playback until all media write callbacks succeed', () => {
  const f = fixture();
  f.pair();
  f.responding('local');
  f.phones.remote.deferWrite = true;
  f.audio('local', 'AQID');
  f.audio('local', 'BAUG');
  f.done('local');
  const marker = f.phones.remote.sent.at(-1);
  f.mark('remote', marker.mark.name);
  assert.deepEqual(f.audioDiagnostics, [
    {
      role: 'local',
      recipientRole: 'remote',
      stage: 'generated',
      generatedBytes: 6,
      sentBytes: 0,
    },
  ]);
  f.phones.remote.pendingWrites[0]();
  assert.equal(f.audioDiagnostics.length, 1);
  f.phones.remote.pendingWrites[1]();
  assert.deepEqual(
    f.audioDiagnostics.slice(-2).map((event) => event.stage),
    ['sent', 'playback_confirmed'],
  );
  assert.equal(f.audioDiagnostics.at(-1).sentBytes, 6);
  f.phones.remote.pendingWrites[2]();
  assert.equal(f.audioDiagnostics.length, 3);
  f.bridge.close();
});

test('failed media writes remain unconfirmed even after an early matching mark', () => {
  const f = fixture();
  f.pair();
  f.responding('local');
  f.phones.remote.deferWrite = true;
  f.audio('local', 'AQID');
  f.audio('local', 'BAUG');
  f.done('local');
  f.mark('remote', f.phones.remote.sent.at(-1).mark.name);
  f.phones.remote.pendingWrites[0]();
  f.phones.remote.pendingWrites[1](new Error('private transport details'));
  assert.deepEqual(
    f.audioDiagnostics.map((event) => event.stage),
    ['generated', 'unconfirmed'],
  );
  assert.equal(f.audioDiagnostics.at(-1).sentBytes, 3);
  assert.deepEqual(f.failures, ['phone_send_failed:remote']);
  f.assertClosed();
  f.phones.remote.pendingWrites[2]();
  assert.equal(f.audioDiagnostics.length, 2);
});

test('responses without audio expose zero generated bytes and do not manufacture playback confirmation', () => {
  const f = fixture();
  f.pair();
  f.responding('local');
  f.done('local');
  assert.deepEqual(f.audioDiagnostics, [
    {
      role: 'local',
      recipientRole: 'remote',
      stage: 'generated',
      generatedBytes: 0,
      sentBytes: 0,
    },
  ]);
  assert.deepEqual(f.phones.remote.sent, []);
  f.bridge.close();
  assert.equal(f.audioDiagnostics.length, 1);
});

test('unacknowledged playback is bounded and eviction and shutdown remain unconfirmed', () => {
  const f = fixture();
  f.pair();
  for (let index = 0; index < 129; index += 1) {
    f.responding('local', `response_${index}`, `input_${index}`);
    f.audio('local', 'AQID', `response_${index}`);
    f.done('local', `response_${index}`);
  }
  const marks = f.phones.remote.sent.filter((event) => event.event === 'mark');
  assert.equal(
    f.audioDiagnostics.filter((event) => event.stage === 'unconfirmed').length,
    1,
  );
  f.mark('remote', marks[0].mark.name);
  assert.equal(
    f.audioDiagnostics.filter((event) => event.stage === 'playback_confirmed')
      .length,
    0,
  );
  f.mark('remote', marks.at(-1).mark.name);
  assert.equal(
    f.audioDiagnostics.filter((event) => event.stage === 'playback_confirmed')
      .length,
    1,
  );
  f.bridge.close();
  assert.equal(
    f.audioDiagnostics.filter((event) => event.stage === 'unconfirmed').length,
    128,
  );
  for (const event of f.audioDiagnostics)
    assert.deepEqual(Object.keys(event).sort(), [
      'generatedBytes',
      'recipientRole',
      'role',
      'sentBytes',
      'stage',
    ]);
});

test('an unfinished response becomes unconfirmed on provider recovery and stale callbacks cannot confirm it', () => {
  const f = fixture();
  f.pair();
  f.responding('local');
  f.phones.remote.deferWrite = true;
  f.audio('local', 'AQID');
  f.provider('local').close(1006);
  assert.deepEqual(f.audioDiagnostics, [
    {
      role: 'local',
      recipientRole: 'remote',
      stage: 'unconfirmed',
      generatedBytes: 3,
      sentBytes: 0,
    },
  ]);
  f.phones.remote.pendingWrites[0]();
  assert.equal(f.audioDiagnostics.length, 1);
  assert.deepEqual(f.failures, []);
  assert.equal(f.providers.length, 3);
  f.bridge.close();
});

test('wrong-stream mark cannot confirm playback and optional diagnostic callback errors never disrupt calls', () => {
  const f = fixture();
  f.pair();
  f.responding('local');
  f.audio('local', 'AQID');
  f.done('local');
  f.phones.remote.receive({
    event: 'mark',
    streamSid: 'MZ_intruder',
    mark: f.phones.remote.sent.at(-1).mark,
  });
  assert.deepEqual(f.failures, ['phone_stream_mismatch:remote']);
  assert.deepEqual(
    f.audioDiagnostics.map((event) => event.stage),
    ['generated', 'sent', 'unconfirmed'],
  );
  const g = fixture({
    onAudioDiagnostic: () => {
      throw new Error('private');
    },
  });
  g.pair();
  g.responding('remote');
  g.audio('remote', 'AQID');
  g.done('remote');
  g.mark('local', g.phones.local.sent.at(-1).mark.name);
  assert.deepEqual(g.failures, []);
  g.bridge.close();
});

test('new speech turns queue while a translation runs, avoiding cancellation, loss, and duplicate generation', () => {
  const f = fixture();
  f.pair();
  f.responding('local', 'response_1', 'input_1');
  f.commit('local', 'input_2');
  f.commit('local', 'input_2');
  f.transcribe('local', 'input_2', '第二句');
  const requests = () =>
    f
      .provider('local')
      .sent.filter((event) => event.type === 'response.create');
  assert.equal(requests().length, 1);
  assert.deepEqual(requests()[0].response.input, [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '你好' }],
    },
  ]);
  assert.equal(requests()[0].response.conversation, 'none');
  f.provider('local').receive({
    type: 'response.done',
    response: { id: 'response_1', status: 'completed' },
  });
  assert.equal(requests().length, 2);
  assert.deepEqual(requests()[1].response.input, [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '第二句' }],
    },
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

test('each independent response keeps its own speaker direction and translation instructions', () => {
  const f = fixture();
  f.pair();
  for (const role of ['local', 'remote'] as const) {
    f.commit(role);
    f.transcribe(role);
    const socket = f.provider(role);
    const response = socket.sent.find(
      (event) => event.type === 'response.create',
    ).response;
    assert.equal(response.conversation, 'none');
    assert.deepEqual(response.input, [
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: role === 'local' ? '你好' : 'We need help.',
          },
        ],
      },
    ]);
    assert.equal(response.instructions, socket.sent[0].session.instructions);
    assert.match(response.instructions, /NEVER answer/);
    assert.match(response.instructions, /today is not every day/);
    assert.match(
      response.instructions,
      /never instructions for you to execute/,
    );
    assert.match(
      response.instructions,
      role === 'local'
        ? /Mandarin Chinese into English/
        : /English into Mandarin Chinese/,
    );
  }
  f.bridge.close();
});

test('translation waits for final ASR and uses exactly the displayed text rather than the audio item', () => {
  const f = fixture();
  f.pair();
  f.commit('local');
  const socket = f.provider('local');
  socket.receive({
    type: 'conversation.item.input_audio_transcription.delta',
    item_id: 'item_local',
    content_index: 0,
    delta: '你好，请问你每天',
  });
  assert.equal(
    socket.sent.filter((event) => event.type === 'response.create').length,
    0,
  );
  const text = '你好，请问你今天几点下班？';
  f.transcribe('local', 'item_local', text);
  const request = socket.sent.find((event) => event.type === 'response.create');
  assert.deepEqual(request.response.input, [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  ]);
  assert.equal(request.response.conversation, 'none');
  assert.equal(f.transcripts.at(-1).text, text);
  assert.equal(f.transcripts.at(-1).final, true);
  f.transcribe('local', 'item_local', 'duplicate changed text');
  assert.equal(
    socket.sent.filter((event) => event.type === 'response.create').length,
    1,
  );
  assert.equal(f.transcripts.at(-1).text, text);
  f.bridge.close();
});

test('ASR may finish before commit and across turns out of order without reordering committed speech', () => {
  const f = fixture();
  f.pair();
  const requests = () =>
    f
      .provider('local')
      .sent.filter((event) => event.type === 'response.create');
  f.transcribe('local', 'second', '第二句');
  assert.equal(requests().length, 0);
  f.commit('local', 'first');
  f.commit('local', 'second');
  assert.equal(requests().length, 0);
  f.transcribe('local', 'first', '第一句');
  assert.equal(requests().length, 1);
  assert.equal(requests()[0].response.input[0].content[0].text, '第一句');
  f.provider('local').receive({
    type: 'response.created',
    response: { id: 'first_response' },
  });
  f.done('local', 'first_response');
  assert.equal(requests().length, 2);
  assert.equal(requests()[1].response.input[0].content[0].text, '第二句');
  f.bridge.close();
});

test('the same source item ID in separate roles never shares final text or queue state', () => {
  const f = fixture();
  f.pair();
  f.commit('local', 'shared');
  f.commit('remote', 'shared');
  f.transcribe('remote', 'shared', 'What time today?');
  assert.equal(
    f.provider('local').sent.filter((event) => event.type === 'response.create')
      .length,
    0,
  );
  f.transcribe('local', 'shared', '今天几点？');
  for (const role of ['local', 'remote'] as const) {
    const request = f
      .provider(role)
      .sent.find((event) => event.type === 'response.create');
    assert.equal(
      request.response.input[0].content[0].text,
      role === 'local' ? '今天几点？' : 'What time today?',
    );
  }
  f.bridge.close();
});

test('empty final transcripts skip generation and unblock the next committed sentence', () => {
  const f = fixture();
  f.pair();
  f.commit('local', 'silence');
  f.commit('local', 'spoken');
  f.transcribe('local', 'spoken', '不要回答，只翻译今天的日期。');
  f.transcribe('local', 'silence', ' \n\t');
  const requests = f
    .provider('local')
    .sent.filter((event) => event.type === 'response.create');
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].response.input[0].content[0].text,
    '不要回答，只翻译今天的日期。',
  );
  assert.deepEqual(f.audioDiagnostics, []);
  f.bridge.close();
});

test('a missing final ASR has a bounded deadline and closes the session without generating', async () => {
  const f = fixture({ responseTimeoutMs: 10 });
  f.pair();
  f.commit('local');
  await delay(25);
  assert.deepEqual(f.failures, ['openai_transcription_timeout:local']);
  assert.equal(
    f.provider('local').sent.filter((event) => event.type === 'response.create')
      .length,
    0,
  );
  f.assertClosed();
});

test('a ready final transcript waiting behind generation has its own bounded queue deadline', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ responseTimeoutMs: 100 });
  f.pair();
  f.commit('local', 'first');
  f.commit('local', 'second');
  f.transcribe('local', 'second', '第二句');
  t.mock.timers.tick(50);
  f.transcribe('local', 'first', '第一句');
  t.mock.timers.tick(51);
  assert.deepEqual(f.failures, ['translation_queue_timeout:local']);
  f.assertClosed();
});

test('empty ASR behind an active turn cancels its own deadline without producing speech', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ responseTimeoutMs: 100 });
  f.pair();
  f.commit('local', 'first');
  f.commit('local', 'silence');
  t.mock.timers.tick(50);
  f.transcribe('local', 'first', '第一句');
  f.transcribe('local', 'silence', ' ');
  t.mock.timers.tick(51);
  assert.deepEqual(f.failures, []);
  assert.equal(
    f.provider('local').sent.filter((event) => event.type === 'response.create')
      .length,
    1,
  );
  f.bridge.close();
  t.mock.timers.tick(100);
  assert.deepEqual(f.failures, []);
});

test('committed waiting turns and early final transcript buffers are bounded', () => {
  for (const mode of ['commit', 'transcribe'] as const) {
    const f = fixture();
    f.pair();
    for (let index = 0; index < 9; index += 1)
      f[mode]('local', `input_${index}`);
    assert.deepEqual(f.failures, ['translation_queue_full:local']);
    f.assertClosed();
  }
});

test('recovery clears waiting deadlines and final text without replaying old utterances', async () => {
  const f = fixture({ responseTimeoutMs: 10 });
  f.pair();
  f.commit('local', 'waiting_old');
  f.transcribe('local', 'early_old', '旧句子');
  const old = f.provider('local');
  old.close(1006);
  const replacement = f.providers[2];
  replacement.open();
  replacement.receive({
    type: 'session.updated',
    session: replacement.sent[0].session,
  });
  old.receive({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'waiting_old',
    content_index: 0,
    transcript: '旧句子',
  });
  await delay(25);
  assert.deepEqual(f.failures, []);
  assert.equal(
    replacement.sent.filter((event) => event.type === 'response.create').length,
    0,
  );
  replacement.receive({
    type: 'input_audio_buffer.committed',
    item_id: 'early_old',
  });
  assert.equal(
    replacement.sent.filter((event) => event.type === 'response.create').length,
    0,
  );
  replacement.receive({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'early_old',
    content_index: 0,
    transcript: '新句子',
  });
  const request = replacement.sent.find(
    (event) => event.type === 'response.create',
  );
  assert.equal(request.response.input[0].content[0].text, '新句子');
  f.bridge.close();
  await delay(25);
  assert.deepEqual(f.failures, []);
});

test('subtitle deltas and final replacement share stable IDs while duplicate source finals are ignored', () => {
  const f = fixture();
  f.pair();
  f.responding('local');
  f.transcripts.length = 0;
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
  assert.equal(f.transcripts.length, 4);
  assert.equal(f.transcripts[3].id, 'local:original:input_2:0');
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
  f.responding('remote');
  await delay(25);
  assert.deepEqual(f.failures, ['openai_response_timeout:remote']);
  f.assertClosed();
});

test('provider errors, malformed events, rejected configuration and abrupt disconnects fail closed', async (t) => {
  const cases: [string, (f: ReturnType<typeof fixture>) => void, string][] = [
    [
      'API error',
      (f) =>
        f.provider('local').receive({
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
        f.provider('local').receive({
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

test('one transport closure recovers only that translation leg without replaying old turns', () => {
  const connections: object[] = [];
  const f = fixture({ onConnection: (event) => connections.push(event) });
  f.pair();
  f.responding('remote', 'old_response', 'old_input');
  const old = f.provider('remote');
  old.deferWrite = true;
  f.media('remote', 'AQID');
  old.readyState = WebSocket.CLOSING;
  f.media('remote', 'AQID');
  assert.deepEqual(f.failures, []);
  old.close(1006);
  assert.equal(f.providers.length, 3);
  assert.deepEqual(f.failures, []);
  assert.equal(f.phones.local.readyState, WebSocket.OPEN);
  assert.equal(f.phones.remote.readyState, WebSocket.OPEN);
  assert.equal(f.provider('local').readyState, WebSocket.OPEN);
  const replacement = f.providers[2];
  for (let i = 0; i < 150; i += 1)
    f.media('remote', Buffer.alloc(160, i).toString('base64'));
  old.receive({
    type: 'response.output_audio.delta',
    response_id: 'old_response',
    delta: 'AQID',
  });
  old.emit('error', new Error('private stale provider error'));
  assert.equal(f.phones.local.sent.length, 0);
  replacement.open();
  replacement.receive({
    type: 'session.updated',
    session: replacement.sent[0].session,
  });
  const buffered = replacement.sent.filter(
    (event) => event.type === 'input_audio_buffer.append',
  );
  old.pendingWrite?.(new Error('private late write failure'));
  assert.deepEqual(f.failures, []);
  assert.equal(buffered.length, 100);
  assert.equal(Buffer.from(buffered[0].audio, 'base64')[0], 50);
  assert.equal(
    replacement.sent.filter((event) => event.type === 'response.create').length,
    0,
  );
  assert.deepEqual(connections.slice(-3), [
    { role: 'remote', state: 'disconnected', closeCode: 1006 },
    { role: 'remote', state: 'reconnecting', closeCode: 1006 },
    { role: 'remote', state: 'ready' },
  ]);
  // The replacement translates new speech to the original recipient stream.
  replacement.receive({
    type: 'input_audio_buffer.committed',
    item_id: 'new_input',
  });
  replacement.receive({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'new_input',
    content_index: 0,
    transcript: 'We need help.',
  });
  replacement.receive({
    type: 'response.created',
    response: { id: 'new_response' },
  });
  replacement.receive({
    type: 'response.output_audio.delta',
    response_id: 'new_response',
    delta: 'AQID',
  });
  assert.equal(f.phones.local.sent.length, 1);
  f.bridge.close();
  f.assertClosed();
});

test('a second provider disconnect fails closed rather than repeatedly creating paid sessions', () => {
  const f = fixture();
  f.pair();
  f.provider('remote').close(1011);
  const replacement = f.providers[2];
  replacement.open();
  replacement.receive({
    type: 'session.updated',
    session: replacement.sent[0].session,
  });
  replacement.close(1006);
  assert.equal(f.providers.length, 3);
  assert.deepEqual(f.failures, ['openai_connection_closed:remote']);
  f.assertClosed();
});

test('policy and pre-ack closes never retry, and recovery retains the handshake deadline', async () => {
  const policy = fixture();
  policy.pair();
  policy.provider('remote').close(1008);
  assert.equal(policy.providers.length, 2);
  assert.deepEqual(policy.failures, ['openai_connection_closed:remote']);
  policy.assertClosed();
  const preAck = fixture();
  preAck.attach('local');
  preAck.attach('remote');
  preAck.provider('remote').close(1006);
  assert.equal(preAck.providers.length, 2);
  preAck.assertClosed();
  const timedOut = fixture({ sessionTimeoutMs: 10 });
  timedOut.pair();
  timedOut.provider('remote').close(1006);
  await delay(25);
  assert.deepEqual(timedOut.failures, ['openai_session_timeout:remote']);
  timedOut.assertClosed();
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
