import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import createHttpsProxyAgent from 'https-proxy-agent';
import WebSocket from 'ws';
import { checkRealtime } from '../src/solo/provider-checks';
import type { SoloConfig } from '../src/solo/config';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  sent: any[] = [];
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
  terminate() {
    this.close();
  }
  open() {
    this.readyState = WebSocket.OPEN;
    this.emit('open');
  }
}
const config = {
  OPENAI_API_KEY: 'secret-for-memory-test',
  OPENAI_REALTIME_MODEL: 'model-for-test',
} as SoloConfig;

test('provider verification requires actual session.updated, never submits audio or response.create', async () => {
  const socket = new FakeSocket();
  const result = checkRealtime(config, () => socket as unknown as WebSocket);
  socket.open();
  socket.emit('message', JSON.stringify({ type: 'session.created' }));
  assert.equal(socket.readyState, WebSocket.OPEN);
  assert.deepEqual(
    socket.sent.map((value) => value.type),
    ['session.update'],
  );
  socket.emit('message', JSON.stringify({ type: 'session.updated' }));
  assert.equal((await result).status, 'passed');
  assert.equal(socket.readyState, WebSocket.CLOSED);
});

test('provider verification uses the configured explicit proxy without losing acknowledgement checks', async () => {
  const socket = new FakeSocket();
  const result = checkRealtime(
    { ...config, OPENAI_PROXY_URL: 'http://127.0.0.1:8080' },
    (_url, options: WebSocket.ClientOptions) => {
      assert.ok(options.agent instanceof createHttpsProxyAgent.HttpsProxyAgent);
      assert.equal(options.handshakeTimeout, 15000);
      return socket as unknown as WebSocket;
    },
  );
  socket.open();
  assert.deepEqual(
    socket.sent.map((event) => event.type),
    ['session.update'],
  );
  socket.emit('message', JSON.stringify({ type: 'session.updated' }));
  assert.equal((await result).code, 'SESSION_UPDATED');
});

test('provider verification errors are redacted and a missing acknowledgement times out', async () => {
  const rejected = new FakeSocket();
  const rejection = checkRealtime(
    config,
    () => rejected as unknown as WebSocket,
  );
  rejected.open();
  rejected.emit(
    'message',
    JSON.stringify({
      type: 'error',
      error: { message: 'secret-for-memory-test' },
    }),
  );
  assert.equal((await rejection).code, 'SESSION_REJECTED');
  assert.ok(!JSON.stringify(await rejection).includes(config.OPENAI_API_KEY));
  const stalled = new FakeSocket();
  const timeout = checkRealtime(
    config,
    () => stalled as unknown as WebSocket,
    15,
  );
  assert.equal((await timeout).code, 'SESSION_TIMEOUT');
  assert.equal(stalled.readyState, WebSocket.CLOSED);
});
