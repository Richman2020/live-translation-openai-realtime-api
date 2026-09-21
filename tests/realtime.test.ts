import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import pino from 'pino';
import WebSocket from 'ws';
import AudioInterceptor from '../src/services/AudioInterceptor';
import StreamSocket from '../src/services/StreamSocket';
import type { Config } from '../src/config';

// Every transport is in memory. These tests never connect to Twilio or OpenAI.
class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;

  sent: Record<string, any>[] = [];

  open() {
    this.readyState = WebSocket.OPEN;
    this.emit('open');
  }

  send(data: string) {
    assert.equal(this.readyState, WebSocket.OPEN);
    this.sent.push(JSON.parse(data));
  }

  receive(data: object) {
    this.emit('message', Buffer.from(JSON.stringify(data)));
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
}

function fixture() {
  const logger = pino({ enabled: false });
  const sockets: FakeSocket[] = [];
  const connections: { url: string; options: object }[] = [];
  const config = {
    OPENAI_API_KEY: 'not-a-real-api-key',
    OPENAI_REALTIME_MODEL: 'gpt-realtime-1.5',
    FORWARD_AUDIO_BEFORE_TRANSLATION: 'false',
  } as Config;
  const interceptor = new AudioInterceptor({
    config,
    logger,
    callerLanguage: 'Mandarin',
    createWebSocket(url, options) {
      connections.push({ url, options });
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  const caller = new FakeSocket();
  const agent = new FakeSocket();
  caller.open();
  agent.open();
  interceptor.callerSocket = new StreamSocket({
    logger,
    socket: caller as unknown as WebSocket,
  });
  interceptor.agentSocket = new StreamSocket({
    logger,
    socket: agent as unknown as WebSocket,
  });
  caller.receive({ event: 'start', start: { streamSid: 'caller-stream' } });
  agent.receive({ event: 'start', start: { streamSid: 'agent-stream' } });
  interceptor.start();
  return { interceptor, sockets, connections, caller, agent };
}

test('both translation sessions use GA config and mu-law without the beta header', () => {
  const f = fixture();
  f.sockets.forEach((socket) => socket.open());
  f.connections.forEach(({ url, options }) => {
    assert.equal(new URL(url).searchParams.get('model'), 'gpt-realtime-1.5');
    assert.deepEqual(Object.keys((options as any).headers), ['Authorization']);
  });
  f.sockets.forEach((socket) => {
    const update = socket.sent[0];
    assert.equal(update.type, 'session.update');
    assert.equal(update.session.type, 'realtime');
    assert.deepEqual(update.session.output_modalities, ['audio']);
    assert.deepEqual(update.session.audio.input.format, { type: 'audio/pcmu' });
    assert.deepEqual(update.session.audio.output.format, {
      type: 'audio/pcmu',
    });
    assert.equal(update.session.audio.input.transcription.model, 'whisper-1');
    assert.equal(update.session.audio.input.turn_detection.type, 'server_vad');
    assert.match(update.session.instructions, /Mandarin/);
    assert.equal('temperature' in update.session, false);
    assert.equal('modalities' in update.session, false);
  });
  f.interceptor.close();
});

test('input waits for session.updated, then flushes only to the matching session', () => {
  const f = fixture();
  f.sockets.forEach((socket) => socket.open());
  const payload = Buffer.from([255, 254, 253]).toString('base64');
  f.caller.receive({ event: 'media', media: { payload } });
  assert.equal(f.sockets[0].sent.length, 1);
  f.sockets[1].receive({ type: 'session.updated' });
  assert.equal(f.sockets[0].sent.length, 1);
  f.sockets[0].receive({ type: 'session.updated' });
  assert.deepEqual(f.sockets[0].sent[1], {
    type: 'input_audio_buffer.append',
    audio: payload,
  });
  assert.equal(f.sockets[1].sent.length, 1);
  f.interceptor.close();
});

test('agent input preserves initial Flex beep suppression and uses its own session', (t) => {
  let now = 10000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture();
  f.sockets.forEach((socket) => {
    socket.open();
    socket.receive({ type: 'session.updated' });
  });
  const payload = Buffer.from('test-audio').toString('base64');
  f.agent.receive({ event: 'media', media: { payload } });
  assert.equal(f.sockets[1].sent.length, 1);
  now += 1001;
  f.agent.receive({ event: 'media', media: { payload } });
  assert.deepEqual(f.sockets[1].sent[1], {
    type: 'input_audio_buffer.append',
    audio: payload,
  });
  assert.equal(f.sockets[0].sent.length, 1);
  f.interceptor.close();
});

test('GA audio events reach the opposite phone leg, even without prior timing events', () => {
  const f = fixture();
  const english = Buffer.from('translated-english').toString('base64');
  const chinese = Buffer.from('translated-chinese').toString('base64');
  f.sockets[0].receive({ type: 'response.output_audio.delta', delta: english });
  f.sockets[1].receive({ type: 'response.output_audio.delta', delta: chinese });
  assert.deepEqual(f.agent.sent, [
    { event: 'media', streamSid: 'agent-stream', media: { payload: english } },
  ]);
  assert.deepEqual(f.caller.sent, [
    { event: 'media', streamSid: 'caller-stream', media: { payload: chinese } },
  ]);
  f.interceptor.close();
});

test('pending input is limited to two seconds of mu-law audio', () => {
  const f = fixture();
  f.sockets[0].open();
  const payload = Buffer.alloc(160, 255).toString('base64');
  for (let i = 0; i < 150; i += 1)
    f.caller.receive({ event: 'media', media: { payload } });
  f.sockets[0].receive({ type: 'session.updated' });
  const appended = f.sockets[0].sent.filter(
    (message) => message.type === 'input_audio_buffer.append',
  );
  assert.equal(appended.length, 100);
  f.interceptor.close();
});

test('empty calls, malformed events, and late audio after hangup do not crash', () => {
  const f = fixture();
  assert.doesNotThrow(() =>
    f.sockets[0].emit('message', Buffer.from('not json')),
  );
  assert.doesNotThrow(() => f.sockets[0].receive(null));
  f.agent.close();
  assert.doesNotThrow(() =>
    f.sockets[0].receive({
      type: 'response.output_audio.delta',
      delta: 'YQ==',
    }),
  );
  assert.equal(f.agent.sent.length, 0);
  assert.doesNotThrow(() => f.interceptor.close());
  assert.doesNotThrow(() =>
    f.sockets[0].receive({
      type: 'response.output_audio.delta',
      delta: 'YQ==',
    }),
  );
});
